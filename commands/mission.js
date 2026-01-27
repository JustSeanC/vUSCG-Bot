const { EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'mission',

  async execute(ctx) {
    const { interaction, db, geoBounds, flavorTexts, helpers } = ctx;
    const { isPointInAnyPolygon, checkIfWaterSmart, sleep } = helpers;

    const missionType = interaction.options.getString('type');
    const aircraftType = interaction.options.getString('aircraft');
    const baseAirport = interaction.options.getString('base');
    const missionDuration = interaction.options.getString('duration') || 'medium';

    try {
      await interaction.deferReply();

      console.log('--- MISSION START ---');

      let query = `
        SELECT registration, airport_id
        FROM aircraft
        WHERE registration LIKE 'C%'
        AND icao = ?
      `;
      const queryParams = [aircraftType];
      if (baseAirport) {
        query += ` AND airport_id = ?`;
        queryParams.push(baseAirport.toUpperCase());
      }

      const [rows] = await db.query(query, queryParams);
      if (rows.length === 0) {
        return await interaction.editReply({
          content: `❌ No available aircraft of type **${aircraftType}**${baseAirport ? ` at **${baseAirport}**` : ''}.`,
        });
      }

      const selectedAircraft = rows[Math.floor(Math.random() * rows.length)];
      const registration = selectedAircraft.registration;
      const base = selectedAircraft.airport_id;

      const [airportInfo] = await db.query(
        'SELECT lat, lon FROM airports WHERE icao = ?',
        [base]
      );

      let objectiveText = '';
      let mapUrl = null;

      if (airportInfo.length > 0 && airportInfo[0].lat && airportInfo[0].lon) {
        const lat = parseFloat(airportInfo[0].lat);
        const lon = parseFloat(airportInfo[0].lon);

        let randomLat = lat;
        let randomLon = lon;

        let attempt = 0;
        const maxAttempts = 5;
        let foundWater = false;

        let minNM = 0, maxNM = 25;
        if (missionDuration === 'short') { minNM = 0; maxNM = 20; }
        else if (missionDuration === 'medium') { minNM = 20; maxNM = 100; }
        else if (missionDuration === 'long') { minNM = 80; maxNM = 300; }

        while (!foundWater) {
          const bearing = Math.random() * 360;
          const distance = Math.max(minNM + Math.random() * (maxNM - minNM), 0.5);
          const radians = bearing * (Math.PI / 180);

          randomLat = lat + (distance / 60) * Math.cos(radians);
          randomLon = lon + (distance / (60 * Math.cos(lat * Math.PI / 180))) * Math.sin(radians);

          if (geoBounds[base] && !isPointInAnyPolygon(randomLat, randomLon, geoBounds[base])) {
            console.log(`📍 Skipping point outside ${base} polygon bounds`);
            continue;
          }

          attempt++;
          foundWater = await checkIfWaterSmart(lat, lon, randomLat, randomLon);

          if (!foundWater) {
            console.log(`🌍 Attempt ${attempt}: Over land, retrying...`);
            await sleep(1200);
          }
        }

        if (!foundWater) {
          console.log('⚠️ Could not find water after 5 attempts, using base coordinates.');
          randomLat = lat;
          randomLon = lon;
        }

        objectiveText = `Depart **${base}**.\nProceed to area near coordinates **${randomLat.toFixed(4)}°N, ${Math.abs(randomLon).toFixed(4)}°W**.`;

        // distance calc for zoom
        const toRadians = deg => deg * Math.PI / 180;
        const R = 3440.1;
        const dLat = toRadians(randomLat - lat);
        const dLon = toRadians(randomLon - lon);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat)) * Math.cos(toRadians(randomLat)) * Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;

        let zoom = 9;
        if (distance < 15) zoom = 10;
        else if (distance < 30) zoom = 9;
        else if (distance < 60) zoom = 8;
        else if (distance < 120) zoom = 7;
        else zoom = 6;

        const midLat = ((lat + randomLat) / 2).toFixed(4);
        const midLon = ((lon + randomLon) / 2).toFixed(4);

        mapUrl =
          `https://api.mapbox.com/styles/v1/mapbox/streets-v11/static/` +
          `pin-s+0000ff(${lon.toFixed(4)},${lat.toFixed(4)}),` +
          `pin-s+ff0000(${randomLon.toFixed(4)},${randomLat.toFixed(4)})/` +
          `${midLon},${midLat},${zoom}/600x400?access_token=${process.env.MAPBOX_TOKEN}`;

      } else {
        objectiveText = `Depart **${base}**.\n**Last known location unavailable. Proceed per operational instruction.**`;
      }

      const selectedFlavor = flavorTexts[missionType][Math.floor(Math.random() * flavorTexts[missionType].length)];

      const backupRecommended = [
        'multiple','lifeboat','crew abandoning','large ferry',
        'man overboard','multiple casualties','multiple survivors','multiple persons'
      ].some(k => selectedFlavor.toLowerCase().includes(k));

      const roll = Math.random();
      let missionPriority = 'Routine';
      if (missionType === 'SAR') missionPriority = roll < 0.7 ? 'Emergency' : 'Priority';
      else if (missionType === 'HITRON') missionPriority = roll < 0.5 ? 'Emergency' : 'Priority';
      else if (missionType === 'LE') missionPriority = roll < 0.3 ? 'Emergency' : roll < 0.8 ? 'Priority' : 'Routine';
      else if (missionType === 'MSP' || missionType === 'EP') missionPriority = roll < 0.8 ? 'Routine' : 'Priority';
      else if (missionType === 'ME') missionPriority = roll < 0.6 ? 'Emergency' : 'Priority';

      const priorityEmoji = missionPriority === 'Emergency' ? '🔴' : missionPriority === 'Priority' ? '🟡' : '🟢';
      const embedColor = missionPriority === 'Emergency' ? '#FF0000' : missionPriority === 'Priority' ? '#FFD700' : '#00FF00';

      const vatsimRemark = {
        SAR: 'Search and Rescue Op, vSO - vUSCG.com',
        LE: 'Law Enforcement Op, vSO - vUSCG.com',
        MSP: 'Maritime Security Patrol, vSO - vUSCG.com',
        HITRON: 'Drug Interdiction, vSO - vUSCG.com',
        EP: 'Environmental Patrol, vSO - vUSCG.com',
        ME: 'Medical Evacuation, vSO - vUSCG.com',
        R: 'Repositioning, vSO - vUSCG.com',
        T: 'Training, vSO - vUSCG.com'
      }[missionType] || 'Special Ops, vSO - vUSCG.com';

      const embed = new EmbedBuilder()
        .setTitle(`🚨 Mission Assignment: ${missionType}`)
        .setColor(embedColor)
        .addFields(
          { name: 'Aircraft', value: `**${registration}** (${aircraftType})`, inline: true },
          { name: 'Base', value: `**${base}**`, inline: true },
          { name: 'Duration', value: `**${missionDuration.charAt(0).toUpperCase() + missionDuration.slice(1)}**`, inline: true },
          { name: 'Priority Level', value: `${priorityEmoji} **${missionPriority}**`, inline: true },
          {
            name: 'Objective',
            value: `${objectiveText}\n\n${selectedFlavor}${backupRecommended ? '\n\n⚠️ Additional support recommended if available.' : ''}`
          },
          { name: 'VATSIM Flight Plan Remarks (Item 18: RMK/)', value: `\`${vatsimRemark}\`` },
          { name: 'Map Legend', value: `🟦 **Blue Pin** = Base Airport\n🔴 **Red Pin** = Point of Interest`, inline: false }
        )
        .setFooter({ text: `Good luck, pilot.\nDon't forget to start your ACARS!` });

      if (mapUrl) embed.setImage(mapUrl);

      await interaction.editReply({ embeds: [embed] });
      console.log('✅ Mission embed sent successfully.');
      console.log('--- MISSION END ---');

    } catch (err) {
      console.error('❌ Full error during mission generation:', err);
      await interaction.editReply({ content: '❌ An error occurred while generating the mission.' });
    }
  },
};
