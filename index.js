const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const mysql = require('mysql2/promise');
const fetch = require('node-fetch');
require('dotenv').config();
const flavorTexts = require('./flavorTexts.json');
const fs = require('fs');
const path = require('path');
const runBackup = require('./dbBackup');
const geoBounds = {};

fs.readdirSync('./geo_bounds').forEach(file => {
  if (file.endsWith('.json')) {
    const baseCode = path.basename(file, '.json').toUpperCase();
    geoBounds[baseCode] = JSON.parse(fs.readFileSync(`./geo_bounds/${file}`, 'utf8'));
  }
});


const turf = require('@turf/turf');

/**
 * Check if point is inside a GeoJSON polygon
 * @param {number} lat - Latitude of the point
 * @param {number} lon - Longitude of the point
 * @param {Object} polygon - A GeoJSON polygon (Feature or Geometry)
 * @returns {boolean}
 */
function isPointInAnyPolygon(lat, lon, featureCollection) {
  const point = turf.point([lon, lat]);
  return featureCollection.features.some(feature => {
    return turf.booleanPointInPolygon(point, feature);
  });
}


const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// ===== Helper Sleeping Respect API =====
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== Helper Functions for API Usage Tracking =====
function loadApiUsage() {
  try {
    const data = fs.readFileSync('./api_usage.json', 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('⚠️ Could not load API usage file:', err);
    return { date: "", count: 0 };
  }
}

function saveApiUsage(data) {
  try {
    fs.writeFileSync('./api_usage.json', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('⚠️ Could not save API usage file:', err);
  }
}

async function logApiUsageIfNeeded(client) {
  const usage = loadApiUsage();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD format

  if (usage.date !== today) {
    usage.date = today;
    usage.count = 0;
  }

  usage.count++;
  saveApiUsage(usage);

  console.log(`📈 API calls today: ${usage.count}/100`);

  if (usage.count === 90) {
    try {
      const channel = await client.channels.fetch('1219417224352235591'); // 👈 Replace this!
      await channel.send('⚠️ **Warning: IsItWater API usage has exceeded 90 calls today. Approaching limit (100/day).**');
    } catch (err) {
      console.error('⚠️ Could not send API usage alert to Discord channel:', err);
    }
  }
}
// ===== End of Helper Functions =====

/**
 * Check if the given lat/lon is over water using IsItWater API (RapidAPI).
 * Only make API call if distance from base is greater than 2 NM.
 */
async function checkIfWaterSmart(baseLat, baseLon, checkLat, checkLon) {
  const apiKey = process.env.RAPIDAPI_KEY;

  const toRadians = degrees => degrees * (Math.PI / 180);
  const R = 3440.1; // Earth radius in NM

  const dLat = toRadians(checkLat - baseLat);
  const dLon = toRadians(checkLon - baseLon);

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRadians(baseLat)) * Math.cos(toRadians(checkLat)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const distanceNM = R * c;

  console.log(`📏 Distance from base: ${distanceNM.toFixed(2)} NM`);

  if (distanceNM < 2) {
    console.log('✅ Close to base. Skipping API check.');
    return true;
  }

  try {
    // Log API usage!
    await logApiUsageIfNeeded(client); // 👈 (you must pass your client instance)

    const url = `https://isitwater-com.p.rapidapi.com/?latitude=${checkLat}&longitude=${checkLon}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-host': 'isitwater-com.p.rapidapi.com',
        'x-rapidapi-key': apiKey,
      },
    });

    const data = await response.json();

    if (typeof data.water === 'boolean') {
      console.log(`🌊 IsItWater: (${checkLat}, ${checkLon}) = ${data.water ? 'WATER' : 'LAND'}`);
      return data.water;
    } else {
      console.warn('⚠️ Unexpected IsItWater API response:', data);
      return false;
    }
  } catch (error) {
    console.error('❌ IsItWater API error:', error);
    return false;
  }
}


client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
});
  // Schedule first backup at 3:00 AM local time
  const now = new Date();
  const targetHour = 3;
  const targetTime = new Date(now);
  targetTime.setHours(targetHour, 0, 0, 0);
  if (targetTime <= now) targetTime.setDate(targetTime.getDate() + 1);
  const initialDelay = targetTime - now;

  setTimeout(() => {
    runBackup(client); // first run at 3AM

    setInterval(() => {
      runBackup(client); // repeat every 24 hours
    }, 24 * 60 * 60 * 1000); // every 24h
  }, initialDelay);

  console.log(`[+] Daily backup scheduled for 3:00 AM.`);
});
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const adminRoleId = '1174513441256513606';
  const staff = await interaction.guild.members.fetch(interaction.user.id);

  const pilotId = interaction.options.getInteger('pilot_id');
  const targetUser = interaction.options.getUser('user');


  // ===== /activate =====
  if (interaction.commandName === 'activate') {
    const trainingChannelId = '1174748570948223026';
    const welcomeGuideChannelId = '1350568038612865154';

    try {
      const [rows] = await db.query('SELECT name FROM users WHERE pilot_id = ?', [pilotId]);
      if (rows.length === 0) {
        return interaction.reply({ content: `❌ No user found with Pilot ID ${pilotId}`, ephemeral: true });
      }

      const fullName = rows[0].name.trim();
      const [firstName, ...lastParts] = fullName.split(' ');
      const lastInitial = lastParts.length ? lastParts[0][0].toUpperCase() : '';
      const nickname = `C${pilotId} ${firstName} ${lastInitial}`;

      await interaction.deferReply();

      await db.query('UPDATE users SET state = ?, rank_id = ? WHERE pilot_id = ?', [1, 1, pilotId]);

      const member = await interaction.guild.members.fetch(targetUser.id);
      await member.setNickname(nickname);
      await member.roles.add('1174513529253007370'); // vUSCG Cadet
      await member.roles.remove('1174513627273887895'); // Guest

      const trainingChannel = await interaction.guild.channels.fetch(trainingChannelId);

      const thread = await trainingChannel.threads.create({
        name: `Training Case for C${pilotId}`,
        autoArchiveDuration: 1440,
        type: 12,
        reason: `Training onboarding for C${pilotId}`,
        invitable: true,
      });

      await thread.members.add(targetUser.id);
      await thread.members.add(`251218149054087169`);
      await thread.members.add('347188501659254791');
      await thread.members.add('396783529327067136');
      
      await thread.send(`Welcome <@${targetUser.id}> - your account has been activated and you are ready to begin training. Please view <#${welcomeGuideChannelId}> for our ACARS information and just let us know here which training path you would like to follow first – Fixed Wing or Rotary Wing.`);

      await interaction.editReply({
        content: `✅ Activated <@${targetUser.id}> as **${nickname}** (Pilot ID ${pilotId}). A private training thread has been created.`,
      });

    } catch (err) {
      console.error('❌ Error in activate command:', err);
      try {
        await interaction.editReply({ content: '❌ An error occurred during activation.' });
      } catch {
        console.warn('⚠️ Interaction expired before bot could reply.');
      }
    }
  }

  // ===== /promote =====
  if (interaction.commandName === 'promote') {
    if (!staff.roles.cache.has(adminRoleId)) {
      return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    }

    const track = interaction.options.getString('track');
    const rolePilot = '1174513368992862218';
    const roleCadet = '1174513529253007370';
    const roleRotary = '1210792334749601862';
    const roleFixed = '1210792296199749672';

    try {
      const [rows] = await db.query('SELECT name FROM users WHERE pilot_id = ?', [pilotId]);
      if (rows.length === 0) {
        return interaction.reply({ content: `❌ No user found with Pilot ID ${pilotId}`, ephemeral: true });
      }

      const fullName = rows[0].name.trim();
      const [firstName, ...lastParts] = fullName.split(' ');
      const lastInitial = lastParts.length ? lastParts[0][0].toUpperCase() : '';
      const nickname = `C${pilotId} ${firstName} ${lastInitial}`;

      await interaction.deferReply();

      await db.query('UPDATE users SET rank_id = ? WHERE pilot_id = ?', [2, pilotId]);

      const member = await interaction.guild.members.fetch(targetUser.id);
      await member.setNickname(nickname);
      await member.roles.add(rolePilot);
      await member.roles.remove(roleCadet);
      await member.roles.add(track === 'rotary' ? roleRotary : roleFixed);

      await interaction.editReply({
        content: `✅ Promoted <@${targetUser.id}> to **vUSCG Pilot** – ${track === 'rotary' ? 'Rotary Wing' : 'Fixed Wing'}`,
      });

    } catch (err) {
      console.error('❌ Error in promote command:', err);
      try {
        await interaction.editReply({ content: '❌ An error occurred during promotion.' });
      } catch {
        console.warn('⚠️ Interaction expired before bot could reply.');
      }
    }
  }

// ===== /location =====
if (interaction.commandName === 'location') {
  const input = interaction.options.getString('search').toUpperCase();

  try {
    await interaction.deferReply();

    // 1. Try to match by registration
    const [regRows] = await db.query(
      'SELECT airport_id, flight_time, icao FROM aircraft WHERE registration = ?',
      [input]
    );

    if (regRows.length > 0) {
      const aircraft = regRows[0];
      const hours = (aircraft.flight_time / 60).toFixed(1);

      const embed = new EmbedBuilder()
        .setTitle(`Aircraft Info: ${input}`)
        .addFields(
          { name: 'Current Location', value: aircraft.airport_id || 'Unknown', inline: true },
          { name: 'Aircraft Type', value: aircraft.icao || 'Unknown', inline: true },
          { name: 'Total Flight Time', value: `${hours} hours`, inline: true }
        )
        .setColor('Blue');

      return await interaction.editReply({ embeds: [embed] });
    }

    // 2. Try to match by aircraft type (icao)
    const [typeRows] = await db.query(
      'SELECT registration, airport_id FROM aircraft WHERE icao = ?',
      [input]
    );

    if (typeRows.length > 0) {
      return handlePagination(interaction, typeRows, `Aircraft Type: ${input}`, ac => `• **${ac.registration}** — ${ac.airport_id || 'Unknown'}`);
    }

    // 3. Try to match by airport_id (location)
    const [locationRows] = await db.query(
      'SELECT registration, icao FROM aircraft WHERE airport_id = ?',
      [input]
    );

    if (locationRows.length > 0) {
      return handlePagination(interaction, locationRows, `Aircraft at Airport: ${input}`, ac => `• **${ac.registration}** — ${ac.icao || 'Unknown'}`);
    }

    // 4. Nothing found
    await interaction.editReply({
      content: `❌ No aircraft found matching **${input}**.`,
    });

  } catch (err) {
    console.error('❌ Error fetching location info:', err);
    await interaction.editReply({
      content: '❌ An error occurred while fetching location info.',
    });
  }
}

// Helper function for paginating results
async function handlePagination(interaction, dataRows, title, formatRow) {
  const pageSize = 10;
  let page = 0;

  const generateEmbed = (page) => {
    const start = page * pageSize;
    const end = start + pageSize;
    const slice = dataRows.slice(start, end);

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(slice.map(formatRow).join('\n'))
      .setFooter({ text: `Page ${page + 1} of ${Math.ceil(dataRows.length / pageSize)}` })
      .setColor('Blue');

    return embed;
  };

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('prev')
        .setLabel('⬅️ Previous')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('next')
        .setLabel('➡️ Next')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(dataRows.length <= pageSize)
    );

  const message = await interaction.editReply({
    embeds: [generateEmbed(page)],
    components: [row],
  });

  const collector = message.createMessageComponentCollector({ time: 5 * 60 * 1000 }); // 5 minutes timeout

  collector.on('collect', async i => {
    if (i.user.id !== interaction.user.id) {
      return i.reply({ content: '❌ Only the original requester can use these buttons.', ephemeral: true });
    }

    if (i.customId === 'next') {
      page++;
    } else if (i.customId === 'prev') {
      page--;
    }

    const newRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('prev')
          .setLabel('⬅️ Previous')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId('next')
          .setLabel('➡️ Next')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page >= Math.floor((dataRows.length - 1) / pageSize))
      );

    await i.update({
      embeds: [generateEmbed(page)],
      components: [newRow],
    });
  });

  collector.on('end', async () => {
    try {
      await message.edit({
        components: [],
      });
    } catch (err) {
      console.warn('⚠️ Could not remove buttons after timeout.');
    }
  });
}
// ===== /mission =====
if (interaction.commandName === 'mission') {
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
// Distance constraints based on duration
let minNM = 0, maxNM = 25; // default fallback
if (missionDuration === 'short') {
  minNM = 0;
  maxNM = 20;
} else if (missionDuration === 'medium') {
  minNM = 20;
  maxNM = 100;
} else if (missionDuration === 'long') {
  minNM = 80;
  maxNM = 300; // large upper bound, but will still be clipped by polygon size
}

while (!foundWater) {
  const bearing = Math.random() * 360;
  const distance = Math.max(minNM + Math.random() * (maxNM - minNM), 0.5);
  const radians = bearing * (Math.PI / 180);

  randomLat = lat + (distance / 60) * Math.cos(radians);
  randomLon = lon + (distance / (60 * Math.cos(lat * Math.PI / 180))) * Math.sin(radians);

  // If using KPIE and point is outside the polygon, skip and try again (no API call)
  if (geoBounds[base] && !isPointInAnyPolygon(randomLat, randomLon, geoBounds[base])) {
  console.log(`📍 Skipping point outside ${base} polygon bounds`);
  continue;
}

  attempt++; // Count only when API is called
  foundWater = await checkIfWaterSmart(lat, lon, randomLat, randomLon);

  if (!foundWater) {
    console.log(`🌍 Attempt ${attempt}: Over land, retrying...`);
    await sleep(1200); // Respect API rate limit
  }
}


if (!foundWater) {
  console.log('⚠️ Could not find water after 5 attempts, using base coordinates.');
  randomLat = lat;
  randomLon = lon;
}


const centerLat = ((lat + randomLat) / 2).toFixed(4);
const centerLon = ((lon + randomLon) / 2).toFixed(4);

objectiveText = `Depart **${base}**.\nProceed to area near coordinates **${randomLat.toFixed(4)}°N, ${Math.abs(randomLon).toFixed(4)}°W**.`;

// Build the map URL with midpoint centering
// Calculate distance for zoom level
const toRadians = deg => deg * Math.PI / 180;
const R = 3440.1; // NM
const dLat = toRadians(randomLat - lat);
const dLon = toRadians(randomLon - lon);
const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat)) * Math.cos(toRadians(randomLat)) * Math.sin(dLon / 2) ** 2;
const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
const distance = R * c;

