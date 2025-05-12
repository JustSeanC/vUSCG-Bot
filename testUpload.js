const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
require('dotenv').config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`✅ Connected as ${client.user.tag}`);

  const channel = await client.channels.fetch(process.env.DB_BACKUP_ID);

  const file = new AttachmentBuilder(fs.readFileSync('./testfile.txt'), {
    name: 'testfile.txt',
  });

  await channel.send({
    content: '🧪 Test file upload',
    files: [file],
  });

  console.log('✅ Test file sent!');
  client.destroy();
});

client.login(process.env.DISCORD_TOKEN);
