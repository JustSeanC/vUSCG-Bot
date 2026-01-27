const { Client, GatewayIntentBits } = require('discord.js');
const mysql = require('mysql2/promise');
const fetch = require('node-fetch');
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const turf = require('@turf/turf');

const flavorTexts = require('./flavorTexts.json');
const runBackup = require('./dbBackup'); // keeping require (even if not used here yet)
const syncRanks = require('./rankSync');

const commands = require('./commands');

const BACKUP_TAG_FILE = './.last_backup_date'; // keeping constant (even if not used here yet)

// ---------- Load Geo Bounds ----------
const geoBounds = {};
try {
  fs.readdirSync('./geo_bounds').forEach(file => {
    if (file.endsWith('.json')) {
      const baseCode = path.basename(file, '.json').toUpperCase();
      geoBounds[baseCode] = JSON.parse(fs.readFileSync(`./geo_bounds/${file}`, 'utf8'));
    }
  });
  console.log(`✅ Loaded geo bounds for: ${Object.keys(geoBounds).join(', ')}`);
} catch (e) {
  console.warn('⚠️ Could not load ./geo_bounds (folder missing or unreadable). Mission polygon checks may not work.');
}

// ---------- Discord Client ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ---------- Database Pool ----------
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// ---------- Helpers ----------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if point is inside ANY polygon in a FeatureCollection
 */
function isPointInAnyPolygon(lat, lon, featureCollection) {
  if (!featureCollection?.features?.length) return true;
  const point = turf.point([lon, lat]);
  return featureCollection.features.some(feature => turf.booleanPointInPolygon(point, feature));
}

// ----- API Usage Tracking -----
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

async function logApiUsageIfNeeded(discordClient) {
  const usage = loadApiUsage();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  if (usage.date !== today) {
    usage.date = today;
    usage.count = 0;
  }

  usage.count++;
  saveApiUsage(usage);

  console.log(`📈 API calls today: ${usage.count}/100`);

  if (usage.count === 90) {
    try {
      const channel = await discordClient.channels.fetch('1219417224352235591'); // API warning channel
      await channel.send('⚠️ **Warning: IsItWater API usage has exceeded 90 calls today. Approaching limit (100/day).**');
    } catch (err) {
      console.error('⚠️ Could not send API usage alert to Discord channel:', err);
    }
  }
}

/**
 * IsItWater check with smart skipping if close to base (< 2NM)
 */
async function checkIfWaterSmart(baseLat, baseLon, checkLat, checkLon) {
  const apiKey = process.env.RAPIDAPI_KEY;

  const toRadians = degrees => degrees * (Math.PI / 180);
  const R = 3440.1; // Earth radius in NM

  const dLat = toRadians(checkLat - baseLat);
  const dLon = toRadians(checkLon - baseLon);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
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
    // Throttle API call slightly to avoid per-second limit
    await sleep(1500);

    // Log API usage
    await logApiUsageIfNeeded(client);

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

// ---------- Ready / Background Tasks ----------
client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);

  // Run rank sync once on startup
  try {
    syncRanks(client, db, process.env.GUILD_ID);
  } catch (e) {
    console.error('❌ Rank sync failed on startup:', e);
  }

  // Run every hour
  setInterval(() => {
    try {
      syncRanks(client, db, process.env.GUILD_ID);
    } catch (e) {
      console.error('❌ Rank sync failed on interval:', e);
    }
  }, 60 * 60 * 1000);
});

// ---------- Command Dispatcher ----------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // Block DMs (prevents interaction.guild being null)
  if (!interaction.inGuild()) {
    return interaction.reply({
      content: '❌ This command can only be used inside the Discord server.',
      ephemeral: true,
    });
  }

  const COMMAND_STAFF_ROLE_ID = process.env.COMMAND_STAFF_ROLE_ID;
  const INSTRUCTOR_PILOT_ROLE_ID = process.env.INSTRUCTOR_PILOT_ROLE_ID;

  const staff =
    interaction.member ??
    (await interaction.guild.members.fetch(interaction.user.id));

  const hasRole = (roleId) => !!roleId && staff.roles.cache.has(roleId);

  const handler = commands?.[interaction.commandName];

  if (!handler || typeof handler.execute !== 'function') {
    return interaction.reply({
      content: `❌ No handler registered for /${interaction.commandName}.`,
      ephemeral: true,
    });
  }

  const ctx = {
    interaction,
    client,
    db,
    geoBounds,
    flavorTexts,
    staff,
    hasRole,
    roles: {
      COMMAND_STAFF_ROLE_ID,
      INSTRUCTOR_PILOT_ROLE_ID,
    },
    helpers: {
      sleep,
      checkIfWaterSmart,
      isPointInAnyPolygon,
      logApiUsageIfNeeded,
    },
  };

  try {
    await handler.execute(ctx);
  } catch (err) {
    console.error(`❌ Unhandled error in /${interaction.commandName}:`, err);

    if (interaction.deferred || interaction.replied) {
      try { await interaction.editReply({ content: '❌ Command failed unexpectedly.' }); } catch {}
    } else {
      try {
        await interaction.reply({
          content: '❌ Command failed unexpectedly.',
          ephemeral: true,
        });
      } catch {}
    }
  }
});

// ---------- Login ----------
client.login(process.env.DISCORD_TOKEN);