// Dynamic zoom level (approximate)
let zoom = 9;
if (distance < 15) zoom = 10;
else if (distance < 30) zoom = 9;
else if (distance < 60) zoom = 8;
else if (distance < 120) zoom = 7;
else zoom = 6;

// Center map on midpoint
const midLat = ((lat + randomLat) / 2).toFixed(4);
const midLon = ((lon + randomLon) / 2).toFixed(4);

mapUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v11/static/` +
  `pin-s+0000ff(${lon.toFixed(4)},${lat.toFixed(4)}),` +
  `pin-s+ff0000(${randomLon.toFixed(4)},${randomLat.toFixed(4)})/` +
  `${midLon},${midLat},${zoom}/600x400?access_token=${process.env.MAPBOX_TOKEN}`;


    } else {
      objectiveText = `Depart **${base}**.\n**Last known location unavailable. Proceed per operational instruction.**`;
    }

    const selectedFlavor = flavorTexts[missionType][Math.floor(Math.random() * flavorTexts[missionType].length)];
    const backupRecommended = [
      'multiple', 'lifeboat', 'crew abandoning', 'large ferry',
      'man overboard', 'multiple casualties', 'multiple survivors', 'multiple persons'
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
{
    name: 'Map Legend',
    value: `🟦 **Blue Pin** = Base Airport\n🔴 **Red Pin** = Point of Interest`,
    inline: false
  }
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
}

  // ===== /atc =====
  /* if (interaction.commandName === 'atc') {
    const userInput = interaction.options.getString('airport').toUpperCase();
    await interaction.deferReply();

    const icao = userInput.startsWith('K') ? userInput : `K${userInput}`;
    const faa = icao.slice(1);

    const artccCoverage = {
      'KLAS': ['LAX_', 'ZLA'],
      'KLAX': ['LAX_', 'ZLA'],
      'KACY': ['NY_', 'ZNY'],
      'KATL': ['ATL_', 'ZTL'],
      'KPHX': ['PHX_', 'ZAB'],
      'KSAN': ['LAX_', 'ZLA'],
      'KSEA': ['SEA_', 'ZSE'],
      'KJFK': ['NY_', 'ZNY'],
      'KDFW': ['DFW_', 'ZFW'],
      'KDEN': ['DEN_', 'ZDV'],
      'KORD': ['CHI_', 'ZAU'],
      'KMIA': ['MIA_', 'ZMA'],
      'KSVN': ['SAV_', 'ZJX'],
      // ... include your full list here
    };

    const baseTerms = [icao, faa];
    const regionalTerms = artccCoverage[icao] || [];
    const searchTerms = [...baseTerms, ...regionalTerms.map(t => t.toUpperCase())];

    try {
      const response = await fetch('https://data.vatsim.net/v3/vatsim-data.json');
      const data = await response.json();

      const categories = {
        delivery: [],
        ground: [],
        tower: [],
        approach: [],
        center: [],
        other: [],
      };

      data.controllers.forEach(ctrl => {
        const cs = ctrl.callsign.toUpperCase();
        const matches = searchTerms.some(code => cs.includes(code));
        if (!matches || !ctrl.frequency) return;

        if (cs.includes('DEL')) categories.delivery.push(ctrl);
        else if (cs.includes('GND')) categories.ground.push(ctrl);
        else if (cs.includes('TWR')) categories.tower.push(ctrl);
        else if (cs.includes('APP') || cs.includes('DEP')) categories.approach.push(ctrl);
        else if (cs.includes('CTR')) categories.center.push(ctrl);
        else categories.other.push(ctrl);
      });

      const format = (title, list) => {
        if (!list.length) return null;
        return `**${title}**\n${list.map(c => `• **${c.callsign}** – ${c.frequency}`).join('\n')}`;
      };

      const output = [
        format('📝 Delivery', categories.delivery),
        format('🚜 Ground', categories.ground),
        format('🗼 Tower', categories.tower),
        format('🛫 Approach / Departure', categories.approach),
        format('📡 Center / ARTCC', categories.center),
        format('📻 Other', categories.other),
      ].filter(Boolean).join('\n\n');

      if (!output) {
        return await interaction.editReply(`🛬 No ATC currently online for **${icao}**.`);
      }

      await interaction.editReply({
        content: `🎧 **Active ATC near ${icao}**\n\n${output}`,
      });

    } catch (err) {
      console.error('❌ Error fetching VATSIM data:', err);
      await interaction.editReply('❌ Could not fetch ATC info at this time.');
    }
  } */



});

client.login(process.env.DISCORD_TOKEN);
