const { PermissionFlagsBits } = require('discord.js');
const { createHash } = require('node:crypto');
const { formatRankNickname } = require('../../rankSync');
const { first, transaction, linkedDiscordForPilot } = require('./service');
const { findTrainingThread } = require('./threads');

const lease = 'vuscg:mr:graduation';

function roleConfig(env = process.env) {
  const roles = {
    pilot: env.TRAINING_GRADUATION_PILOT_ROLE_ID, cadet: env.TRAINING_GRADUATION_CADET_ROLE_ID,
    rw: env.TRAINING_GRADUATION_RW_ROLE_ID, fw: env.TRAINING_GRADUATION_FW_ROLE_ID,
    o2: env.TRAINING_GRADUATION_O2_ROLE_ID,
  };
  const ids = Object.values(roles);
  if (!ids.every(id => /^\d{17,20}$/.test(id ?? '')) || new Set(ids).size !== ids.length) {
    throw new Error('graduation_role_config_invalid');
  }
  return roles;
}

async function currentPilot(db, event) {
  return first(db, `SELECT u.rank_id, u.pilot_id, u.name
    FROM users u JOIN vuscg_training_qualification_status s ON s.user_id = u.id
    WHERE u.id = ? AND u.pilot_id = ? AND s.qualification_id = 'mr'
      AND s.program_id = ? AND s.active AND s.last_event_id = ?`,
  [event.user_id, event.public_pilot_id, event.program_id, event.event_id]);
}

async function promoteRank(db, event, rankName) {
  return transaction(db, async connection => {
    const rank = await first(connection, 'SELECT name FROM ranks WHERE id = ?', [13]);
    if (!rankName || rank?.name !== rankName) throw new Error('graduation_rank_config_invalid');
    const [result] = await connection.execute(`UPDATE users u JOIN vuscg_training_qualification_status s ON s.user_id = u.id
      SET u.rank_id = 13 WHERE u.id = ? AND u.pilot_id = ? AND u.rank_id = 12 AND s.qualification_id = 'mr'
        AND s.program_id = ? AND s.active AND s.last_event_id = ?
        AND (SELECT IF(COUNT(*) = 1, MIN(discord_id), NULL) FROM discord_links WHERE pilot_id = u.pilot_id) = ?`,
    [event.user_id, event.public_pilot_id, event.program_id, event.event_id, event.graduate_discord_id]);
    if (result.affectedRows === 1) await checkpoint(connection, event.event_id, 'rank_advanced_to_13');
    return result.affectedRows === 1;
  });
}

async function updateDiscord(member, pilot, program, roles) {
  if (!['rw', 'fw'].includes(program) || Number(pilot.rank_id) < 13) throw new Error('graduation_track_or_rank_invalid');
  for (const role of [roles.pilot, roles[program], ...(Number(pilot.rank_id) === 13 ? [roles.o2] : [])]) {
    if (!member.roles.cache.has(role)) await member.roles.add(role, 'Audited Mission Rated graduation');
  }
  if (member.roles.cache.has(roles.cadet)) await member.roles.remove(roles.cadet, 'Audited Mission Rated graduation');
  const name = formatRankNickname(pilot);
  if (member.nickname !== name) await member.setNickname(name, 'Sync phpVMS rank and pilot name');
}

async function audit(db, id, result, retry = false) {
  await transaction(db, async connection => {
    await connection.execute(`UPDATE vuscg_training_qualification_sync SET state = ?, attempts = attempts + 1,
      next_attempt_at = CASE WHEN ? THEN DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE) ELSE UTC_TIMESTAMP() END
      WHERE event_id = ? AND target = 'graduation'`, [retry ? 'retry' : 'complete', retry, id]);
    await connection.execute(`INSERT INTO vuscg_training_qualification_sync_attempts (event_id, target, result, created_at)
      VALUES (?, 'graduation', ?, UTC_TIMESTAMP(6))`, [id, result]);
  });
}

async function checkpoint(db, id, result) {
  await db.execute(`INSERT INTO vuscg_training_qualification_sync_attempts (event_id, target, result, created_at)
    VALUES (?, 'graduation', ?, UTC_TIMESTAMP(6))`, [id, result]);
}

