const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const CACHE_PATH = './pending_pireps_cache.json';

// PIREP state meanings (your mapping)
const PIREP_STATE = {
  PENDING: 1,
  ACCEPTED: 2,
  DELETED: 4,
  REJECTED: 6,
};

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(obj) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.warn('⚠️ Could not write pending PIREP cache:', e?.message ?? e);
  }
}

function formatMinutesHHMM(totalMinutes) {
  const m = Math.max(0, parseInt(totalMinutes, 10) || 0);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  return `${String(h).padStart(2, '0')}:${mm}`;
}

function aircraftStatusLabel(code) {
  const c = String(code || '').toUpperCase();
  return (
    {
      A: 'Active',
      M: 'Maintenance',
      S: 'Stored',
      R: 'Retired',
      C: 'Scrapped',
    }[c] || 'Unknown'
  );
}

function pirepStateLabel(state) {
  const s = Number(state);
  return (
    {
      [PIREP_STATE.PENDING]: 'Pending',
      [PIREP_STATE.ACCEPTED]: 'Approved',
      [PIREP_STATE.REJECTED]: 'Rejected',
      [PIREP_STATE.DELETED]: 'Deleted',
    }[s] || `State ${s}`
  );
}

async function findTrainingThread(trainingChannel, threadName) {
  // 1) Active threads
  try {
    const active = await trainingChannel.threads.fetchActive();
    const found = active.threads.find(t => t.name === threadName);
    if (found) return found;
  } catch {
    // ignore
  }

  // 2) Archived PUBLIC threads
  try {
    const archivedPublic = await trainingChannel.threads.fetchArchived({
      limit: 100,
      type: 'public',
    });
    const found = archivedPublic.threads.find(t => t.name === threadName);
    if (found) return found;
  } catch {
    // ignore
  }

  // 3) Archived PRIVATE threads (this is the important one for your use case)
  try {
    const archivedPrivate = await trainingChannel.threads.fetchArchived({
      limit: 100,
      type: 'private',
    });
    const found = archivedPrivate.threads.find(t => t.name === threadName);
    if (found) return found;
  } catch {
    // ignore (missing perms, etc.)
  }

  return null;
}




function buildPendingEmbed(rec, pirepUrl, vatsimStatsUrl) {
  const pilotLine = `**C${rec.pilot_id}** — ${rec.pilot_name || 'Unknown Name'}`;
  const acLine =
    rec.registration
      ? `**${rec.registration}** (${rec.aircraft_icao || 'Unknown'}) — **${rec.aircraft_status || '?'}** (${aircraftStatusLabel(rec.aircraft_status)})`
      : `Aircraft ID: **${rec.aircraft_id || 'Unknown'}**`;

  const submittedTs = rec.submitted_ts ? Number(rec.submitted_ts) : Math.floor(Date.now() / 1000);

  const timeHHMM = formatMinutesHHMM(rec.flight_time);
  const distNm =
    rec.distance != null && !Number.isNaN(Number(rec.distance))
      ? `${Number(rec.distance).toFixed(0)} NM`
      : '—';

  return new EmbedBuilder()
    .setTitle('🕓 Pending PIREP (Approval Required)')
    .addFields(
      { name: 'Pilot', value: pilotLine, inline: false },
      { name: 'Aircraft', value: acLine, inline: false },
      { name: 'Dep / Arr', value: `**${rec.dpt_airport_id} → ${rec.arr_airport_id}**`, inline: true },
      { name: 'Time', value: `**${timeHHMM}**`, inline: true },
      { name: 'Distance', value: `**${distNm}**`, inline: true },
      { name: 'Source', value: `**${rec.source_name || 'Unknown'}**`, inline: true },
      { name: 'Submitted', value: `<t:${submittedTs}:F>  (<t:${submittedTs}:R>)`, inline: false },
      { name: 'Links', value: `• View PIREP: ${pirepUrl}\n• VATSIM Stats: ${vatsimStatsUrl ?? 'Not on file'}`, inline: false }

    )
    .setFooter({ text: `PIREP: ${rec.pirep_id}` });
}

