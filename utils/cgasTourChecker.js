const crypto = require('crypto');
const { EmbedBuilder } = require('discord.js');
const { completionFromVisits } = require('./cgas');
const { ACCEPTED_PIREP_STATE } = require('./pilotStats');

const BATCH_SIZE = 250;
const LOCK_NAME = 'vuscg:cgas-tour-checker';
const MAX_ATTEMPTS = 6;

const tokenFor = (version, userId) => crypto.createHash('sha256').update(`${version}:${userId}`).digest('hex');
const sqlDate = value => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
const waitMinutes = attempts => Math.min(60, 2 ** Math.max(0, attempts));

async function fetchPilotVisits(db, userIds, codes) {
  if (!userIds.length || !codes.length) return [];
  const userSlots = userIds.map(() => '?').join(',');
  const codeSlots = codes.map(() => '?').join(',');
  const [rows] = await db.query(`
    SELECT p.user_id, p.arr_airport_id AS code, COUNT(*) AS arrivals,
           MIN(p.submitted_at) AS first_visit, MAX(p.submitted_at) AS last_visit,
           SUBSTRING_INDEX(GROUP_CONCAT(p.id ORDER BY p.submitted_at, p.id SEPARATOR ','), ',', 1) AS first_pirep_id
      FROM pireps p
     WHERE p.user_id IN (${userSlots}) AND p.state = ? AND p.deleted_at IS NULL
       AND p.arr_airport_id IN (${codeSlots})
     GROUP BY p.user_id, p.arr_airport_id`, [...userIds, ACCEPTED_PIREP_STATE, ...codes]);
  return rows;
}

async function scanEligiblePilots(db, tour, onCompletion) {
  const codes = [...new Set(tour.stations.flatMap(s => s.airportCodes))];
  let after = 0;
  while (true) {
    const [pilots] = await db.query(
      'SELECT id, pilot_id, name FROM users WHERE state = 1 AND id > ? ORDER BY id LIMIT ?',
      [after, BATCH_SIZE]
    );
    if (!pilots.length) break;
    const visits = await fetchPilotVisits(db, pilots.map(p => p.id), codes);
    const byUser = new Map();
    for (const row of visits) (byUser.get(String(row.user_id)) || byUser.set(String(row.user_id), []).get(String(row.user_id))).push(row);
    for (const pilot of pilots) {
      const completion = completionFromVisits(tour, byUser.get(String(pilot.id)) || []);
      if (completion.complete) await onCompletion(pilot, completion);
    }
    after = pilots[pilots.length - 1].id;
    if (pilots.length < BATCH_SIZE) break;
  }
}

async function ensureVersion(db, tour) {
  const [rows] = await db.query('SELECT requirement_hash, baseline_status FROM bot_cgas_tour_versions WHERE version = ? FOR UPDATE', [tour.version]);
  if (rows.length && rows[0].requirement_hash !== tour.requirementHash) {
    throw new Error(`CGAS tour ${tour.version} requirements changed without a version change. Restore the saved roster or increment config/cgasStations.js version.`);
  }
  return rows[0] || null;
}

async function baseline(db, tour, roleEnabled) {
  await db.beginTransaction();
  try {
    const existing = await ensureVersion(db, tour);
    if (existing?.baseline_status === 'complete') { await db.commit(); return false; }
    if (!existing) {
      const [orphaned] = await db.query('SELECT COUNT(*) AS total FROM bot_cgas_completions WHERE tour_version = ?', [tour.version]);
      if (Number(orphaned[0]?.total || 0) > 0) throw new Error(`CGAS tour ${tour.version} has completion rows but no version record; restore the missing durable version record before scanning.`);
      await db.query(`INSERT INTO bot_cgas_tour_versions
        (version, requirement_hash, roster_json, baseline_status) VALUES (?, ?, ?, 'initializing')`,
        [tour.version, tour.requirementHash, JSON.stringify(tour.requirements)]);
    }
    await scanEligiblePilots(db, tour, async (pilot, completion) => {
      await insertCompletion(db, tour, pilot, completion, true, roleEnabled);
    });
    await db.query(`UPDATE bot_cgas_tour_versions SET baseline_status = 'complete', baseline_completed_at = UTC_TIMESTAMP()
      WHERE version = ?`, [tour.version]);
    await db.commit();
    return true;
  } catch (error) { await db.rollback(); throw error; }
}

