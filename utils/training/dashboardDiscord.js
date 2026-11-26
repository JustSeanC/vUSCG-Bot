const { EmbedBuilder } = require('discord.js');
const dashboard = require('./dashboard');
const { safe, pilotLabel, noMentions } = require('./discord');
const { TrainingError } = require('./validation');

const followupLabels = {
  paused: 'Inactive or paused enrollment', no_record: 'No recorded training',
  follow_up: 'Follow-up suggested', recent: 'Recent training',
};
const count = value => Number(value ?? 0);
const bounded = (text, length) => text.length <= length ? text : text.slice(0, length - 1) + '…';

function buildRoster(embed, rows, days) {
  embed.setDescription(`One row per enrollment · Follow-up after ${days} days without recorded training`);
  for (const row of rows) {
    const awards = (row.awards ?? []).map(item => `${safe(item.name)}${item.program_id ? ` (${safe(item.program_id)})` : ''}`);
    embed.addFields({
      name: `${pilotLabel(row)} · ${safe(row.program_id)}`,
      value: bounded([
        `${row.active ? 'Active' : 'Paused or unavailable'} · ${count(row.completed)}/${count(row.configured)} configured lessons passed`,
        `Active programs: ${safe(row.active_programs || 'None')}`,
        row.latest_date ? `Latest: ${row.latest_date} · C${row.instructor_pilot_id}${row.source === 'import' ? ' (historical, unverified)' : ''}` : 'Latest: None',
        `Follow-up: ${followupLabels[row.followup]}`,
        row.slots_without_mr ? 'Configured lessons passed · MR unawarded' : '',
        `Qualifications: ${awards.join(', ') || 'None'}`,
      ].filter(Boolean).join('\n'), 1000),
    });
  }
}

function buildStats(embed, { enrollment, attempts, awards, recent }, days) {
  embed.addFields(
    { name: 'Enrollment and configured progress (current)', value: [
      `${count(enrollment.pilots)} distinct pilots · ${count(enrollment.enrollments)} enrollments`,
      `Active RW: ${count(enrollment.rw)} · Active FW: ${count(enrollment.fw)} · Multi-program pilots: ${count(enrollment.multi)}`,
      `Configured lessons passed across enrollments: ${count(enrollment.completed)}`,
    ].join('\n') },
    { name: 'Follow-up (current enrollments)', value: [
      `No training: ${count(enrollment.no_record)} · Recent: ${count(enrollment.recent)} · Follow-up after ${days} days: ${count(enrollment.follow_up)}`,
      `Paused: ${count(enrollment.paused)} · Active with configured lessons passed and MR unawarded: ${count(enrollment.slots_without_mr)}`,
    ].join('\n') },
    { name: 'Attempts in date range', value: [
      `${count(attempts.attempts)} attempts by ${count(attempts.trained)} distinct trainees`,
      `Passed: ${count(attempts.passed)} · Needs training: ${count(attempts.needs_training)} · In progress: ${count(attempts.in_progress)}`,
      `Historical imports included: ${count(attempts.imported)}`,
    ].join('\n') },
    { name: 'Latest passing evaluations in range', value: recent.map(item =>
      `${item.training_date} · C${item.pilot_id} · ${safe(item.program_id)}/${safe(item.lesson_id)} · \`${item.record_id}\``).join('\n') || 'None' },
  );
  const lines = awards.map(item => `${safe(item.name)}: ${item.awards} awards / ${item.pilots} pilots`);
  // Split the configurable catalog across fields within the embed limits.
  const fields = [];
  let chunk = '';
  for (const line of lines) {
    if (chunk.length + line.length > 900) {
      fields.push(chunk);
      chunk = '';
    }
    chunk += (chunk ? '\n' : '') + line;
  }
  if (chunk) fields.push(chunk);
  for (const [i, value] of fields.slice(0, 3).entries()) {
    embed.addFields({ name: i === 0 ? 'Active qualifications (current)' : 'Active qualifications (continued)', value });
  }
  if (fields.length > 3) embed.setFooter({ text: 'Additional qualification types are available under /qualification list for each pilot.' });
}

async function showDashboard(ctx, action) {
  const { interaction, db } = ctx;
  const options = interaction.options;
  const page = options.getInteger('page') ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new TrainingError('Enter a valid page number.');
  const size = 4;
  const offset = (page - 1) * size;
  const embed = new EmbedBuilder().setTitle({ roster: 'Staff training roster', stats: 'Staff training statistics', instructors: 'Instructor activity' }[action]);
  if (action === 'stats') {
    const range = dashboard.dateRange(options.getString('start'), options.getString('end'));
    embed.setDescription(`${range.join(' to ')} UTC, inclusive · Date-range metrics exclude voided records`);
    buildStats(embed, await dashboard.stats(db, range, dashboard.followupDays()), dashboard.followupDays());
    return interaction.editReply({ embeds: [embed], allowedMentions: noMentions });
  }
  let rows;
  if (action === 'roster') {
    const days = dashboard.followupDays();
    rows = await dashboard.roster(db, { days, limit: size + 1, offset,
      program: options.getString('track'), status: options.getString('status') ?? 'all' });
    buildRoster(embed, rows.slice(0, size), days);
  } else {
    const range = dashboard.dateRange(options.getString('start'), options.getString('end'));
    const summary = await dashboard.instructors(db, range, size + 1, offset);
    rows = summary.rows;
    embed.setDescription(`${range.join(' to ')} UTC, inclusive · Verified Discord signoffs, excluding voids\nHistorical imports: ${summary.imported.attempts} attempts across ${summary.imported.identifiers} unverified C-numbers`);
    for (const row of rows.slice(0, size)) {
      embed.addFields({ name: `C${row.instructor_pilot_id}`, value:
        `${row.attempts} evaluations · ${row.trainees} unique trainees · Latest training ${row.latest}\nPassed: ${row.passed} · Needs training: ${row.needs_training} · In progress: ${row.in_progress}\nRW: ${row.rw} · FW: ${row.fw}` });
    }
  }
  if (!rows.length) embed.addFields({ name: 'Results', value: 'No matching entries on this page.' });
  embed.setFooter({ text: `Page ${page}${rows.length > size ? ` · Use page:${page + 1} for more` : ''}` });
  return interaction.editReply({ embeds: [embed], allowedMentions: noMentions });
}

module.exports = { showDashboard };
