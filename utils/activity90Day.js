const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const CACHE_PATH = './activity_90d_cache.json';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return { activePilotIds: [], activeTraineePilotIds: [], lastPostedDate: null };
  }
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn('⚠️ Could not save 90-day activity cache:', e?.message ?? e);
  }
}

function todayInEasternISO(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(date);
}

function shouldPostNow(now = new Date()) {
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const hour = Number(et.find(p => p.type === 'hour')?.value ?? 0);
  const minute = Number(et.find(p => p.type === 'minute')?.value ?? 0);
  return hour === 22 && minute <= 10;
}

async function fetchActivePilots(db) {
  const sql = `
    SELECT
      u.id AS user_id,
      u.pilot_id,
      u.name,
      u.rank_id,
      rp.last_flight_at,
      ufv.value AS vatsim_cid
    FROM (
      SELECT
        p.user_id,
        MAX(p.submitted_at) AS last_flight_at
      FROM pireps p
      WHERE p.submitted_at >= (UTC_TIMESTAMP() - INTERVAL 90 DAY)
      GROUP BY p.user_id
    ) rp
    LEFT JOIN users u
      ON u.id = rp.user_id
    LEFT JOIN user_field_values ufv
      ON ufv.user_id = u.id
     AND ufv.user_field_id = 1
    ORDER BY rp.last_flight_at DESC, u.pilot_id ASC
  `;
  const [rows] = await db.query(sql);
  return rows || [];
}

function formatPilotList(rows, limit = 1024) {
  if (!rows.length) return '• None';

  const items = rows.map(r => {
    const vatsim = (r.vatsim_cid || 'Unknown').trim();
    return `• ${r.name || 'Unknown'} | vUSCG C${r.pilot_id} | VATSIM ${vatsim}`;
  });

  let out = '';
  for (let i = 0; i < items.length; i++) {
    const remainingAfterThis = items.length - (i + 1);
    const suffix = remainingAfterThis > 0 ? `\n… (+${remainingAfterThis} more)` : '';
    const candidate = `${out}${out ? '\n' : ''}${items[i]}`;

    if ((candidate + suffix).length > limit) {
      const remainingNow = items.length - i;
      const forcedSuffix = `\n… (+${remainingNow} more)`;
      if ((out + forcedSuffix).length > limit) {
        const maxOutLen = Math.max(0, limit - forcedSuffix.length);
        out = out.slice(0, maxOutLen).replace(/[\s,\n]+$/, '');
      }
      return `${out}${forcedSuffix}` || '• None';
    }

    out = candidate;
  }

  return out || '• None';
}

function chunkLines(lines, maxChars = 3800, maxLines = 30) {
  const chunks = [];
  let cur = [];
  let curLen = 0;

  for (const line of lines) {
    const addLen = (cur.length ? 1 : 0) + line.length;
    if (cur.length >= maxLines || (curLen + addLen) > maxChars) {
      if (cur.length) chunks.push(cur);
      cur = [line];
      curLen = line.length;
    } else {
      cur.push(line);
      curLen += addLen;
    }
  }

  if (cur.length) chunks.push(cur);
  return chunks;
}


async function sendPaginatedEmbeds(channel, embeds) {
  if (!embeds.length) return;
  if (embeds.length === 1) {
    await channel.send({ embeds: [embeds[0]] });
    return;
  }

  let page = 0;
  const buildRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('activity90:prev').setLabel('⬅️ Previous').setStyle(ButtonStyle.Primary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('activity90:next').setLabel('Next ➡️').setStyle(ButtonStyle.Primary).setDisabled(page === embeds.length - 1)
  );

  const msg = await channel.send({ embeds: [embeds[page]], components: [buildRow()] });
  const collector = msg.createMessageComponentCollector({ time: 24 * 60 * 60 * 1000 });

  collector.on('collect', async i => {
    if (i.customId === 'activity90:next' && page < embeds.length - 1) page++;
    if (i.customId === 'activity90:prev' && page > 0) page--;
    await i.update({ embeds: [embeds[page]], components: [buildRow()] });
  });

  collector.on('end', async () => {
    try { await msg.edit({ components: [] }); } catch {}
  });
}