function buildButtons(pirepId, pirepUrl) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pirep:approve:${pirepId}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`pirep:reject:${pirepId}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setLabel('View')
      .setStyle(ButtonStyle.Link)
      .setURL(pirepUrl)
  );
}

async function fetchPendingPireps(db) {
  const sql = `
    SELECT
      p.id AS pirep_id,
      p.user_id,
      p.aircraft_id,
      p.dpt_airport_id,
      p.arr_airport_id,
      p.flight_time,
      p.distance,
      p.source_name,
      UNIX_TIMESTAMP(p.submitted_at) AS submitted_ts,

      u.pilot_id,
      u.name AS pilot_name,

      dl.discord_id,

      ufv.value AS vatsim_cid,

      a.registration,
      a.icao AS aircraft_icao,
      a.status AS aircraft_status

    FROM pireps p
    JOIN users u
      ON u.id = p.user_id

    LEFT JOIN aircraft a
      ON a.id = p.aircraft_id

    LEFT JOIN discord_links dl
      ON dl.pilot_id = u.pilot_id

    LEFT JOIN user_field_values ufv
      ON ufv.user_id = u.id
     AND ufv.user_field_id = 1

    WHERE p.state = ?
    ORDER BY p.submitted_at DESC
    LIMIT 50
  `;

  const [rows] = await db.query(sql, [PIREP_STATE.PENDING]);
  return rows || [];
}


async function reconcileCache({ client, db, cache }) {
  // For anything we previously posted, if state is no longer pending, mark it resolved & remove buttons
  const ids = Object.keys(cache);
  if (!ids.length) return;

  for (const pirepId of ids) {
    const entry = cache[pirepId];
    if (!entry?.channelId || !entry?.messageId) {
      delete cache[pirepId];
      continue;
    }

    try {
      const [rows] = await db.query('SELECT state FROM pireps WHERE id = ? LIMIT 1', [pirepId]);
      if (!rows.length) {
        // PIREP missing; drop cache
        delete cache[pirepId];
        continue;
      }

      const state = Number(rows[0].state);
      if (state === PIREP_STATE.PENDING) continue;

      // Fetch message and edit to resolved
      const ch = await client.channels.fetch(entry.channelId);
      const msg = await ch.messages.fetch(entry.messageId);

      const resolvedEmbed = EmbedBuilder.from(msg.embeds?.[0] ?? new EmbedBuilder())
        .setTitle(`✅ PIREP Resolved — ${pirepStateLabel(state)}`)
        .setColor(state === PIREP_STATE.ACCEPTED ? 0x2ecc71 : 0xe74c3c);

      await msg.edit({ embeds: [resolvedEmbed], components: [] });
      delete cache[pirepId];

    } catch (e) {
      // If we can’t edit it (missing perms, deleted thread, etc.), stop retrying forever
      console.warn(`⚠️ Could not reconcile posted PIREP ${pirepId}:`, e?.message ?? e);
      delete cache[pirepId];
    }
  }
}

async function tickWatcher(opts) {
  const {
    client,
    db,
    guildId,
    trainingChannelId,
    pirepBaseUrl,
    vatsimStatsBaseUrl,
    fallbackChannelId,
  } = opts;

  const cache = loadCache();

  // First reconcile anything already posted that’s no longer pending
  await reconcileCache({ client, db, cache });

  const pending = await fetchPendingPireps(db);

  // Resolve guild + training channel
  const guild =
    (guildId && (await client.guilds.fetch(guildId).catch(() => null))) ||
    client.guilds.cache.first();

  if (!guild) {
    saveCache(cache);
    return;
  }

  const trainingChannel = await guild.channels.fetch(trainingChannelId).catch(() => null);

  for (const rec of pending) {
    const pirepId = String(rec.pirep_id);

    // already posted
    if (cache[pirepId]) continue;

    const pilotId = rec.pilot_id;
    const threadName = `Training Case for C${pilotId}`;

    const pirepUrl = `${pirepBaseUrl.replace(/\/$/, '')}/${pirepId}`;

    const cidRaw = (rec.vatsim_cid || '').trim();
    const cidForStats = /^\d{6,8}$/.test(cidRaw) ? cidRaw : null;

    const vatsimStatsUrl = cidForStats
      ? `${vatsimStatsBaseUrl.replace(/\/$/, '')}/${cidForStats}`
      : null;

    const embed = buildPendingEmbed(rec, pirepUrl, vatsimStatsUrl);
    const row = buildButtons(pirepId, pirepUrl);

    let posted = false;

    // Prefer trainee’s training thread
    if (trainingChannel && trainingChannel.threads) {
      const thread = await findTrainingThread(trainingChannel, threadName);

      if (thread) {
        // Unarchive if needed
        if (thread.archived) {
          try {
            await thread.setArchived(false, 'Posting pending PIREP for review');
          } catch (e) {
            console.warn(`⚠️ Could not unarchive thread "${thread.name}":`, e?.message ?? e);
          }
        }

        // If it's locked, you can't send
        if (!thread.locked) {
          try {
            const msg = await thread.send({
              content: `IPs: trainee filed a PIREP that needs review.`,
              embeds: [embed],
              components: [row],
            });

            cache[pirepId] = { channelId: thread.id, messageId: msg.id };
            posted = true;
          } catch (e) {
            console.warn(`⚠️ Could not post to thread "${thread.name}":`, e?.message ?? e);
          }
        } else {
          console.warn(`⚠️ Thread is locked, cannot post: "${thread.name}"`);
        }
      }
    }

    // Fallback channel if no thread found (or couldn't post)
    if (!posted && fallbackChannelId) {
      const fallback = await guild.channels.fetch(fallbackChannelId).catch(() => null);
      if (fallback && fallback.isTextBased()) {
        const msg = await fallback.send({ embeds: [embed], components: [row] });
        cache[pirepId] = { channelId: fallback.id, messageId: msg.id };
      }
    }
  }

  // ✅ Save once per tick, not once per PIREP
  saveCache(cache);
}


function startPendingPirepWatcher(opts) {
  const pollSeconds = Math.max(30, Number(opts.pollSeconds || 60));

  // Run once immediately, then interval
  tickWatcher(opts).catch(e => console.warn('⚠️ Pending PIREP watcher tick failed:', e?.message ?? e));

  setInterval(() => {
    tickWatcher(opts).catch(e => console.warn('⚠️ Pending PIREP watcher tick failed:', e?.message ?? e));
  }, pollSeconds * 1000);
}

async function handlePirepButton(ctx) {
  const { interaction, db, hasRole, roles } = ctx;

  const allowed =
    hasRole(roles.INSTRUCTOR_PILOT_ROLE_ID) || hasRole(roles.COMMAND_STAFF_ROLE_ID);

  if (!allowed) {
    return interaction.reply({
      content: '❌ You do not have permission to review PIREPs.',
      ephemeral: true,
    });
  }

  const parts = String(interaction.customId || '').split(':');
  // pirep:approve:<id> OR pirep:reject:<id>
  const action = parts[1];
  const pirepId = parts[2];

  if (!pirepId || !['approve', 'reject'].includes(action)) {
    return interaction.reply({ content: '❌ Invalid PIREP action.', ephemeral: true });
  }

  const newState = action === 'approve' ? PIREP_STATE.ACCEPTED : PIREP_STATE.REJECTED;

  try {
    // Only change if still pending (prevents double-approves)
    const [res] = await db.query(
      'UPDATE pireps SET state = ?, updated_at = NOW() WHERE id = ? AND state = ?',
      [newState, pirepId, PIREP_STATE.PENDING]
    );

    const changed = res?.affectedRows > 0;

    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds?.[0] ?? new EmbedBuilder())
      .setTitle(action === 'approve' ? '✅ Approved' : '⛔ Denied')
      .setColor(action === 'approve' ? 0x2ecc71 : 0xe74c3c)
      .setFooter({ text: `PIREP: ${pirepId} • Reviewed by ${interaction.user.tag}` });

    // Update the message + remove buttons
    await interaction.update({
      embeds: [updatedEmbed],
      components: [],
    });

    // Remove from cache if present
    const cache = loadCache();
    if (cache[String(pirepId)]) {
      delete cache[String(pirepId)];
      saveCache(cache);
    }

    // Optional extra acknowledgement if DB already changed
    if (!changed) {
      // (We already updated the message; this is just info for the reviewer)
      try {
        await interaction.followUp({
          content: 'ℹ️ That PIREP was already resolved (not pending) in the database.',
          ephemeral: true,
        });
      } catch {}
    }
  } catch (e) {
    console.error('❌ Error handling PIREP button:', e);
    return interaction.reply({
      content: '❌ Failed to update PIREP state in the database.',
      ephemeral: true,
    });
  }
}

module.exports = {
  startPendingPirepWatcher,
  handlePirepButton,
};
