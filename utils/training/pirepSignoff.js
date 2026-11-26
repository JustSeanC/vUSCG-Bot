const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { validPirepId } = require('../pirepBridge');
const service = require('./service');
const { OUTCOMES, TEXT_LIMIT, TrainingError } = require('./validation');
const { noMentions, pilotLabel, checkRate } = require('./discord');
const { canUse, saveSignoff } = require('./signoff');

const PAGE_SIZE = 25;
const STEP_TIMEOUT = 60_000;

async function choose(interaction, session, step, title, options, { modal = false } = {}) {
  let page = 0;
  const id = `training:${interaction.id}:${step}`;
  while (true) {
    const time = Math.min(STEP_TIMEOUT, session.expires - Date.now());
    if (time <= 0) throw new TrainingError('This training form expired. Open Record Training again.');
    const start = page * PAGE_SIZE;
    const choices = options.slice(start, start + PAGE_SIZE).map((option, index) => ({
      label: option.name.slice(0, 100), value: String(start + index),
    }));
    const select = new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(title).addOptions(choices);
    const components = [new ActionRowBuilder().addComponents(select)];
    if (options.length > PAGE_SIZE) {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id + ':prev').setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(id + ':next').setLabel('Next').setStyle(ButtonStyle.Secondary)
          .setDisabled(start + PAGE_SIZE >= options.length),
      ));
    }
    const message = await interaction.editReply({
      content: `${session.header}\n${title}${options.length > PAGE_SIZE ? ` (page ${page + 1})` : ''}`,
      allowedMentions: noMentions,
      components,
    });
    const click = await message.awaitMessageComponent({
      time,
      filter: event => session.owns(event) && (
        (event.isStringSelectMenu() && event.customId === id && event.values.length === 1 &&
          choices.some(choice => choice.value === event.values[0])) ||
        (event.isButton() && ((event.customId === id + ':prev' && page > 0) ||
          (event.customId === id + ':next' && start + PAGE_SIZE < options.length)))
      ),
    });
    if (!modal || click.isButton()) await click.deferUpdate();
    if (click.isStringSelectMenu()) return { choice: options[Number(click.values[0])], click };
    page += click.customId.endsWith(':next') ? 1 : -1;
  }
}

async function collectDetails(interaction, session, click) {
  const id = `training:${interaction.id}:details`;
  const date = new TextInputBuilder().setCustomId('date').setLabel('Training date YYYY-MM-DD (optional)')
    .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10)
    .setPlaceholder(new Date().toISOString().slice(0, 10));
  const comments = new TextInputBuilder().setCustomId('comments').setLabel('Private instructor comments (optional)')
    .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(TEXT_LIMIT);
  await click.showModal(new ModalBuilder().setTitle('Training evaluation details').setCustomId(id)
    .addComponents(new ActionRowBuilder().addComponents(date), new ActionRowBuilder().addComponents(comments)));
  const submitted = await click.awaitModalSubmit({ time: STEP_TIMEOUT, filter: event => session.owns(event) && event.customId === id });
  await submitted.deferUpdate();
  return {
    date: submitted.fields.getTextInputValue('date').trim() || null,
    comments: submitted.fields.getTextInputValue('comments'),
  };
}

async function handlePirepTraining({ interaction, db, roles }) {
  const reply = content => interaction.reply({ content, ephemeral: true, allowedMentions: noMentions });
  if (!interaction.inGuild() || !process.env.GUILD_ID || interaction.guildId !== process.env.GUILD_ID) {
    return reply('Training is available only in the configured vUSCG server.');
  }
  const id = interaction.customId.slice('pirep-training:'.length);
  const footer = interaction.message.embeds?.[0]?.footer?.text;
  if (!validPirepId(id) || interaction.message.author?.id !== interaction.client.user?.id ||
      !(footer === `PIREP: ${id}` || footer?.startsWith(`PIREP: ${id} • Reviewed by `))) {
    return reply('This training button is not attached to the matching PIREP review.');
  }

  try {
    await interaction.deferReply({ ephemeral: true });
    const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
    if (!canUse('record', true, roleId => member.roles.cache.has(roleId), roles)) {
      throw new TrainingError('You do not have permission to record training.');
    }
    checkRate(interaction.user.id);
    const staffPilot = await service.linkedPilot(db, interaction);
    const pilot = await service.acceptedPilot(db, id);
    const programs = (await service.progress(db, pilot.id)).filter(track => track.active && (track.completed.length || track.remaining.length));
    if (!programs.length) throw new TrainingError('The pilot needs an active training enrollment with eligible lessons.');

    const session = {
      header: `${pilotLabel(pilot)} · PIREP \`${id}\``,
      expires: Date.now() + 4 * STEP_TIMEOUT,
      owns: event => event.user.id === interaction.user.id && event.guildId === interaction.guildId,
    };
    const { choice: program } = await choose(interaction, session, 'program', 'Choose a program', programs);
    const { choice: lesson } = await choose(interaction, session, 'lesson', 'Choose a lesson', [...program.remaining, ...program.completed]);
    const outcomes = Object.entries(OUTCOMES).map(([outcome, name]) => ({ outcome, name }));
    const { choice, click } = await choose(interaction, session, 'outcome', 'Choose an evaluation outcome', outcomes, { modal: true });
    const details = await collectDetails(interaction, session, click);
    if (Date.now() > session.expires) throw new TrainingError('This training form expired. Open Record Training again.');
    const preview = await service.previewEvaluation(db, pilot.pilot_id, {
      programId: program.id, lessonId: lesson.id, outcome: choice.outcome, pirepId: id, ...details,
    });
    if (preview.pilot.id !== pilot.id) throw new TrainingError('The PIREP pilot changed. Open Record Training again.');
    await saveSignoff({ interaction, db, roles }, staffPilot, preview);
  } catch (error) {
    const content = error.code === 'InteractionCollectorError' ? 'This training form expired. Open Record Training again.'
      : error instanceof TrainingError ? error.message
      : 'Training could not complete. Check training history before retrying a submission.';
    if (!(error instanceof TrainingError) && error.code !== 'InteractionCollectorError') {
      console.warn('PIREP training failed:', error.code || error.name);
    }
    if (!interaction.deferred && !interaction.replied) return reply(content);
    await interaction.editReply({ content, embeds: [], components: [], allowedMentions: noMentions });
  }
}

module.exports = { handlePirepTraining };
