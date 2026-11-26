const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const service = require('../utils/training/service');
const qualifications = require('../utils/training/qualifications');
const { showDashboard } = require('../utils/training/dashboardDiscord');
const { canUse, confirmedActor, saveSignoff } = require('../utils/training/signoff');
const {
  TrainingError, OUTCOMES, TEXT_LIMIT, code, text,
} = require('../utils/training/validation');
const {
  noMentions, safe, pilotLabel, checkRate, progressEmbed, historyEmbed, HISTORY_PAGE_SIZE,
} = require('../utils/training/discord');

const pilotOption = (option, required = true) => option.setName('pilot_id').setDescription('Public pilot number, for example 3250')
  .setMinValue(1).setMaxValue(999999999999999).setRequired(required);
const trackOption = option => option.setName('track').setDescription('Training program ID, such as rw or fw')
  .setMaxLength(32).setRequired(true);
const pageOption = option => option.setName('page').setDescription('Page to display (default 1)')
  .setMinValue(1).setMaxValue(100000);

const dateOptions = sub => sub
  .addStringOption(o => o.setName('start').setDescription('Start date YYYY-MM-DD, inclusive').setMaxLength(10))
  .addStringOption(o => o.setName('end').setDescription('End date YYYY-MM-DD, inclusive').setMaxLength(10));

