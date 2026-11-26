const { EmbedBuilder } = require('discord.js');
const service = require('./service');
const { OUTCOMES, TrainingError } = require('./validation');
const { noMentions, safe, pilotLabel, confirm, postTrainingUpdate, pirepReference } = require('./discord');

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

async function saveSignoff(ctx, staffPilot, { pilot, lesson, data, repeat = false }) {
  const { db, interaction } = ctx;
  if (data.pirepId && repeat) throw new TrainingError('Linked evaluations allow one active record per lesson and outcome.');
  const summary = new EmbedBuilder().setTitle('Confirm training attempt').setDescription([
    pilotLabel(pilot),
    `${safe(lesson.program_name)} · ${safe(lesson.name)} (${data.lessonId})`,
    `${OUTCOMES[data.outcome]} · ${data.date} · Instructor C${staffPilot.pilot_id}`,
    data.pirepId ? `PIREP: ${pirepReference(data.pirepId)}` : '',
    data.comments ? `Comments: ${safe(data.comments)}` : '',
    repeat ? 'An identical attempt may be saved as an intentional repeat.' : '',
  ].filter(Boolean).join('\n'));
  const actor = await confirmedActor(ctx, 'record', summary, staffPilot, 'Save attempt');
  if (!actor) return;

  if (!data.pirepId && (await service.findPilot(db, pilot.pilot_id)).id !== pilot.id) {
    throw new TrainingError('The target pilot mapping changed. Run the command again.');
  }
  const prepared = service.prepareRecord(pilot, data, {
    source: data.pirepId ? 'pirep' : 'manual', actor, interactionId: interaction.id,
  });
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

module.exports = { canUse, confirmedActor, saveSignoff };
