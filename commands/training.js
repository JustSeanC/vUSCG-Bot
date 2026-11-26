const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const service = require('../utils/training/service');
const {
  TrainingError, OUTCOMES, TEXT_LIMIT, code, text,
} = require('../utils/training/validation');
const {
  noMentions, safe, pilotLabel, checkRate, confirm, progressEmbed, historyEmbed, postTrainingUpdate, HISTORY_PAGE_SIZE,
} = require('../utils/training/discord');

const pilotOption = (option, required = true) => option.setName('pilot_id').setDescription('Public pilot number, for example 3250')
  .setMinValue(1).setMaxValue(999999999999999).setRequired(required);
const trackOption = option => option.setName('track').setDescription('Training program ID, such as rw or fw')
  .setMaxLength(32).setRequired(true);
const pageOption = option => option.setName('page').setDescription('Page to display (default 1)')
  .setMinValue(1).setMaxValue(100000);

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
    .addStringOption(o => o.setName('reason').setDescription('Reason for voiding the record').setMaxLength(TEXT_LIMIT).setRequired(true)));

function canUse(action, targeted, hasRole, roles) {
  const command = Boolean(roles.COMMAND_STAFF_ROLE_ID && hasRole(roles.COMMAND_STAFF_ROLE_ID));
  const instructor = Boolean(roles.INSTRUCTOR_PILOT_ROLE_ID && hasRole(roles.INSTRUCTOR_PILOT_ROLE_ID));
  if (action === 'void' || action === 'enroll') return command;
  if (action === 'record' || action === 'pilot' || (action === 'history' && targeted)) return command || instructor;
  return action === 'progress' || action === 'history';
}

async function confirmedActor({ interaction, db, roles }, action, summary, original, label) {
  if (!(await confirm(interaction, summary, label))) return null;
  const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
  if (!canUse(action, true, roleId => member.roles.cache.has(roleId), roles)) {
    throw new TrainingError('Your training staff permissions could not be confirmed.');
  }
  const pilot = await service.linkedPilot(db, interaction);
  if (String(pilot.id) !== String(original.id) || String(pilot.pilot_id) !== String(original.pilot_id)) {
    throw new TrainingError('Your linked pilot account changed. Run the command again.');
  }
  return { discordId: interaction.user.id, pilotId: pilot.pilot_id };
}

async function record(ctx, staffPilot, pilotId) {
  const { db, interaction } = ctx;
  const options = interaction.options;
  const { pilot, lesson, data } = await service.previewEvaluation(db, pilotId, {
    programId: options.getString('track'),
    lessonId: options.getString('lesson'),
    outcome: options.getString('result'),
    date: options.getString('date'),
    comments: options.getString('comments'),
  });
  const repeat = options.getBoolean('repeat') === true;
  const summary = new EmbedBuilder().setTitle('Confirm training attempt').setDescription([
    pilotLabel(pilot),
    `${safe(lesson.program_name)} · ${safe(lesson.name)} (${data.lessonId})`,
    `${OUTCOMES[data.outcome]} · ${data.date} · Instructor C${staffPilot.pilot_id}`,
    data.comments ? `Comments: ${safe(data.comments)}` : '',
    repeat ? 'An identical attempt may be saved as an intentional repeat.' : '',
  ].filter(Boolean).join('\n'));
  const actor = await confirmedActor(ctx, 'record', summary, staffPilot, 'Save attempt');
  if (!actor) return;

  const current = await service.findPilot(db, pilotId);
  if (current.id !== pilot.id) throw new TrainingError('The target pilot mapping changed. Run the command again.');
  const prepared = service.prepareRecord(current, data, { source: 'manual', actor, interactionId: interaction.id });
  const saved = await service.createRecord(db, prepared, { allowRepeat: repeat });
  const content = saved.created ? `Saved training record \`${saved.recordId}\`.`
    : `This interaction already saved \`${saved.recordId}\`${saved.voided ? ' (now voided)' : ''}.`;

  let tracks;
  try {
    tracks = await service.progress(db, pilot.id);
  } catch {
    // A committed training record remains authoritative if a follow-up query fails.
  }
  const track = tracks?.find(item => item.id === data.programId);
  const counts = track ? ` ${track.completed.length}/${track.completed.length + track.remaining.length} configured lessons passed in ${safe(track.name)}.`
    : ' Use /training pilot to refresh progress.';
  try {
    await interaction.editReply({ content: content + counts, allowedMentions: noMentions });
  } finally {
    if (saved.created) {
      const traineeDiscordId = await service.linkedDiscordForPilot(db, pilot.pilot_id).catch(() => null);
      await postTrainingUpdate(interaction.guild, { pilot, lesson, data, actor, track, traineeDiscordId });
    }
  }
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
      : progressEmbed(pilot, await service.progress(db, pilot.id), page);
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