function buildEmbeds({ activeRows, addedRows, removedRows, includeFullList, promotedOutOfEnsRows, movedIntoEnsRows }) {
  const todayEt = todayInEasternISO();
  const lookback = todayInEasternISO(new Date(Date.now() - (90 * MS_PER_DAY)));

  const activeTrainees = activeRows.filter(r => Number(r.rank_id) === 12).length;
  const addedTrainees = addedRows.filter(r => Number(r.rank_id) === 12).length;
  const removedTrainees = removedRows.filter(r => Number(r.rank_id) === 12).length;

  const summary = new EmbedBuilder()
    .setTitle('📊 90-Day Activity Checker')
    .setColor(0x3498db)
    .setDescription('Daily status snapshot (90-day rule)\nNote: ENS trainees do not receive M ratings.')
    .addFields(
      { name: 'Today', value: todayEt, inline: true },
      { name: 'Window Start', value: lookback, inline: true },
      { name: 'Window End', value: todayEt, inline: true },
      { name: 'Active Pilots', value: String(activeRows.length), inline: true },
      { name: 'Added Since Last Check', value: String(addedRows.length), inline: true },
      { name: 'Removed Since Last Check', value: String(removedRows.length), inline: true },
      { name: 'Active Trainees (ENS)', value: String(activeTrainees), inline: true },
      { name: 'Added Trainees (ENS)', value: String(addedTrainees), inline: true },
      { name: 'Removed Trainees (ENS)', value: String(removedTrainees), inline: true },
      { name: 'Promoted ENS → O-2+', value: formatPilotList(promotedOutOfEnsRows || []), inline: false },
      { name: 'Moved Into ENS', value: formatPilotList(movedIntoEnsRows || []), inline: false },
      { name: '✅ Added Pilots', value: formatPilotList(addedRows), inline: false },
      { name: '❌ Removed Pilots', value: formatPilotList(removedRows), inline: false },
    );

  const embeds = [summary];
  if (!includeFullList) return embeds;

  const makeLine = (r) => {
    const vatsim = (r.vatsim_cid || 'Unknown').trim();
    return `• ${r.name || 'Unknown Name'} | vUSCG C${r.pilot_id} | VATSIM ${vatsim}`;
  };

  const trainees = activeRows.filter(r => Number(r.rank_id) === 12);
  const nonTrainees = activeRows.filter(r => Number(r.rank_id) !== 12);

  const nonTraineeLines = nonTrainees.length
    ? nonTrainees.map(makeLine)
    : ['• No non-trainee active pilots found.'];

  const traineeLines = trainees.length
    ? trainees.map(makeLine)
    : ['• No active ENS trainees found.'];

  const nonTraineePages = chunkLines(nonTraineeLines);
  nonTraineePages.forEach((pageLines, idx) => {
    embeds.push(
      new EmbedBuilder()
        .setTitle(`📋 Full Active List (Monthly - Non-Trainees) — Page ${idx + 1}/${nonTraineePages.length}`)
        .setColor(0x2ecc71)
        .setDescription(pageLines.join('\n'))
    );
  });

  const traineePages = chunkLines(traineeLines);
  traineePages.forEach((pageLines, idx) => {
    embeds.push(
      new EmbedBuilder()
        .setTitle(`🧑‍🎓 Full Active List (Monthly - ENS Trainees) — Page ${idx + 1}/${traineePages.length}`)
        .setColor(0xf1c40f)
        .setDescription(pageLines.join('\n'))
    );
  });

  return embeds;
}

async function runActivity90DayReport({ client, db, channelId, force = false, dryRun = false, showFullList = false }) {
  const cache = loadCache();
  const todayEt = todayInEasternISO();
  if (!force && cache.lastPostedDate === todayEt) return { skipped: true, reason: 'already_posted_today' };

  const activeRows = await fetchActivePilots(db);
  const oldSet = new Set((cache.activePilotIds || []).map(Number));
  const newSet = new Set(activeRows.map(r => Number(r.pilot_id)));

  const addedRows = activeRows.filter(r => !oldSet.has(Number(r.pilot_id)));

  const oldTraineeSet = new Set((cache.activeTraineePilotIds || []).map(Number));
  const newTraineeSet = new Set(activeRows.filter(r => Number(r.rank_id) === 12).map(r => Number(r.pilot_id)));

  const promotedOutOfEnsRows = activeRows.filter(r => oldTraineeSet.has(Number(r.pilot_id)) && !newTraineeSet.has(Number(r.pilot_id)));
  const movedIntoEnsRows = activeRows.filter(r => !oldTraineeSet.has(Number(r.pilot_id)) && newTraineeSet.has(Number(r.pilot_id)));

  const removedPilotIds = [...oldSet].filter(id => !newSet.has(id));

  let removedRows = [];
  if (removedPilotIds.length) {
    const [rows] = await db.query(
      `SELECT u.pilot_id, u.name, u.rank_id, ufv.value AS vatsim_cid
       FROM users u
       LEFT JOIN user_field_values ufv
         ON ufv.user_id = u.id
        AND ufv.user_field_id = 1
       WHERE u.pilot_id IN (${removedPilotIds.map(() => '?').join(',')})`,
      removedPilotIds
    );
    removedRows = rows || [];
  }

  const etDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', day: 'numeric' }).format(new Date());
  const isMonthlyFull = etDay === '1';
  const includeFullList = showFullList || isMonthlyFull;
  const embeds = buildEmbeds({
    activeRows,
    addedRows,
    removedRows,
    includeFullList,
    promotedOutOfEnsRows,
    movedIntoEnsRows,
  });

  if (!dryRun) {
    const ch = await client.channels.fetch(channelId);
    if (ch?.isTextBased()) await sendPaginatedEmbeds(ch, embeds);
    saveCache({
      lastPostedDate: todayEt,
      activePilotIds: activeRows.map(r => Number(r.pilot_id)),
      activeTraineePilotIds: activeRows.filter(r => Number(r.rank_id) === 12).map(r => Number(r.pilot_id)),
    });
  }

  return { skipped: false, activeCount: activeRows.length, added: addedRows.length, removed: removedRows.length, embeds };
}

function startActivity90DayReporter({ client, db, channelId = '1507352324194959360', pollMs = 5 * 60 * 1000 }) {
  const tick = async () => {
    try {
      if (shouldPostNow()) await runActivity90DayReport({ client, db, channelId });
    } catch (e) {
      console.warn('⚠️ 90-day activity reporter tick failed:', e?.message ?? e);
    }
  };
  tick();
  setInterval(tick, pollMs);
}

module.exports = { startActivity90DayReporter, runActivity90DayReport };
