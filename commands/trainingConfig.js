const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { linkedPilot } = require('../utils/training/service');
const { canUse, confirmedActor } = require('../utils/training/signoff');
const { category, listResources, prepareResource, changeResource } = require('../utils/training/materials');
const { noMentions, safe, checkRate } = require('../utils/training/discord');
const { TrainingError } = require('../utils/training/validation');

const categoryOption = o => o.setName('category').setDescription('Resource category code').setMaxLength(32).setRequired(true);
const idOption = o => o.setName('resource_id').setDescription('Persistent resource UUID').setMinLength(36).setMaxLength(36).setRequired(true);
const properties = (sub, required) => sub
  .addStringOption(o => o.setName('title').setDescription('Document title').setMaxLength(100).setRequired(required))
  .addStringOption(o => o.setName('url').setDescription('HTTPS document or folder link').setMaxLength(1000).setRequired(required))
  .addStringOption(o => o.setName('description').setDescription('Optional description').setMaxLength(400))
  .addIntegerOption(o => o.setName('order').setDescription('Lower display orders appear first (default 0)').setMinValue(0).setMaxValue(65535));

const definition = new SlashCommandBuilder().setName('training-config').setDescription('Manage and view the staff training resource catalog')
  .addSubcommand(sub => sub.setName('add-category').setDescription('Command Staff: add a resource category')
    .addStringOption(categoryOption)
    .addStringOption(o => o.setName('title').setDescription('Category display name').setRequired(true).setMaxLength(80)))
  .addSubcommand(sub => properties(sub.setName('add-link').setDescription('Command Staff: add a training resource').addStringOption(categoryOption), true))
  .addSubcommand(sub => properties(sub.setName('edit-link').setDescription('Command Staff: edit or reorder a training resource').addStringOption(idOption), false)
    .addBooleanOption(o => o.setName('active').setDescription('Enable or deactivate this resource')))
  .addSubcommand(sub => sub.setName('remove-link').setDescription('Command Staff: deactivate a resource and retain its history').addStringOption(idOption))
  .addSubcommand(sub => sub.setName('links').setDescription('Staff: view configured links').addStringOption(categoryOption)
    .addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(10000)));

async function execute(ctx) {
  const { interaction, db, roles, hasRole } = ctx;
  const reply = content => interaction.reply({ content, ephemeral: true, allowedMentions: noMentions });
  if (!interaction.inGuild() || interaction.guildId !== process.env.GUILD_ID) return reply('Use this command inside the configured vUSCG server.');
  const options = interaction.options;
  const command = options.getSubcommand();
  const action = command === 'links' ? 'pilot' : 'configure';
  if (!canUse(action, true, hasRole, roles)) return reply('You do not have permission to use this training configuration action.');
  try {
    checkRate(interaction.user.id);
    await interaction.deferReply({ ephemeral: true });
    const staff = await linkedPilot(db, interaction);
    if (command === 'links') {
      const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
      if (!canUse('pilot', true, id => member.roles.cache.has(id), roles)) throw new TrainingError('Staff permissions could not be verified.');
      const meta = await category(db, options.getString('category'));
      const page = options.getInteger('page') ?? 1;
      if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new TrainingError('Invalid page number.');
      const rows = await listResources(db, meta.category_id, {
        includeInactive: canUse('configure', true, id => member.roles.cache.has(id), roles), limit: 3, offset: (page - 1) * 2,
      });
      const embed = new EmbedBuilder().setTitle(`Training links · ${safe(meta.name)}`);
      for (const row of rows.slice(0, 2)) {
        embed.addFields({ name: `${row.display_order} · ${safe(row.title)}`, value: `<${row.url}>` });
        embed.addFields({ name: 'Resource', value: `${row.resource_id} · ${row.active ? 'Active' : 'Inactive'}` });
        if (row.description) embed.addFields({ name: 'Description', value: safe(row.description) });
      }
      if (!rows.length) embed.setDescription('No links on this page.');
      embed.setFooter({ text: `Page ${page}${rows.length > 2 ? ` · Use page:${page + 1} for more` : ''}` });
      return await interaction.editReply({ embeds: [embed], allowedMentions: noMentions });
    }

    const change = { 'add-category': 'add_category', 'add-link': 'add_link', 'edit-link': 'edit_link', 'remove-link': 'deactivate_link' }[command];
    const prepared = prepareResource(change, {
      categoryId: options.getString('category'), resourceId: options.getString('resource_id')?.toLowerCase(),
      title: options.getString('title'), url: options.getString('url'), description: options.getString('description'),
      order: options.getInteger('order'), active: options.getBoolean('active'),
    });
    const { changes = {} } = prepared;
    const summary = new EmbedBuilder().setTitle(`Confirm ${command.replace('-', ' ')}`).setDescription([
      prepared.categoryId ?? prepared.resourceId,
      prepared.name && safe(prepared.name),
      changes.title && safe(changes.title),
      changes.url && `<${changes.url}>`,
      changes.description != null && `Description: ${safe(changes.description) || '(empty)'}`,
      changes.display_order != null && `Display order: ${changes.display_order}`,
      changes.active != null && (changes.active ? 'Active' : 'Inactive'),
    ].filter(Boolean).join('\n'));
    const actor = await confirmedActor(ctx, 'configure', summary, staff, 'Save configuration');
    if (!actor) return;
    const saved = await changeResource(db, { action: change, prepared, actor, interactionId: interaction.id });
    await interaction.editReply({ content: `Saved training configuration. ID: \`${saved.resource_id ?? saved.category_id}\`.`, allowedMentions: noMentions });
  } catch (error) {
    if (!(error instanceof TrainingError)) console.warn('Training configuration failed:', error.code || error.name);
    await interaction.editReply({ content: error instanceof TrainingError ? error.message : 'Training configuration is unavailable. Verify migration 008 and try again.',
      components: [], embeds: [], allowedMentions: noMentions });
  }
}

module.exports = { name: 'training-config', definition, execute };
