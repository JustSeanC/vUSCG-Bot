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

module.exports = {
  name: 'manualpirep',

  async execute(ctx) {
    const { interaction, db } = ctx;

    const registration = interaction.options.getString('registration', true).trim().toUpperCase();
    const dep = interaction.options.getString('dep', true).trim().toUpperCase();
    const arr = interaction.options.getString('arr', true).trim().toUpperCase();
    const minutes = interaction.options.getInteger('minutes', true);
    const routeRaw = interaction.options.getString('route');
    const notesRaw = interaction.options.getString('notes');
    const relocate = interaction.options.getBoolean('relocate') ?? true;

    const route = routeRaw && routeRaw.trim().length ? routeRaw.trim() : null;
    const notes = notesRaw && notesRaw.trim().length ? notesRaw.trim() : null;

    if (minutes < 1 || minutes > 2000) {
      return interaction.reply({
        content: '❌ Flight time must be between 1 and 2000 minutes.',
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

      // 4) Insert PIREP
      const pirepId = randomUUID();
      await db.query(
        `INSERT INTO pireps (
          id, user_id, airline_id, aircraft_id,
          dpt_airport_id, arr_airport_id,
          flight_time, distance,
          route, notes,
          status, source_name,
          submitted_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?,
          ?, ?,
          ?, ?,
          ?, ?,
          NOW(), NOW(), NOW()
        )`,
        [
          pirepId, userId, airlineId, aircraftId,
          dep, arr,
          minutes, dist,
          route, notes,
          'ARR', 'Discord Manual',
        ]
      );

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

      // 6) Confirm
      await interaction.editReply({
        content:
          `✅ Manual PIREP created for **C${pilotId}** (${pirepId}).\n` +
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
