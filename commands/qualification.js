const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const training = require('../utils/training/service');
const qualifications = require('../utils/training/qualifications');
const { canUse } = require('../utils/training/signoff');
const { TrainingError, TEXT_LIMIT } = require('../utils/training/validation');
const { noMentions, safe, pilotLabel, checkRate, confirm } = require('../utils/training/discord');

const pilotOption = o => o.setName('pilot_id').setDescription('Public numeric pilot ID').setMinValue(1).setRequired(true);
const pageOption = o => o.setName('page').setDescription('Page to display').setMinValue(1).setMaxValue(100000);
const reasonOption = required => o => o.setName('reason').setDescription('Audit reason or notes')
  .setMaxLength(TEXT_LIMIT).setRequired(required);
const changeOptions = (sub, revoke) => sub.addIntegerOption(pilotOption)
  .addStringOption(o => o.setName('qualification').setDescription('Qualification code such as MR or DLQ').setMaxLength(32).setRequired(true))
  .addStringOption(reasonOption(revoke))
  .addStringOption(o => o.setName('program').setDescription('Program code for program-specific awards').setMaxLength(32))
  .addStringOption(o => o.setName('date').setDescription('Effective date YYYY-MM-DD (default UTC today)').setMaxLength(10));

const definition = new SlashCommandBuilder().setName('qualification').setDescription('View and manage pilot qualifications')
  .addSubcommand(sub => changeOptions(sub.setName('grant').setDescription('Grant a qualification after review'), false))
  .addSubcommand(sub => changeOptions(sub.setName('revoke').setDescription('Command Staff: revoke a qualification'), true))
  .addSubcommand(sub => sub.setName('list').setDescription('Staff: list active qualifications for a pilot')
    .addIntegerOption(pilotOption).addIntegerOption(pageOption))
  .addSubcommand(sub => sub.setName('history').setDescription('Staff: inspect qualification audit history')
    .addIntegerOption(pilotOption).addIntegerOption(pageOption))
  .addSubcommand(sub => sub.setName('import').setDescription('Review and grant one staged historical candidate')
    .addStringOption(o => o.setName('candidate_id').setDescription('Candidate ID from the reviewed import report')
      .setMinLength(64).setMaxLength(64).setRequired(true))
    .addStringOption(reasonOption(true)));

function awardLabel(award) {
  return `${safe(award.name)}${award.program_id ? ` (${safe(award.program_id)})` : ''}`;
}

async function showAwards(ctx, action) {
  const { interaction, db } = ctx;
  const pilot = await training.findPilot(db, interaction.options.getInteger('pilot_id'));
  const page = interaction.options.getInteger('page') ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new TrainingError('Enter a valid page number.');
  const size = 3;
  const offset = (page - 1) * size;
  const current = action === 'list';
  const rows = current ? (await qualifications.activeAwards(db, pilot.id)).slice(offset, offset + size + 1)
    : await qualifications.history(db, pilot.id, size + 1, offset);
  const embed = new EmbedBuilder().setTitle(`Qualification ${action} · ${pilotLabel(pilot)}`);
  if (!rows.length) embed.setDescription('No qualifications on this page.');
  for (const item of rows.slice(0, size)) {
    const name = `${awardLabel(item)} · ${item.effective_date}`;
    const value = current ? (item.candidate_id ? 'Active · Reviewed historical grant' : 'Active') : [
      `${item.action === 'grant' ? 'Granted' : 'Revoked'} by C${item.reviewer_pilot_id} (${item.reviewer_role.replace('_', ' ')})`,
      `Discord ID ${item.reviewer_discord_id} · Entered ${item.created_at} UTC · Event \`${item.event_id}\``,
      item.candidate_id && `Reviewed source ${safe(item.provenance.dataset)}/${safe(item.provenance.sourceId)}`,
    ].filter(Boolean).join('\n');
    embed.addFields({ name: name.slice(0, 256), value: value.slice(0, 1024) });
    if (!current && item.delivery?.length) {
      embed.addFields({ name: 'Delivery', value: item.delivery.map(job =>
        `${safe(job.target)} · ${safe(job.state)}${job.result ? ` · ${safe(job.result)}` : ''}`).join('\n') });
    }
    if (item.reason) embed.addFields({ name: 'Audit reason', value: safe(item.reason) });
  }
  embed.setFooter({ text: `Page ${page}${rows.length > size ? ` · Use page:${page + 1} for more` : ''}` });
  return interaction.editReply({ embeds: [embed], allowedMentions: noMentions });
}

async function execute(ctx) {
  const { interaction, db, roles, hasRole } = ctx;
  const reply = content => interaction.reply({ content, ephemeral: true, allowedMentions: noMentions });
  if (!interaction.inGuild() || !process.env.GUILD_ID || interaction.guildId !== process.env.GUILD_ID) {
    return reply('Qualifications are available only in the configured vUSCG server.');
  }
  if (!canUse('pilot', true, hasRole, roles)) return reply('You do not have permission to manage or view staff qualifications.');
  try {
    checkRate(interaction.user.id);
    await interaction.deferReply({ ephemeral: true });
    const options = interaction.options;
    const action = options.getSubcommand();
    if (action === 'list' || action === 'history') return await showAwards(ctx, action);
    const change = await qualifications.preview(db, action === 'import'
      ? { candidateId: options.getString('candidate_id'), reason: options.getString('reason') }
      : {
        action, pilotId: options.getInteger('pilot_id'), qualification: options.getString('qualification')?.toLowerCase(),
        program: options.getString('program'), date: options.getString('date'), reason: options.getString('reason'),
      });
    const actor = await qualifications.authorize(ctx, change);
    const summary = new EmbedBuilder().setTitle(`Confirm qualification ${change.action}`).setDescription([
      pilotLabel(change.pilot),
      `${awardLabel({ name: change.name, program_id: change.program })} · Effective ${change.date}`,
      `Reviewer C${actor.pilotId}`,
      change.graduateDiscordId && `Graduation will queue native award, rating, rank, and Discord updates for verified Discord ID ${change.graduateDiscordId}.`,
      change.qualification === 'mr' && change.action === 'revoke' && 'Review existing rank and Discord roles separately. This revocation does not change them.',
      change.source && `Audit-only historical entry. Source: ${safe(change.source.provenance.dataset)}/${safe(change.source.provenance.sourceId)}\nReview: ${safe(change.source.provenance.review)}`,
      change.reason && `Reason: ${safe(change.reason)}`,
    ].filter(Boolean).join('\n'));
    if (!(await confirm(interaction, summary))) return;
    const result = await qualifications.commitConfirmedChange(ctx, change, actor);
    await interaction.editReply({
      content: result.created ? `Qualification ${change.action === 'grant' ? 'granted' : 'revoked'}. Audit event \`${result.id}\`.`
        : `This interaction already saved audit event \`${result.id}\`.`,
      allowedMentions: noMentions,
    });
  } catch (error) {
    const message = error instanceof TrainingError ? error.message
      : error.code === 'ER_NO_SUCH_TABLE' ? 'Qualification storage is unavailable. Check migration 006.'
      : 'The qualification request could not complete. Check qualification history before retrying.';
    if (!(error instanceof TrainingError)) console.warn('Qualification command failed:', error.code || error.name);
    if (!interaction.deferred) return reply(message);
    await interaction.editReply({ content: message, embeds: [], components: [], allowedMentions: noMentions });
  }
}

module.exports = { name: 'qualification', definition, execute, awardLabel };
