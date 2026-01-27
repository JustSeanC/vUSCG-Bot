const { randomUUID } = require('crypto');

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Haversine distance in NM
function distanceNM(lat1, lon1, lat2, lon2) {
  const R_km = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const km = R_km * c;
  const nm = km * 0.539957;
  return nm;
}
function parseTimeToMinutes(inputRaw) {
  const s = String(inputRaw).trim().toLowerCase();

  // H:MM format (e.g., 1:30)
  const hm = s.match(/^(\d{1,3})\s*:\s*([0-5]?\d)$/);
  if (hm) {
    const h = parseInt(hm[1], 10);
    const m = parseInt(hm[2], 10);
    return h * 60 + m;
  }

  // 90m
  const mins = s.match(/^(\d{1,4})\s*m$/);
  if (mins) return parseInt(mins[1], 10);

  // 1.5h or 1h
  const hoursWithH = s.match(/^(\d+(\.\d+)?)\s*h$/);
  if (hoursWithH) return Math.round(parseFloat(hoursWithH[1]) * 60);

  // Decimal number with a dot -> treat as hours (1.25)
  if (/^\d+(\.\d+)$/.test(s)) {
    return Math.round(parseFloat(s) * 60);
  }

  // Plain integer -> treat as minutes (90)
  if (/^\d{1,4}$/.test(s)) {
    return parseInt(s, 10);
  }

  return null; // invalid
}
function formatMinutesHHMM(totalMinutes) {
  const m = Math.max(0, parseInt(totalMinutes, 10) || 0);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  return `${String(h).padStart(2, '0')}:${mm}`;
}

