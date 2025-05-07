const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
require('dotenv').config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const BACKUP_DIR = path.join(__dirname, 'backups');
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME;
const DB_HOST = process.env.DB_HOST;
const CHANNEL_ID = process.env.DB_BACKUP_ID;
const BOT_TOKEN = process.env.DISCORD_TOKEN;

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

client.once('ready', async () => {
  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `${DB_NAME}_${timestamp}.sql`;
  const filepath = path.join(BACKUP_DIR, filename);
  const zipFilePath = `${filepath}.zip`;

  console.log(`[+] Starting backup for tables: aircraft, pireps, users`);

  const dumpCmd = `mysqldump -h ${DB_HOST} -u ${DB_USER} -p${DB_PASS} ${DB_NAME} aircraft pireps users > ${filepath}`;
  exec(dumpCmd, (err) => {
    if (err) {
      console.error(`Backup failed: ${err.message}`);
      client.destroy();
      return;
    }

    console.log(`[+] SQL backup saved: ${filename}`);

    const zipCmd = `zip -j ${zipFilePath} ${filepath}`;
    exec(zipCmd, async (zipErr) => {
      if (zipErr) {
        console.error(`ZIP failed: ${zipErr.message}`);
        client.destroy();
        return;
      }

      console.log(`[+] Backup zipped: ${zipFilePath}`);

      try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        const file = new AttachmentBuilder(zipFilePath);
        await channel.send({
          content: `Backup for **${timestamp}** (Tables: aircraft, pireps, users)`,
          files: [file],
        });
        console.log(`[+] Backup posted to Discord.`);
      } catch (e) {
        console.error(`Discord post failed: ${e.message}`);
      }

      fs.unlinkSync(filepath); // Delete raw .sql file

      // Delete old backups (older than 3 days)
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

      client.destroy();
    });
  });
});

client.login(BOT_TOKEN);