async function insertCompletion(db, tour, pilot, completion, baselined, roleEnabled) {
  const token = tokenFor(tour.version, pilot.id);
  const status = baselined ? 'none' : 'pending';
  const roleStatus = !roleEnabled || baselined ? 'disabled' : 'pending';
  const [result] = await db.query(`INSERT IGNORE INTO bot_cgas_completions
    (user_id, tour_version, completed_at, final_station_id, final_station_name, final_pirep_id,
     baselined, announcement_status, announcement_token, role_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [pilot.id, tour.version, sqlDate(completion.completedAt),
    completion.finalStation.id, completion.finalStation.name, completion.finalPirepId, baselined ? 1 : 0,
    status, token, roleStatus]);
  return result.affectedRows === 1;
}

async function detectNew(db, tour, roleEnabled) {
  const version = await ensureVersion(db, tour);
  if (!version || version.baseline_status !== 'complete') throw new Error(`CGAS tour ${tour.version} baseline is not complete`);
  let added = 0;
  await scanEligiblePilots(db, tour, async (pilot, completion) => {
    if (await insertCompletion(db, tour, pilot, completion, false, roleEnabled)) added++;
  });
  return added;
}

// Deliberately converts the silent baseline into durable announcement jobs once.
// The version row is locked and the marker is committed with the jobs, so a
// failed or concurrent invocation cannot partially queue (or queue twice).
async function queueHistoricalAnnouncements(db, tour) {
  await db.beginTransaction();
  try {
    const [rows] = await db.query(`SELECT requirement_hash, baseline_status,
      historical_announcement_queued_at FROM bot_cgas_tour_versions WHERE version = ? FOR UPDATE`, [tour.version]);
    const version = rows[0];
    if (!version) throw new Error(`CGAS tour ${tour.version} has not been baselined yet.`);
    if (version.requirement_hash !== tour.requirementHash) {
      throw new Error(`CGAS tour ${tour.version} requirements do not match the saved roster.`);
    }
    if (version.baseline_status !== 'complete') throw new Error(`CGAS tour ${tour.version} baseline is not complete.`);
    if (version.historical_announcement_queued_at) {
      await db.rollback();
      return { alreadyQueued: true, queued: 0 };
    }
    const [result] = await db.query(`UPDATE bot_cgas_completions
      SET announcement_status='pending', announcement_next_attempt_at=NULL, announcement_last_error=NULL
      WHERE tour_version=? AND baselined=1 AND announcement_status='none'`, [tour.version]);
    const queued = Number(result.affectedRows || 0);
    await db.query(`UPDATE bot_cgas_tour_versions
      SET historical_announcement_queued_at=UTC_TIMESTAMP(), historical_announcement_count=?
      WHERE version=?`, [queued, tour.version]);
    await db.commit();
    return { alreadyQueued: false, queued };
  } catch (error) {
    await db.rollback();
    throw error;
  }
}

async function resolveRecipient(db, client, guildId, userId) {
  const [[pilot], [links]] = await Promise.all([
    db.query('SELECT pilot_id, name FROM users WHERE id = ? LIMIT 1', [userId]),
    db.query(`SELECT dl.discord_id FROM discord_links dl JOIN users u ON u.pilot_id = dl.pilot_id
      WHERE u.id = ? LIMIT 1`, [userId]),
  ]);
  const user = pilot[0];
  const discordId = links[0]?.discord_id ? String(links[0].discord_id) : null;
  let member = null;
  if (discordId && guildId) {
    try { member = await (await client.guilds.fetch(guildId)).members.fetch(discordId); } catch { /* display fallback */ }
  }
  return { user, discordId, member };
}

function completionEmbed(job, recipient, stationCount) {
  const safeName = String(recipient.user?.name || 'Pilot').replace(/[@`*_~|>]/g, '').slice(0, 80);
  const identity = recipient.member ? `<@${recipient.discordId}>` : `**${safeName} (C${recipient.user?.pilot_id ?? 'unknown'})**`;
  const timestamp = Math.floor(new Date(job.completed_at).getTime() / 1000);
  return new EmbedBuilder().setColor(0xf1c40f).setTitle('🏆 CGAS Tour Complete!')
    .setDescription(`Congratulations to ${identity} for visiting every station on the vUSCG CGAS Tour!`)
    .addFields(
      { name: '📍 Final stop', value: String(job.final_station_name).slice(0, 1024), inline: true },
      { name: '🚁 Stations visited', value: `${stationCount}/${stationCount}`, inline: true },
      { name: '📅 Completed', value: `<t:${timestamp}:d>`, inline: true },
    ).setFooter({ text: `Think you're getting close? Check your progress with /mycgas! · CGAS-${job.announcement_token}` });
}