const definition = new SlashCommandBuilder()
  .setName('training').setDescription('Record and view vUSCG training')
  .addSubcommand(sub => sub.setName('record').setDescription('Instructor or Command Staff: record a training attempt')
    .addIntegerOption(o => pilotOption(o))
    .addStringOption(trackOption)
    .addStringOption(o => o.setName('lesson').setDescription('Lesson ID, such as flight-4').setMaxLength(32).setRequired(true))
    .addStringOption(o => o.setName('result').setDescription('Evaluation outcome').setRequired(true)
      .addChoices(...Object.entries(OUTCOMES).map(([value, name]) => ({ name, value }))))
    .addStringOption(o => o.setName('comments').setDescription('Private instructor comments').setMaxLength(TEXT_LIMIT))
    .addStringOption(o => o.setName('date').setDescription('Training date YYYY-MM-DD (default today UTC)').setMaxLength(10))
    .addStringOption(o => o.setName('pirep_id').setDescription('Optional accepted PIREP ID for this pilot').setMaxLength(64))
    .addBooleanOption(o => o.setName('repeat').setDescription('Allow an intentional repeat of an otherwise identical attempt')))
  .addSubcommand(sub => sub.setName('progress').setDescription('View your own training progress').addIntegerOption(pageOption))
  .addSubcommand(sub => sub.setName('pilot').setDescription('Instructor or Command Staff: view a pilot’s progress')
    .addIntegerOption(o => pilotOption(o)).addIntegerOption(pageOption))
  .addSubcommand(sub => sub.setName('history').setDescription('View training attempts, including voided records')
    .addIntegerOption(o => pilotOption(o, false)).addIntegerOption(pageOption))
  .addSubcommand(sub => sub.setName('enroll').setDescription('Command Staff: start, resume, or pause a training enrollment')
    .addIntegerOption(o => pilotOption(o))
    .addStringOption(trackOption)
    .addBooleanOption(o => o.setName('active').setDescription('True to start or resume (default), false to pause')))
  .addSubcommand(sub => sub.setName('void').setDescription('Command Staff: void a training record and retain its audit history')
    .addStringOption(o => o.setName('record_id').setDescription('Training record UUID').setMinLength(36).setMaxLength(36).setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for voiding the record').setMaxLength(TEXT_LIMIT).setRequired(true)))
  .addSubcommand(sub => sub.setName('roster').setDescription('Staff: browse enrolled pilots and follow-up indicators')
    .addStringOption(o => o.setName('track').setDescription('Optional training program code').setMaxLength(32))
    .addStringOption(o => o.setName('status').setDescription('Filter enrollment status')
      .addChoices({ name: 'Active', value: 'active' }, { name: 'Paused or unavailable', value: 'paused' }))
    .addIntegerOption(pageOption))
  .addSubcommand(sub => dateOptions(sub.setName('stats').setDescription('Staff: view training and qualification statistics')))
  .addSubcommand(sub => dateOptions(sub.setName('instructors').setDescription('Staff: view verified instructor activity'))
    .addIntegerOption(pageOption));

async function record(ctx, staffPilot, pilotId) {
  const { db, interaction } = ctx;
  const options = interaction.options;
  const preview = await service.previewEvaluation(db, pilotId, {
    programId: options.getString('track'),
    lessonId: options.getString('lesson'),
    outcome: options.getString('result'),
    date: options.getString('date'),
    comments: options.getString('comments'),
    pirepId: options.getString('pirep_id'),
  });
  return saveSignoff(ctx, staffPilot, { ...preview, repeat: options.getBoolean('repeat') === true });
}

async function enroll(ctx, staffPilot, pilotId) {
  const { db, interaction } = ctx;
  const programId = code(interaction.options.getString('track'), 'program');
  const active = interaction.options.getBoolean('active') ?? true;
  const pilot = await service.findPilot(db, pilotId);
  const program = await service.getProgram(db, programId);
  const summary = new EmbedBuilder().setTitle('Confirm training enrollment')
    .setDescription(`${pilotLabel(pilot)} · ${safe(program.name)} · ${active ? 'Start or resume' : 'Pause'}`);
  const actor = await confirmedActor(ctx, 'enroll', summary, staffPilot);
  if (!actor) return;
  const current = await service.findPilot(db, pilotId);
  if (current.id !== pilot.id) throw new TrainingError('The target pilot mapping changed. Run the command again.');
  await service.setEnrollment(db, { userId: pilot.id, programId, active, actor });
  await interaction.editReply({
    content: `C${pilot.pilot_id}’s ${safe(program.name)} enrollment is ${active ? 'active' : 'paused'}.`,
    allowedMentions: noMentions,
  });
}

async function correct(ctx, staffPilot) {
  const { db, interaction } = ctx;
  const id = interaction.options.getString('record_id')?.toLowerCase();
  const reason = text(interaction.options.getString('reason'), 'Correction reason', true);
  const target = await service.getRecord(db, id);
  if (target.voided_at) throw new TrainingError('That training record is already voided.');
  const summary = new EmbedBuilder().setTitle('Confirm voiding training record').setDescription([
    `C${target.public_pilot_id} · ${safe(target.program_name)} · ${safe(target.lesson_name)}`,
    `${target.training_date} · ${OUTCOMES[target.outcome]} · \`${id}\``,
    `Reason: ${safe(reason)}`,
    'The original entry stays in history and is excluded from progress.',
  ].join('\n'));
  const actor = await confirmedActor(ctx, 'void', summary, staffPilot, 'Void record');
  if (!actor) return;
  const changed = await service.voidRecord(db, { id, reason, actor, interactionId: interaction.id });
  let detail = '';
  if (changed) {
    try {
      const items = await service.progress(db, target.user_id);
      const track = items.find(item => item.id === target.program_id);
      if (track) detail = ` ${track.completed.length}/${track.completed.length + track.remaining.length} configured lessons passed.`;
    } catch {
      detail = ' Use /training pilot to refresh progress.';
    }
  }
  await interaction.editReply({
    content: `Record \`${id}\` ${changed ? 'voided' : 'was already voided'}.${detail}`, allowedMentions: noMentions,
  });
}

async function execute(ctx) {
  const { interaction, db, roles, hasRole } = ctx;
  const reply = content => interaction.reply({ content, ephemeral: true, allowedMentions: noMentions });
  if (!interaction.inGuild() || !process.env.GUILD_ID || interaction.guildId !== process.env.GUILD_ID) {
    return reply('Training commands are available only inside the configured vUSCG server.');
  }
  const action = interaction.options.getSubcommand();
  const pilotId = interaction.options.getInteger('pilot_id');
  if (!canUse(action, pilotId != null, hasRole, roles)) return reply('You do not have permission to use that training command.');

  try {
    checkRate(interaction.user.id);
    await interaction.deferReply({ ephemeral: true });
    if (['roster', 'stats', 'instructors'].includes(action)) return await showDashboard(ctx, action);
    if (['record', 'enroll', 'void'].includes(action)) {
      const staffPilot = await service.linkedPilot(db, interaction);
      if (action === 'record') return await record(ctx, staffPilot, pilotId);
      if (action === 'enroll') return await enroll(ctx, staffPilot, pilotId);
      return await correct(ctx, staffPilot);
    }
    const pilot = action === 'progress' || pilotId == null
      ? await service.linkedPilot(db, interaction)
      : await service.findPilot(db, pilotId);
    const page = interaction.options.getInteger('page') ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new TrainingError('Enter a valid page number.');
    const embed = action === 'history'
      ? historyEmbed(pilot, await service.history(db, pilot.id, HISTORY_PAGE_SIZE + 1, (page - 1) * HISTORY_PAGE_SIZE), page)
      : progressEmbed(pilot, await service.progress(db, pilot.id), page, await qualifications.activeAwards(db, pilot.id));
    await interaction.editReply({ embeds: [embed], allowedMentions: noMentions });
  } catch (error) {
    const content = error instanceof TrainingError ? error.message
      : error.code === 'ER_NO_SUCH_TABLE' ? 'Training storage is unavailable. Ask Command Staff to check the database migration.'
      : 'Training could not complete. Check training history or enrollment status before retrying a change.';
    if (!(error instanceof TrainingError)) console.warn('Training command failed:', error.code || error.name);
    if (!interaction.deferred && !interaction.replied) return reply(content);
    await interaction.editReply({ content, embeds: [], components: [], allowedMentions: noMentions });
  }
}

module.exports = { name: 'training', definition, execute, canUse };
