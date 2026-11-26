const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, escapeMarkdown } = require('discord.js');
const { OUTCOMES, TrainingError } = require('./validation');

const noMentions = { parse: [], repliedUser: false };
const safe = value => escapeMarkdown(String(value ?? '')).replace(/@/g, '@\u200b');
const pilotLabel = pilot => `C${pilot.pilot_id} — ${safe(pilot.name).slice(0, 120)}`;
const HISTORY_PAGE_SIZE = 3;
const PROGRESS_PAGE_SIZE = 12;
const total = track => track.completed.length + track.remaining.length;
const completion = (passed, count) => count ? `${Math.floor(passed / count * 100)}%` : 'unavailable';
const recentCommands = new Map();

function checkRate(userId) {
  const now = Date.now();
  if (recentCommands.size >= 2048) {
    for (const [id, expires] of recentCommands) {
      if (expires <= now) recentCommands.delete(id);
    }
  }
  if ((recentCommands.get(userId) ?? 0) > now || recentCommands.size >= 2048) {
    throw new TrainingError('Please wait a moment before using another training command.');
  }
  recentCommands.set(userId, now + 2000);
}

async function confirm(interaction, summary, label = 'Confirm') {
  const customId = `training:${interaction.id}`;
  const acceptId = `${customId}:confirm`;
  const cancelId = `${customId}:cancel`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(acceptId).setLabel(label).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
  const message = await interaction.editReply({
    embeds: [summary], components: [row], allowedMentions: noMentions,
  });
  let click;
  try {
    click = await message.awaitMessageComponent({
      time: 60_000,
      filter: button => button.isButton() && button.user.id === interaction.user.id &&
        button.guildId === interaction.guildId && [acceptId, cancelId].includes(button.customId),
    });
  } catch (error) {
    if (error.code !== 'InteractionCollectorError') throw error;
    await interaction.editReply({ content: 'Confirmation expired. No training change was submitted.', embeds: [], components: [] });
    return false;
  }
  await click.deferUpdate();
  const accepted = click.customId === acceptId;
  await interaction.editReply({
    content: accepted ? 'Saving training change…' : 'Cancelled. No training change was submitted.',
    embeds: [],
    components: [],
  });
  return accepted;
}

function progressEmbed(pilot, tracks, page) {
  const active = tracks.filter(track => track.active);
  const embed = new EmbedBuilder().setTitle(`Training progress · ${pilotLabel(pilot)}`);
  if (!tracks.length) return embed.setDescription('No training enrollments.');
  const pages = tracks.flatMap(track => {
    const lessons = [
      ...track.completed.map(lesson => ({ ...lesson, done: true })),
      ...track.remaining,
    ];
    if (!lessons.length) return [{ track, lessons }];
    const chunks = [];
    for (let start = 0; start < lessons.length; start += PROGRESS_PAGE_SIZE) {
      chunks.push({ track, lessons: lessons.slice(start, start + PROGRESS_PAGE_SIZE) });
    }
    return chunks;
  });
  const current = pages[page - 1];
  if (!current) throw new TrainingError(`Training progress has ${pages.length} page(s).`);
  const { track, lessons } = current;
  const allDone = active.reduce((sum, item) => sum + item.completed.length, 0);
  const allCount = active.reduce((sum, item) => sum + total(item), 0);
  const overall = active.every(item => item.curriculumComplete && total(item))
    ? completion(allDone, allCount)
    : 'unavailable while an active curriculum is incomplete';
  const lastSignoff = track.lastSignoffDate
    ? `${track.lastSignoffDate} UTC · ${safe(track.lastLesson)} · ${OUTCOMES[track.lastOutcome]} · C${track.lastInstructor}${track.lastSource === 'import' ? ' (historical)' : ''}`
    : 'None';
  return embed
    .setDescription([
      `**${safe(track.name)} (${safe(track.id)})** · ${track.active ? 'Active' : 'Inactive'}`,
      `${track.completed.length}/${total(track)} configured lessons passed`,
      `Program completion: ${track.curriculumComplete ? completion(track.completed.length, total(track)) : 'unavailable while the curriculum is incomplete'}`,
      `Active enrollments: ${active.length} · Overall: ${allDone}/${allCount} configured lessons · ${overall}`,
      `Most recent signoff entered: ${lastSignoff}`,
      `Most recent training date: ${track.lastTrainingDate ?? 'None'}`,
      `Next incomplete configured lesson: ${track.remaining[0] ? safe(track.remaining[0].name) : 'None'}`,
      '',
      ...lessons.map(lesson => `${lesson.done ? 'Passed' : 'Remaining'} · ${safe(lesson.name)} (${safe(lesson.id)})`),
    ].join('\n'))
    .setFooter({ text: `Page ${page}/${pages.length} · Use the page option to browse programs or lessons` });
}

function historyEmbed(pilot, rows, page) {
  const embed = new EmbedBuilder().setTitle(`Training history · ${pilotLabel(pilot)}`)
    .setDescription('Attempts are listed newest training date first. Voided attempts do not contribute to progress.');
  for (const row of rows.slice(0, HISTORY_PAGE_SIZE)) {
    embed.addFields({
      name: `${row.training_date} · ${safe(row.program_name).slice(0, 70)} · ${safe(row.lesson_name).slice(0, 70)}`,
      value: [
        `${OUTCOMES[row.outcome]}${row.voided_at ? ' · VOIDED' : ''} · C${row.instructor_pilot_id}${row.source === 'import' ? ' (historical, Discord identity unverified)' : ''}`,
        `ID: \`${row.record_id}\``,
        row.comments ? safe(row.comments) : 'No comments.',
      ].join('\n'),
    });
    if (row.voided_at) embed.addFields({
      name: `Voided by C${row.voided_by_pilot_id} · ${row.voided_at} UTC`,
      value: safe(row.void_reason),
    });
  }
  if (!rows.length) embed.setDescription(page === 1 ? 'No training attempts recorded.' : 'No attempts on this page.');
  return embed.setFooter({
    text: `Page ${page}${rows.length > HISTORY_PAGE_SIZE ? ` · Use page:${page + 1} for older attempts` : ''}`,
  });
}

async function postTrainingUpdate(guild, { pilot, lesson, data, actor, track, traineeDiscordId },
  parentId = process.env.TRAINING_CHANNEL_ID || '1174748570948223026') {
  try {
    if (!traineeDiscordId) return false;
    const parent = await guild.channels.fetch(parentId);
    if (!parent?.threads) return false;
    const { threads } = await parent.threads.fetchActive();
    const matches = threads.filter(thread => thread.parentId === parentId && thread.type === ChannelType.PrivateThread &&
      !thread.archived && !thread.locked && thread.name === `Training Case for C${pilot.pilot_id}`);
    if (matches.size !== 1) return false;
    const thread = matches.first();
    if (!(await thread.members.fetch({ member: traineeDiscordId, force: true }))) return false;
    const lines = [
      `**Training Update — C${pilot.pilot_id}**`,
      `Program: ${safe(lesson.program_name)}`,
      `Lesson: ${safe(lesson.name)}`,
      `Result: ${OUTCOMES[data.outcome]}`,
      `Instructor: C${actor.pilotId}`,
    ];
    if (track) lines.push(`Progress: ${track.completed.length}/${total(track)} configured lessons passed`);
    await thread.send({ content: lines.join('\n'), allowedMentions: noMentions });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  noMentions, safe, pilotLabel, checkRate, confirm, progressEmbed, historyEmbed, postTrainingUpdate, HISTORY_PAGE_SIZE,
};
