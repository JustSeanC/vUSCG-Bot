const { randomUUID } = require('node:crypto');
const { first, transaction, findPilot, linkedDiscordForPilot, writeEnrollment } = require('./service');
const { category, snapshot, digest } = require('./materials');
const { TrainingError, code, text, snowflake, pilotNumber } = require('./validation');

const isTrack = program => program === 'rw' || program === 'fw';

async function instruction(db, id) {
  return first(db, `SELECT e.*, d.state AS discord_state, d.result AS discord_result,
    r.state AS rating_state, r.result AS rating_result
    FROM vuscg_training_instruction_events e
    LEFT JOIN vuscg_training_instruction_delivery d ON d.event_id=e.event_id AND d.target='discord'
    LEFT JOIN vuscg_training_instruction_delivery r ON r.event_id=e.event_id AND r.target='trainee_rating'
    WHERE e.event_id=?`, [id]);
}

async function saveInstruction(db, input) {
  const {
    source, interactionId, guildId, actor, pilot, traineeDiscordId, repeat = false, active = true,
  } = input;
  if (!['enrollment', 'materials', 'stage0'].includes(source)) throw new TrainingError('Unknown training instruction action.');
  const request = snowflake(interactionId);
  const guild = snowflake(guildId);
  const discordId = snowflake(actor.discordId);
  const reviewer = pilotNumber(actor.pilotId);
  const note = text(input.note, 'Instructor note');
  const program = source === 'enrollment' ? code(input.programId, 'program') : null;
  const activationKey = source === 'stage0' ? String(pilot.id) : null;
  const requestedCategory = source === 'materials' ? code(input.categoryId, 'resource category') : activationKey ? 'stage0' : null;
  const recipient = program && !active ? null : snowflake(traineeDiscordId);
  if (!active && (note || repeat)) throw new TrainingError('Pause requests cannot send instructional notes.');

  const intent = digest([source, String(pilot.id), recipient, guild, discordId, reviewer, program, requestedCategory, active, note, repeat]);
  const receipt = async connection => {
    const row = await first(connection, `SELECT event_id, intent_hash FROM vuscg_training_instruction_events
      WHERE interaction_id=?`, [request]);
    if (row && row.intent_hash !== intent) throw new TrainingError('This interaction already saved a different training request.');
    if (row) return row;
    return activationKey && first(connection, 'SELECT event_id FROM vuscg_training_instruction_events WHERE activation_key=?', [activationKey]);
  };
  let id;
  try {
    id = await transaction(db, async connection => {
      const current = await findPilot(connection, pilot.pilot_id, true);
      if (current.id !== pilot.id) throw new TrainingError('The target pilot mapping changed.');
      if (recipient && await linkedDiscordForPilot(connection, current.pilot_id) !== recipient) {
        throw new TrainingError('The verified Discord account changed. Start a new request.');
      }

      const prior = await receipt(connection);
      if (prior) return prior.event_id;
      let kind = source;
      let categoryId = requestedCategory;
      let label;
      if (program) {
        const result = await writeEnrollment(connection, { userId: current.id, programId: program, active, actor });
        kind = result.kind === 'unchanged' && active && repeat ? 'instruction' : result.kind;
        if (kind === 'unchanged' && note) throw new TrainingError('The enrollment is already active. Use repeat:true to send a new note and materials.');
        label = result.program.name;
        if (active && isTrack(program) && kind !== 'unchanged') {
          const item = await first(connection, 'SELECT category_id FROM vuscg_training_resource_categories WHERE category_id=? AND active', [program]);
          categoryId = item?.category_id ?? null;
        }
      } else {
        label = (await category(connection, categoryId)).name;
      }
      const resources = categoryId ? await snapshot(connection, categoryId) : [];
      if (kind === 'materials' && resources.length === 0) throw new TrainingError('No active materials are configured for this category.');

      const id = randomUUID();
      await connection.execute(`INSERT INTO vuscg_training_instruction_events
        (event_id,interaction_id,activation_key,kind,user_id,public_pilot_id,guild_id,trainee_discord_id,
         actor_discord_id,actor_pilot_id,program_id,category_id,label,note,resources,intent_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))`,
      [id, request, activationKey, kind, current.id, current.pilot_id, guild, recipient, discordId,
        reviewer, program, categoryId, label, note, JSON.stringify(resources), intent]);
      const targets = [];
      if (kind !== 'pause' && kind !== 'unchanged') targets.push('discord');
      if (isTrack(program) && ['start', 'resume'].includes(kind)) targets.push('trainee_rating');
      for (const target of targets) {
        await connection.execute(`INSERT INTO vuscg_training_instruction_delivery
          (event_id,target,next_attempt_at) VALUES (?,?,UTC_TIMESTAMP(6))`, [id, target]);
      }
      return id;
    });
  } catch (error) {
    if (error instanceof TrainingError) throw error;
    const existing = await receipt(db);
    if (!existing) throw error;
    id = existing.event_id;
  }
  return instruction(db, id);
}

module.exports = { isTrack, instruction, saveInstruction };
