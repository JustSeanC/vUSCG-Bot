const fs = require('fs');
const { createHash } = require('node:crypto');
const { createPirepBridge, validPirepId } = require('./pirepBridge');
const { PIREP_STATE, reportUrl, readReport, reportState } = require('./pirepEvidence');
const { postToTrainingThread } = require('./training/threads');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const CACHE_PATH = './pending_pireps_cache.json';

function loadCache() {
  try {
    return Object.assign(Object.create(null), JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')));
  } catch {
    return Object.create(null);
  }
}

function saveCache(obj) {
  try {
    fs.writeFileSync(CACHE_PATH + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(CACHE_PATH + '.tmp', CACHE_PATH);
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

      (SELECT IF(COUNT(*) = 1, MIN(dl.discord_id), NULL)
         FROM discord_links dl WHERE dl.pilot_id = u.pilot_id) AS discord_id,

      ufv.value AS vatsim_cid,

      a.registration,
      a.icao AS aircraft_icao,
      a.status AS aircraft_status

    FROM pireps p
    JOIN users u
      ON u.id = p.user_id

    LEFT JOIN aircraft a
      ON a.id = p.aircraft_id

    LEFT JOIN user_field_values ufv
      ON ufv.user_id = u.id
     AND ufv.user_field_id = 1

    WHERE p.state = ? AND p.deleted_at IS NULL
    ORDER BY p.submitted_at DESC
    LIMIT 50
  `;

  const [rows] = await db.query(sql, [PIREP_STATE.PENDING]);
  return rows || [];
}


function resolvedMessage(message, id, state, baseUrl, reviewer) {
  const title = `PIREP Resolved — ${pirepStateLabel(state)}`;
  const original = message.embeds?.[0];
  const embed = EmbedBuilder.from(original ?? new EmbedBuilder()).setTitle(title)
    .setColor(state === PIREP_STATE.ACCEPTED ? 0x2ecc71 : 0xe74c3c);
  const footer = original?.title === title ? original.footer?.text : null;
  embed.setFooter({ text: reviewer ? `PIREP: ${id} • Reviewed by ${reviewer}` : footer || `PIREP: ${id}` });

  const row = new ActionRowBuilder();
  if (state === PIREP_STATE.ACCEPTED) row.addComponents(
    new ButtonBuilder().setCustomId(`pirep-training:${id}`).setLabel('Record Training').setStyle(ButtonStyle.Primary)
  );
  const url = reportUrl(id, baseUrl);
  if (url) row.addComponents(new ButtonBuilder().setLabel('View').setStyle(ButtonStyle.Link).setURL(url));
  return { embeds: [embed], components: row.components.length ? [row] : [], allowedMentions: { parse: [] } };
}

async function reconcileCache({ client, db, cache, pirepBaseUrl }) {
  for (const [id, entry] of Object.entries(cache)) {
    if (!validPirepId(id) || !entry?.channelId || !entry?.messageId) {
      delete cache[id];
      continue;
    }
    try {
      const state = reportState(await readReport(db, id));
      if (state === PIREP_STATE.PENDING) continue;
      const channel = await client.channels.fetch(entry.channelId);
      const message = await channel.messages.fetch(entry.messageId);
      await message.edit(resolvedMessage(message, id, state, pirepBaseUrl));
      delete cache[id];
      saveCache(cache);
    } catch (error) {
      // A retry after a transient error or restart edits the same message.
      if ([10003, 10008].includes(error.code)) delete cache[id];
      else console.warn('Could not reconcile a PIREP review:', error.code || error.name);
    }
  }
}

async function tickWatcher(opts) {
  const { client, db, guildId, trainingChannelId, pirepBaseUrl, vatsimStatsBaseUrl, fallbackChannelId } = opts;
  const cache = loadCache();
  await reconcileCache({ client, db, cache, pirepBaseUrl });
  saveCache(cache);

  const pending = await fetchPendingPireps(db);
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : client.guilds.cache.first();
  if (!guild) return;
  const parent = await guild.channels.fetch(trainingChannelId).catch(() => null);

  for (const rec of pending) {
    const id = String(rec.pirep_id);
    const url = reportUrl(id, pirepBaseUrl);
    if (!url || cache[id]) continue;

    const cid = (rec.vatsim_cid || '').trim();
    const stats = /^\d{6,8}$/.test(cid) ? `${vatsimStatsBaseUrl.replace(/\/$/, '')}/${cid}` : null;
    const nonce = createHash('sha256').update('pirep-review:' + id).digest('hex').slice(0, 25);
    const payload = {
      embeds: [buildPendingEmbed(rec, url, stats)], components: [buildButtons(id, url)], nonce, enforceNonce: true,
    };
    let message;
    try {
      message = await postToTrainingThread(parent, { pilotId: rec.pilot_id, discordId: rec.discord_id }, {
        ...payload, content: 'IPs: trainee filed a PIREP that needs review.',
      });
    } catch (error) {
      // A send with an uncertain result must not also post to the fallback channel.
      console.warn('Could not post a PIREP review in its training thread:', error.code || error.name);
      continue;
    }
    if (!message && fallbackChannelId) {
      const channel = await guild.channels.fetch(fallbackChannelId).catch(() => null);
      if (channel?.isTextBased()) message = await channel.send({ ...payload, allowedMentions: { parse: [] } });
    }
    if (message) {
      cache[id] = { channelId: message.channelId ?? message.channel?.id, messageId: message.id };
      saveCache(cache);
    }
  }
}

function startPendingPirepWatcher(opts) {
  const pollSeconds = Math.max(30, Number(opts.pollSeconds || 60));
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      await tickWatcher(opts);
    } catch (error) {
      console.warn('Pending PIREP watcher tick failed:', error.code || error.name);
    } finally {
      running = false;
    }
  }
  void tick();
  setInterval(tick, pollSeconds * 1000);
}

async function handlePirepButton(ctx) {
  const { interaction, db, roles, bridge = createPirepBridge() } = ctx;
  const reply = content => interaction.reply({ content, ephemeral: true });
  const [, action, pirepId, ...extra] = String(interaction.customId || '').split(':');
  const footer = interaction.message.embeds?.[0]?.footer?.text;
  if (extra.length || !validPirepId(pirepId) || !['approve', 'reject'].includes(action) ||
      !interaction.client.user?.id || interaction.message.author?.id !== interaction.client.user.id ||
      !(footer === `PIREP: ${pirepId}` || footer?.startsWith(`PIREP: ${pirepId} • Reviewed by `))) {
    return reply('❌ This review button is unavailable or does not match its PIREP.');
  }

  await interaction.deferUpdate();
  const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true }).catch(() => null);
  if (!member || ![roles.INSTRUCTOR_PILOT_ROLE_ID, roles.COMMAND_STAFF_ROLE_ID].some(id => id && member.roles.cache.has(id))) {
    return interaction.followUp({ content: '❌ Your permission to review PIREPs could not be verified.', ephemeral: true });
  }
  const reviewer = { discord_id: interaction.user.id, pilot_number: null };
  try {
    const [links] = await db.query(`SELECT u.pilot_id FROM discord_links d
      JOIN users u ON u.pilot_id = d.pilot_id WHERE d.discord_id = ? LIMIT 1`, [reviewer.discord_id]);
    const pilotId = String(links[0]?.pilot_id ?? '');
    if (/^[0-9]{1,15}$/.test(pilotId)) reviewer.pilot_number = 'C' + pilotId;
  } catch {
    console.warn('Could not look up the Discord PIREP reviewer’s linked pilot number.');
  }

  const result = await bridge.decide(pirepId, action, reviewer);
  const resolved = Number.isInteger(result.state) && result.state !== PIREP_STATE.PENDING;
  if (!resolved) {
    const explanation = {
      not_found: 'The PIREP was not found.',
      invalid: 'The bridge rejected the PIREP ID or request.',
      unauthorized: 'The bridge rejected authentication.',
      busy: 'The review is temporarily busy.',
      disabled: 'Approval through Discord is disabled.',
      reconciled: 'The PIREP was still pending at the last check. The original request may still be running.',
    }[result.code] ?? 'The bridge is unavailable or the outcome could not be confirmed.';
    return interaction.followUp({
      content: `❌ ${explanation} Check the PIREP in the native phpVMS admin interface before taking action.`,
      ephemeral: true,
    });
  }

  let state = result.state;
  try {
    if (state === PIREP_STATE.ACCEPTED) {
      state = reportState(await readReport(db, pirepId));
      if (state === PIREP_STATE.PENDING) throw new Error('Acceptance is not yet visible in the bot database');
    }
    const reviewer = result.code === 'changed' && state === result.state ? interaction.user.tag : null;
    await interaction.editReply(resolvedMessage(interaction.message, pirepId, state, undefined, reviewer));
  } catch {
    return interaction.followUp({
      content: `phpVMS reported ${pirepStateLabel(result.state)}. The review message will reconcile once the persisted state can be shown.`,
      ephemeral: true,
    });
  }
}

module.exports = {
  startPendingPirepWatcher,
  handlePirepButton,
  tickWatcher,
};