async function reconcileSending(db, channel) {
  const [jobs] = await db.query(`SELECT id, announcement_token FROM bot_cgas_completions
    WHERE announcement_status = 'sending' LIMIT 25`);
  if (!jobs.length) return;
  let messages;
  try { messages = await channel.messages.fetch({ limit: 100 }); }
  catch (error) {
    await db.query(`UPDATE bot_cgas_completions SET announcement_status = 'uncertain', announcement_last_error = ?
      WHERE announcement_status = 'sending'`, [`Could not reconcile Discord history: ${error.message}`]);
    return;
  }
  for (const job of jobs) {
    const found = messages.find(m => m.embeds?.some(e => e.footer?.text?.includes(`CGAS-${job.announcement_token}`)));
    if (found) await db.query(`UPDATE bot_cgas_completions SET announcement_status='sent', announcement_message_id=?,
      announcement_channel_id=?, announcement_last_error=NULL WHERE id=? AND announcement_status='sending'`,
      [found.id, found.channelId, job.id]);
    else await db.query(`UPDATE bot_cgas_completions SET announcement_status='uncertain', announcement_last_error=?
      WHERE id=? AND announcement_status='sending'`, ['A prior send may have succeeded but was not found in the latest 100 channel messages; manual reconciliation required.', job.id]);
  }
}

async function deliverAnnouncements(db, client, settings, stationCount) {
  if (!settings.channelId) { console.error('CGAS_TOUR_CHANNEL_ID is not configured; announcements remain pending.'); return; }
  let channel;
  try { channel = await client.channels.fetch(settings.channelId); }
  catch (error) { console.error(`Cannot access CGAS tour channel ${settings.channelId}; announcements remain pending:`, error); return; }
  if (!channel?.isTextBased()) { console.error(`CGAS tour channel ${settings.channelId} is not text based; announcements remain pending.`); return; }
  await reconcileSending(db, channel);
  const [jobs] = await db.query(`SELECT * FROM bot_cgas_completions WHERE announcement_status='pending'
    AND announcement_attempts < ? AND (announcement_next_attempt_at IS NULL OR announcement_next_attempt_at <= UTC_TIMESTAMP())
    ORDER BY id LIMIT 10`, [MAX_ATTEMPTS]);
  for (const job of jobs) {
    // Resolve all database-backed content before claiming/sending. A database failure
    // therefore leaves the durable job pending rather than falsely ambiguous.
    const recipient = await resolveRecipient(db, client, settings.guildId, job.user_id);
    const [claim] = await db.query(`UPDATE bot_cgas_completions SET announcement_status='sending', announcement_attempts=announcement_attempts+1
      WHERE id=? AND announcement_status='pending'`, [job.id]);
    if (claim.affectedRows !== 1) continue;
    try {
      const sent = await channel.send({ embeds: [completionEmbed(job, recipient, stationCount)],
        allowedMentions: { parse: [], users: recipient.member ? [recipient.discordId] : [] } });
      await db.query(`UPDATE bot_cgas_completions SET announcement_status='sent', announcement_channel_id=?,
        announcement_message_id=?, announcement_last_error=NULL WHERE id=? AND announcement_status='sending'`,
      [sent.channelId, sent.id, job.id]);
    } catch (error) {
      const definite = Boolean(error.status || error.code === 50013 || error.code === 10003);
      if (definite) await db.query(`UPDATE bot_cgas_completions SET announcement_status='pending', announcement_last_error=?,
        announcement_next_attempt_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE) WHERE id=? AND announcement_status='sending'`,
      [String(error.message).slice(0, 2000), waitMinutes(job.announcement_attempts), job.id]);
      else await db.query(`UPDATE bot_cgas_completions SET announcement_status='uncertain', announcement_last_error=?
        WHERE id=? AND announcement_status='sending'`, [`Ambiguous Discord send: ${String(error.message).slice(0, 1900)}`, job.id]);
    }
  }
}