async function announce(db, guild, job, pilot) {
  if (job.announcement_state === 'sent') return 'graduated';
  if (job.announcement_state === 'sending') return 'graduated_announcement_uncertain';
  const parent = await guild.channels.fetch(process.env.TRAINING_CHANNEL_ID || '1174748570948223026');
  const thread = await findTrainingThread(parent, { pilotId: pilot.pilot_id, discordId: job.graduate_discord_id });
  if (!thread) throw new Error('graduation_thread_unavailable');
  if (thread.archived) await thread.setArchived(false, 'Post audited MR graduation');
  await db.execute(`UPDATE vuscg_training_qualification_sync SET announcement_state = 'sending'
    WHERE event_id = ? AND target = 'graduation'`, [job.event_id]);
  const nonce = createHash('sha256').update('graduation:' + job.event_id).digest('hex').slice(0, 25);
  await thread.send({
    content: `**Mission Rated graduation · C${pilot.pilot_id}**\n${job.program_id === 'rw' ? 'Rotary Wing' : 'Fixed Wing'} · Rank and Discord designations synchronized.`,
    nonce, enforceNonce: true, allowedMentions: { parse: [] },
  });
  await db.execute(`UPDATE vuscg_training_qualification_sync SET announcement_state = 'sent'
    WHERE event_id = ? AND target = 'graduation'`, [job.event_id]);
  return 'graduated';
}

async function graduate(db, client, guildId, job) {
  if (job.action !== 'grant' || job.qualification_id !== 'mr' || !['rw', 'fw'].includes(job.program_id) ||
      !['command_staff', 'instructor_pilot'].includes(job.reviewer_role)) throw new Error('invalid_graduation_event');
  let pilot = await currentPilot(db, job);
  if (!pilot) return 'superseded';
  const [prerequisites] = await db.execute(`SELECT target FROM vuscg_training_qualification_sync s
    WHERE event_id = ? AND target IN ('award', 'type_rating') AND state = 'complete'
      AND EXISTS (SELECT 1 FROM vuscg_training_qualification_sync_attempts a
        WHERE a.event_id = s.event_id AND a.target = s.target
          AND (a.result IN ('inserted', 'already_managed', 'preserved_existing') OR a.result LIKE '%:trainee_removed:%'))`, [job.event_id]);
  if (prerequisites.length !== 2) throw new Error('awaiting_native_graduation_dependencies');

  const roles = roleConfig();
  const guild = await client.guilds.fetch(guildId);
  const guildRoles = await guild.roles.fetch();
  const privileged = [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles];
  const staffRoles = [process.env.COMMAND_STAFF_ROLE_ID, process.env.INSTRUCTOR_PILOT_ROLE_ID];
  if (!Object.values(roles).every(id => {
    const role = guildRoles.get(id);
    return role?.editable && !staffRoles.includes(id) && !privileged.some(permission => role.permissions.has(permission));
  })) throw new Error('unverified_discord_graduation_roles');
  const target = await linkedDiscordForPilot(db, job.public_pilot_id);
  if (!target || target !== job.graduate_discord_id) throw new Error('graduation_discord_mapping_changed');
  const member = await guild.members.fetch({ user: target, force: true });
  if (!member.manageable) throw new Error('graduation_member_unmanageable');
  await promoteRank(db, job, process.env.TRAINING_GRADUATION_RANK_NAME);
  pilot = await currentPilot(db, job);
  if (!pilot) return 'superseded_after_rank_step';
  if (await linkedDiscordForPilot(db, job.public_pilot_id) !== target) throw new Error('graduation_discord_mapping_changed');
  await updateDiscord(member, pilot, job.program_id, roles);
  await checkpoint(db, job.event_id, 'discord_designations_confirmed');
  return announce(db, guild, job, pilot);
}

async function runGraduations(client, db, guildId) {
  const connection = await db.getConnection();
  try {
    const result = await first(connection, 'SELECT GET_LOCK(?, 0) AS acquired', [lease]);
    if (!result.acquired) return;
    try {
      const [jobs] = await db.execute(`SELECT e.*, s.announcement_state FROM vuscg_training_qualification_sync s
        JOIN vuscg_training_qualification_events e USING (event_id)
        WHERE s.target = 'graduation' AND s.state IN ('pending','retry') AND s.next_attempt_at <= UTC_TIMESTAMP()
        ORDER BY s.next_attempt_at, s.event_id LIMIT 10`);
      for (const job of jobs) {
        try {
          await audit(db, job.event_id, await graduate(db, client, guildId, job));
        } catch (error) {
          const expected = /^(graduation_|awaiting_native_|invalid_graduation_|unverified_discord_)[a-z0-9_]+$/;
          await audit(db, job.event_id, expected.test(error.message) ? error.message : 'graduation_database_or_discord_error', true);
        }
      }
    } finally {
      await connection.execute('SELECT RELEASE_LOCK(?)', [lease]);
    }
  } finally {
    connection.release();
  }
}

function startGraduationWorker(client, db, guildId) {
  if (process.env.TRAINING_GRADUATION_ENABLED !== 'true' || !guildId || guildId !== process.env.GUILD_ID) return;
  const tick = () => runGraduations(client, db, guildId)
    .catch(error => console.warn('MR graduation sync could not run:', error.code || error.name));
  void tick();
  setInterval(tick, 60_000);
}

module.exports = { startGraduationWorker, promoteRank, updateDiscord, runGraduations };
