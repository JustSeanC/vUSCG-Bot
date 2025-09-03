const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
  new SlashCommandBuilder()
    .setName('activate')
    .setDescription('Activate a user by pilot ID and assign roles')
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
        { name: 'C130', value: 'C130' },
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
    .setName('location')
    .setDescription('Get aircraft info by Registration, Type, or Airport ID')
    .addStringOption(option =>
      option.setName('search')
        .setDescription('Enter Registration (N1234), Type (C208), or Airport ID (KJFK)')
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('atc')
    .setDescription('Check online ATC at a given airport (VATSIM)')
    .addStringOption(option =>
      option.setName('airport')
        .setDescription('Enter ICAO code (e.g., KATL, KLAX)')
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