async function awardRoles(db, client, settings) {
  if (!settings.roleId || !settings.guildId) return;
  const [jobs] = await db.query(`SELECT * FROM bot_cgas_completions WHERE role_status IN ('pending','failed')
    AND role_attempts < ? AND (role_next_attempt_at IS NULL OR role_next_attempt_at <= UTC_TIMESTAMP()) ORDER BY id LIMIT 10`, [MAX_ATTEMPTS]);
  for (const job of jobs) {
    const recipient = await resolveRecipient(db, client, settings.guildId, job.user_id);
    if (!recipient.member) { await db.query(`UPDATE bot_cgas_completions SET role_status='not_linked', role_last_error=? WHERE id=?`, ['No linked guild member', job.id]); continue; }
    try {
      await recipient.member.roles.add(settings.roleId, `CGAS tour ${job.tour_version} completion`);
      await db.query(`UPDATE bot_cgas_completions SET role_status='awarded', role_attempts=role_attempts+1, role_last_error=NULL WHERE id=?`, [job.id]);
    } catch (error) {
      await db.query(`UPDATE bot_cgas_completions SET role_status='failed', role_attempts=role_attempts+1, role_last_error=?,
        role_next_attempt_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE) WHERE id=?`,
      [String(error.message).slice(0, 2000), waitMinutes(job.role_attempts), job.id]);
    }
  }
}

async function runChecker({ db: pool, client, tour, settings }) {
  if (!tour.valid) throw new Error(`Invalid CGAS tour configuration: ${tour.errors.join('; ')}`);
  const db = pool.getConnection ? await pool.getConnection() : pool;
  let locked = false;
  try {
    const [lockRows] = await db.query('SELECT GET_LOCK(?, 0) AS acquired', [LOCK_NAME]);
    locked = Number(lockRows[0]?.acquired) === 1;
    if (!locked) return { skipped: 'overlap' };
    const wasBaseline = await baseline(db, tour, Boolean(settings.roleId));
    if (!wasBaseline) await detectNew(db, tour, Boolean(settings.roleId));
    await deliverAnnouncements(db, client, settings, tour.stations.length);
    await awardRoles(db, client, settings);
    return { baselined: wasBaseline };
  } finally {
    if (locked) try { await db.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]); } catch {}
    if (db !== pool) db.release();
  }
}

function startCgasTourChecker(options) {
  const seconds = Math.max(60, Number(options.settings.intervalSeconds) || 300);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runChecker(options); } catch (error) { console.error('CGAS tour checker failed:', error); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(tick, seconds * 1000);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}

module.exports = {
  BATCH_SIZE,
  tokenFor,
  fetchPilotVisits,
  scanEligiblePilots,
  ensureVersion,
  insertCompletion,
  baseline,
  detectNew,
  queueHistoricalAnnouncements,
  completionEmbed,
  reconcileSending,
  deliverAnnouncements,
  awardRoles,
  runChecker,
  startCgasTourChecker,
};
