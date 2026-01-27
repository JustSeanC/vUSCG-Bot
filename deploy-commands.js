const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
  new SlashCommandBuilder()
  .setName('activate')
  .setDescription('Activate a user and open a training thread')
  .addIntegerOption(option =>
    option.setName('pilot_id')
      .setDescription('Pilot ID (e.g., 1234)')
      .setRequired(true)
  )
  .addUserOption(option =>
    option.setName('user')
      .setDescription('Discord user to activate')
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName('notes')
      .setDescription('Optional notes (e.g., "Needs Stage 0, hours show 55")')
      .setRequired(false)
  )
  .toJSON(),

new SlashCommandBuilder()
  .setName('moveaircraft')
  .setDescription('Move an aircraft to a new current location (command staff only)')
  .addStringOption(option =>
    option.setName('registration')
      .setDescription('Aircraft registration (e.g., C6052)')
      .setRequired(true))
  .addStringOption(option =>
    option.setName('airport')
      .setDescription('New current location ICAO (e.g., KPIE)')
      .setRequired(true))
  .addStringOption(option =>
     option.setName('status')
    .setDescription('Optional new aircraft status')
    .setRequired(false)
    .addChoices(
      { name: 'Active (A)', value: 'A' },
      { name: 'Maintenance (M)', value: 'M' },
      { name: 'Stored (S)', value: 'S' },
      { name: 'Retired (R)', value: 'R' },
      { name: 'Scrapped (C)', value: 'C' },
    )
)

  .addStringOption(option =>
    option.setName('reason')
      .setDescription('Reason for move (optional)')
      .setRequired(false))
  .toJSON(),
  new SlashCommandBuilder()
    .setName('promote')
    .setDescription('Promote a user to vUSCG Pilot and assign a track')
    .addIntegerOption(option =>
      option.setName('pilot_id')
        .setDescription('Pilot ID (e.g., 3020)')
        .setRequired(true)
    )
    .addUserOption(option =>
      option.setName('user')
        .setDescription('Discord user to promote')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('track')
        .setDescription('Select training track')
        .setRequired(true)
        .addChoices(
          { name: 'Rotary Wing', value: 'rotary' },
          { name: 'Fixed Wing', value: 'fixed' }
        )
    )
    .toJSON(),
new SlashCommandBuilder()
  .setName('mission')
  .setDescription('Generate a mission based on type, aircraft, and optional base')
  .addStringOption(option =>
    option.setName('type')
      .setDescription('Select mission type')
      .setRequired(true)
      .addChoices(
        { name: 'Search and Rescue (SAR)', value: 'SAR' },
        { name: 'Law Enforcement (LE)', value: 'LE' },
        { name: 'Maritime Security Patrol (MSP)', value: 'MSP' },
        { name: 'Drug Interdiction (HITRON)', value: 'HITRON' },
        { name: 'Environmental Patrol (EP)', value: 'EP' },
        { name: 'Medical Evacuation (ME)', value: 'ME' },
        { name: 'Repositioning (R)', value: 'R' },
        { name: 'Training (T)', value: 'T' }
      )
  )
  .addStringOption(option =>
    option.setName('aircraft')
      .setDescription('Select aircraft type')
      .setRequired(true)
      .addChoices(
        { name: 'AS65 (MH65)', value: 'AS65' },
        { name: 'H60 (MH60)', value: 'H60' },
        { name: 'C27J', value: 'C27J' },
        { name: 'CN35', value: 'CN35' },
        { name: 'C30J', value: 'C30J' }
      )
  )
  .addStringOption(option =>
    option.setName('base')
      .setDescription('Optional base airport ICAO (e.g., KVQQ)')
      .setRequired(false)
  )
  .addStringOption(option =>
    option.setName('duration')
      .setDescription('Approximate mission duration')
      .setRequired(false)
      .addChoices(
        { name: 'Short', value: 'short' },
        { name: 'Medium', value: 'medium' },
        { name: 'Long', value: 'long' }
      )
  )
  .toJSON(),

new SlashCommandBuilder()
  .setName('jumpseat')
  .setDescription('Jumpseat yourself to another airport (updates your current location)')
  .addStringOption(option =>
    option.setName('airport')
      .setDescription('Destination ICAO (must exist in phpVMS airports table)')
      .setRequired(true)
  )
  .toJSON(),
  new SlashCommandBuilder()
    .setName('location')
    .setDescription('Get aircraft info by Registration, Type, or Airport ID')
    .addStringOption(option =>
      option.setName('search')
        .setDescription('Enter Registration (C6532), Type (C30J), or Airport ID (KFMH)')
        .setRequired(true)
    )
    .toJSON(),

    new SlashCommandBuilder()
  .setName('forceranksync')
  .setDescription('Force recalculation of all pilot ranks based on hours (Admin only)')
  .toJSON(),

];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered.');
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }
})();