module.exports = {
  name: 'manualpirep',

  async execute(ctx) {
    const { interaction, db, client } = ctx;
    const ROLE_PILOT = '1174513368992862218';
    const ROLE_TRAINEE = '1174513529253007370';

    // Determine approval behavior from roles
    const member = interaction.member; // GuildMember
    const isPilot = member?.roles?.cache?.has(ROLE_PILOT);
    const isTrainee = member?.roles?.cache?.has(ROLE_TRAINEE);

    // If pilot, auto-approve. Otherwise require approval.
    const pirepState = isPilot ? 2 : 1;

    const registration = interaction.options.getString('registration', true).trim().toUpperCase();
    const dep = interaction.options.getString('dep', true).trim().toUpperCase();
    const arr = interaction.options.getString('arr', true).trim().toUpperCase();
    const routeRaw = interaction.options.getString('route');
    const notesRaw = interaction.options.getString('notes');
    const relocate = interaction.options.getBoolean('relocate') ?? true;
    const distanceOverride = interaction.options.getNumber('distance_nm');
    const route = routeRaw && routeRaw.trim().length ? routeRaw.trim() : null;
    const notes = notesRaw && notesRaw.trim().length ? notesRaw.trim() : null;

    const timeRaw = interaction.options.getString('time', true);
const minutes = parseTimeToMinutes(timeRaw);

if (!minutes || minutes < 1 || minutes > 2000) {
  return interaction.reply({
    content:
      `❌ Invalid time format: **${timeRaw}**\n` +
      `Use: **90**, **90m**, **1.5**, **1.5h**, or **1:30**.`,
    ephemeral: true,
  });
}
    await interaction.deferReply({ ephemeral: true });

    try {
      // 0) Resolve pilot_id (discord_links first; fallback to nickname)
      let pilotId = null;

      const [linkRows] = await db.query(
        'SELECT pilot_id FROM discord_links WHERE discord_id = ? LIMIT 1',
        [interaction.user.id]
      );
      if (linkRows.length > 0 && linkRows[0].pilot_id != null) {
        pilotId = parseInt(linkRows[0].pilot_id, 10);
      }

      if (!pilotId) {
        const displayName =
          interaction.member?.nickname ||
          interaction.member?.displayName ||
          interaction.user?.username ||
          '';
        const m = displayName.match(/\bC(\d{3,6})\b/i);
        if (!m) {
          return interaction.editReply({
            content:
              `❌ I couldn't resolve your Pilot ID.\n` +
              `I looked at: **${displayName || '(blank)'}**\n\n` +
              `Your nickname needs **C####** or you must be linked via /activate.`,
          });
        }
        pilotId = parseInt(m[1], 10);
      }

      // 1) Get phpVMS user_id + airline_id + current
      const [uRows] = await db.query(
        'SELECT id, airline_id, curr_airport_id FROM users WHERE pilot_id = ? LIMIT 1',
        [pilotId]
      );
      if (uRows.length === 0) {
        return interaction.editReply({
          content: `❌ Pilot **C${pilotId}** was not found in phpVMS users table.`,
        });
      }
      const userId = uRows[0].id;
      const airlineId = uRows[0].airline_id;
      const userCurrent = (uRows[0].curr_airport_id || 'UNKNOWN').toUpperCase();

      // 2) Validate aircraft
      const [acRows] = await db.query(
        'SELECT id, airport_id, status FROM aircraft WHERE registration = ? LIMIT 1',
        [registration]
      );
      if (acRows.length === 0) {
        return interaction.editReply({
          content: `❌ Aircraft **${registration}** not found.`,
        });
      }
      const aircraftId = acRows[0].id;
      const acCurrent = (acRows[0].airport_id || 'UNKNOWN').toUpperCase();
      const acStatus = (acRows[0].status || 'UNKNOWN').toUpperCase();

      // 3) Validate airports + pull lat/lon for distance if available
      const [depRows] = await db.query(
        'SELECT icao, lat, lon FROM airports WHERE icao = ? LIMIT 1',
        [dep]
      );
      if (depRows.length === 0) {
        return interaction.editReply({ content: `❌ Departure airport **${dep}** not found.` });
      }

      const [arrRows] = await db.query(
        'SELECT icao, lat, lon FROM airports WHERE icao = ? LIMIT 1',
        [arr]
      );
      if (arrRows.length === 0) {
        return interaction.editReply({ content: `❌ Arrival airport **${arr}** not found.` });
      }

      let dist = null;

// If user provided distance, prefer it
if (typeof distanceOverride === 'number') {
  if (distanceOverride < 0 || distanceOverride > 5000) {
    return interaction.editReply({ content: '❌ Distance must be between 0 and 5000 NM.' });
  }
  dist = Number(distanceOverride.toFixed(2));
} else {
  // Otherwise auto-calc if lat/lon available
  const depLat = depRows[0].lat != null ? parseFloat(depRows[0].lat) : null;
  const depLon = depRows[0].lon != null ? parseFloat(depRows[0].lon) : null;
  const arrLat = arrRows[0].lat != null ? parseFloat(arrRows[0].lat) : null;
  const arrLon = arrRows[0].lon != null ? parseFloat(arrRows[0].lon) : null;

  if (
    Number.isFinite(depLat) &&
    Number.isFinite(depLon) &&
    Number.isFinite(arrLat) &&
    Number.isFinite(arrLon)
  ) {
    dist = Number(distanceNM(depLat, depLon, arrLat, arrLon).toFixed(2));
  }
}

// 4) Insert PIREP
const pirepId = randomUUID();
await db.query(
  `INSERT INTO pireps (
    id, user_id, airline_id, aircraft_id,
    dpt_airport_id, arr_airport_id,
    flight_time, distance,
    route, notes,
    status, state, source_name,
    submitted_at, created_at, updated_at
  ) VALUES (
    ?, ?, ?, ?,
    ?, ?,
    ?, ?,
    ?, ?,
    ?, ?, ?,
    UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP()
  )`,
  [
    pirepId, userId, airlineId, aircraftId,
    dep, arr,
    minutes, dist,
    route, notes,
    'ARR', pirepState, 'Discord Manual',
  ]
);

        [
  pirepId, userId, airlineId, aircraftId,
  dep, arr,
  minutes, dist,
  route, notes,
  'ARR', pirepState, 'Discord Manual',
]


      // 5) Optional relocation (pilot + aircraft)
      let relocatedUser = false;
      let relocatedAircraft = false;

      if (relocate) {
        await db.query(
          'UPDATE users SET curr_airport_id = ? WHERE id = ?',
          [arr, userId]
        );
        relocatedUser = true;

        // If aircraft is retired/scrapped, don't move it (your preference can change later)
        if (acStatus !== 'R' && acStatus !== 'C') {
          await db.query(
            'UPDATE aircraft SET airport_id = ? WHERE id = ?',
            [arr, aircraftId]
          );
          relocatedAircraft = true;
        }
      }

// 6) Post flight info to log channel
const logChannelId = '1219417084652556348';

try {
  const ch = await client.channels.fetch(logChannelId);

  if (ch && ch.isTextBased()) {
    const approvalText = pirepState === 2 ? '✅ Auto-approved (Pilot)' : '🕓 Pending approval (Trainee)';

    // Build a readable log message
let msg =
  `✈️ **Manual PIREP Filed**\n` +
  `• Pilot: <@${interaction.user.id}> (C${pilotId})\n` +
  `• Aircraft: **${registration}** (Status: **${acStatus}**)\n` +
  `• Route: **${dep} → ${arr}**\n` +
  `• Time: **${formatMinutesHHMM(minutes)}**` +
  (dist != null ? ` | Distance: **${dist} NM**\n` : `\n`) +
  `• Approval: **${approvalText}**`;

if (route) msg += `\n• Route String: \`${route}\``;
if (notes) msg += `\n• Notes: ${notes}`;

await ch.send(msg);

  } else {
    console.warn(`⚠️ Log channel ${logChannelId} not found or not text-based`);
  }
} catch (e) {
  console.warn('⚠️ Could not post manualpirep log message:', e?.message ?? e);
}

      // 6) Confirm
      await interaction.editReply({
        content:
          `✅ Manual PIREP created for **C${pilotId}** (${pirepId}).\n` +
          `• Approval: **${pirepState === 2 ? 'Auto-approved (Pilot)' : 'Pending approval (Trainee)'}**\n`+
          `• Aircraft: **${registration}** (Status: **${acStatus}**)\n` +
          `• Route: **${dep} → ${arr}**\n` +
          `• Time: **${minutes} min**` +
          (dist != null ? ` | Distance: **${dist} NM**\n` : `\n`) +
          `• Relocate: **${relocate ? 'Yes' : 'No'}**\n` +
          (relocate
            ? `• Pilot location: **${userCurrent} → ${arr}**\n` +
              `• Aircraft location: **${acCurrent} → ${relocatedAircraft ? arr : acCurrent}**`
            : ''),
      });

    } catch (err) {
      console.error('❌ Error in manualpirep:', err);
      await interaction.editReply({
        content: '❌ An error occurred while creating the manual PIREP.',
      });
    }
  },
};
