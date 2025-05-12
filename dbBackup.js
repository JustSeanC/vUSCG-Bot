// dbBackup.js
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { AttachmentBuilder } = require('discord.js');
require('dotenv').config();

const BACKUP_DIR = path.join(__dirname, 'backups');
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME;
const DB_HOST = process.env.DB_HOST;
const CHANNEL_ID = process.env.DB_BACKUP_ID;

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

const { execSync } = require('child_process');

async function runBackup(client) {
  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `${DB_NAME}_${timestamp}.sql`;
  const filepath = path.join(BACKUP_DIR, filename);
  const zipFilePath = `${filepath}.zip`;

  console.log(`[+] Starting backup for tables: aircraft, pireps, users`);

  try {
    execSync(`mysqldump -h ${DB_HOST} -u ${DB_USER} -p${DB_PASS} ${DB_NAME} aircraft pireps users > ${filepath}`);
    console.log(`[+] SQL backup saved: ${filename}`);
  } catch (err) {
    console.error(`❌ Backup failed: ${err.message}`);
    return;
  }

  try {
    execSync(`zip -j ${zipFilePath} ${filepath}`);
    console.log(`[+] Backup zipped: ${zipFilePath}`);
  } catch (err) {
    console.error(`❌ ZIP failed: ${err.message}`);
    return;
  }

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    const file = new AttachmentBuilder(fs.readFileSync(zipFilePath), {
      name: path.basename(zipFilePath),
    });

    await channel.send({
      content: `Backup for **${timestamp}** (Tables: aircraft, pireps, users)`,
      files: [file],
    });

    console.log(`[+] Backup posted to Discord.`);
  } catch (e) {
    console.error(`❌ Discord post failed: ${e.message}`);
    return;
  }

  // Cleanup
  try {
    fs.unlinkSync(filepath); // delete .sql
  } catch (err) {
    console.warn(`⚠️ Could not delete raw SQL file: ${err.message}`);
  }

  const now = Date.now();
  const cutoff = 3 * 24 * 60 * 60 * 1000;

  fs.readdirSync(BACKUP_DIR).forEach(file => {
    const fullPath = path.join(BACKUP_DIR, file);
    const stats = fs.statSync(fullPath);
    if (now - stats.mtimeMs > cutoff) {
      fs.unlinkSync(fullPath);
      console.log(`[+] Deleted old backup: ${file}`);
    }
  });
}


module.exports = runBackup;

if (require.main === module) {
  // 👇 Add this again to ensure it's loaded in direct runs
  require('dotenv').config();

  const { Client, GatewayIntentBits } = require('discord.js');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once('ready', async () => {
    console.log(`✅ Connected as ${client.user.tag}`);
    await runBackup(client);
    client.destroy(); // Close the bot after uploading
  });

  client.login(process.env.DISCORD_TOKEN);
}

