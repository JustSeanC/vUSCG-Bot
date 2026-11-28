const { randomUUID } = require('node:crypto');
const { first, transaction, findPilot, linkedPilot, linkedDiscordForPilot } = require('./service');
const { TrainingError, code, trainingDate, text, snowflake } = require('./validation');

const instructorAwards = new Set(['mr', 'dlq', 'hitron', 'blackjack', 'mq9']);

function canChange(role, action, qualification) {
  if (!['grant', 'revoke'].includes(action)) return false;
  return role === 'command_staff' ||
    (role === 'instructor_pilot' && action === 'grant' && instructorAwards.has(qualification));
}

function checkChange(role, action, qualification) {
  if (!canChange(role, action, qualification)) {
    throw new TrainingError('You do not have permission for this qualification change. IP grants and all revocations require Command Staff.');
  }
}

// Future eligibility rules can be supplied here without coupling awards to signoffs.
async function validateGrant(_db, _change) {}

async function authorize(ctx, change) {
  const { interaction, db, roles } = ctx;
  if (!interaction.inGuild() || !process.env.GUILD_ID || interaction.guildId !== process.env.GUILD_ID) {
    throw new TrainingError('Qualifications are available only in the configured vUSCG server.');
  }
  const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
  const has = id => id && member.roles.cache.has(id);
  const role = has(roles.COMMAND_STAFF_ROLE_ID) ? 'command_staff'
    : has(roles.INSTRUCTOR_PILOT_ROLE_ID) ? 'instructor_pilot' : null;
  checkChange(role, change.action, change.qualification);
  const pilot = await linkedPilot(db, interaction);
  return { id: String(pilot.id), pilotId: String(pilot.pilot_id), discordId: snowflake(interaction.user.id), role };
}

async function catalogEntry(db, qualification, program, action, lock = false) {
  const row = await first(db, `SELECT name, scope, enabled FROM vuscg_training_qualifications
    WHERE qualification_id = ?${lock ? ' LOCK IN SHARE MODE' : ''}`, [code(qualification, 'qualification')]);
  if (!row || (action === 'grant' && !row.enabled)) throw new TrainingError('That qualification is unavailable.');
  if (qualification === 'mr' && !['rw', 'fw'].includes(program)) {
    throw new TrainingError('Mission Rated requires an explicit rw or fw program.');
  }
  if (row.scope === 'organization' && program) throw new TrainingError('This qualification is organization-wide.');
  if (row.scope === 'program') {
    const track = await first(db, 'SELECT name FROM vuscg_training_programs WHERE program_id = ?', [code(program, 'program')]);
    if (!track) throw new TrainingError('That training program does not exist.');
  }
  return row;
}

async function candidate(db, id) {
  if (!/^[a-f0-9]{64}$/.test(id ?? '')) throw new TrainingError('Enter a valid import candidate ID.');
  const row = await first(db, `SELECT candidate_id, CAST(user_id AS CHAR) AS user_id, public_pilot_id,
    qualification_id, program_id, DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date, provenance
    FROM vuscg_training_qualification_imports WHERE candidate_id = ?`, [id]);
  if (!row) throw new TrainingError('Qualification import candidate not found.');
  return row;
}

async function preview(db, input) {
  const source = input.candidateId ? await candidate(db, input.candidateId) : null;
  const action = source ? 'grant' : input.action;
  const qualification = code(source?.qualification_id ?? input.qualification, 'qualification');
  const program = source?.program_id ?? input.program ?? '';
  const pilot = await findPilot(db, source?.public_pilot_id ?? input.pilotId);
  if (source && source.user_id !== pilot.id) throw new TrainingError('The imported pilot mapping changed.');
  const entry = await catalogEntry(db, qualification, program, action);
  const date = trainingDate(source?.effective_date ?? input.date ?? new Date().toISOString().slice(0, 10));
  const reason = text(input.reason, 'Reason', action === 'revoke');
  const graduates = !source && action === 'grant' && qualification === 'mr';
  const graduateDiscordId = graduates ? await linkedDiscordForPilot(db, pilot.pilot_id) : null;
  if (graduates && !graduateDiscordId) {
    throw new TrainingError('Mission Rated graduation requires one verified Discord account for the pilot.');
  }
  return { action, qualification, program, pilot, name: entry.name, date, reason, source, graduateDiscordId };
}

async function readReceipt(db, id, change, actor) {
  const event = await first(db, `SELECT event_id, reviewer_discord_id, reviewer_user_id, reviewer_pilot_id,
    action, qualification_id, program_id, user_id, public_pilot_id, candidate_id, graduate_discord_id,
    DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date, reason
    FROM vuscg_training_qualification_events WHERE interaction_id = ?`, [id]);
  if (!event) return null;
  if (event.reviewer_discord_id !== actor.discordId || String(event.reviewer_user_id) !== actor.id ||
      String(event.reviewer_pilot_id) !== actor.pilotId || event.action !== change.action ||
      String(event.user_id) !== change.pilot.id || String(event.public_pilot_id) !== String(change.pilot.pilot_id) ||
      event.qualification_id !== change.qualification || event.program_id !== change.program ||
      event.candidate_id !== (change.source?.candidate_id ?? null) || event.effective_date !== change.date ||
      event.reason !== change.reason || event.graduate_discord_id !== change.graduateDiscordId) {
    throw new TrainingError('This interaction has already been used for a different qualification change.');
  }
  return { id: event.event_id, created: false };
}

async function commitConfirmedChange(ctx, change, original, policy = validateGrant) {
  const actor = await authorize(ctx, change);
  if (actor.id !== original.id || actor.pilotId !== original.pilotId || actor.discordId !== original.discordId) {
    throw new TrainingError('Your linked pilot account changed. Run the command again.');
  }
  const id = snowflake(ctx.interaction.id);
  const { db } = ctx;
  const importId = change.source?.candidate_id ?? null;
  const identity = [change.pilot.id, change.qualification, change.program];
  try {
    return await transaction(db, async connection => {
      const receipt = await readReceipt(connection, id, change, actor);
      if (receipt) return receipt;
      const target = await findPilot(connection, change.pilot.pilot_id, change.qualification === 'mr');
      if (target.id !== change.pilot.id) throw new TrainingError('The target pilot mapping changed.');
      const reviewer = await linkedPilot(connection, ctx.interaction);
      if (String(reviewer.id) !== actor.id || String(reviewer.pilot_id) !== actor.pilotId) {
        throw new TrainingError('Your linked pilot account changed.');
      }
      await catalogEntry(connection, change.qualification, change.program, change.action, true);
      await connection.execute(`INSERT INTO vuscg_training_qualification_status
        (user_id, qualification_id, program_id, active) VALUES (?, ?, ?, FALSE)
        ON DUPLICATE KEY UPDATE active = vuscg_training_qualification_status.active`, identity);
      const prior = await first(connection, `SELECT s.active, DATE_FORMAT(e.effective_date, '%Y-%m-%d') AS effective_date
        FROM vuscg_training_qualification_status s LEFT JOIN vuscg_training_qualification_events e ON e.event_id = s.last_event_id
        WHERE s.user_id = ? AND s.qualification_id = ? AND s.program_id = ? FOR UPDATE`, identity);
      const replay = await readReceipt(connection, id, change, actor);
      if (replay) return replay;
      if (importId && await first(connection, 'SELECT event_id FROM vuscg_training_qualification_events WHERE candidate_id = ?', [importId])) {
        throw new TrainingError('This import candidate has already been reviewed and granted.');
      }
      const active = change.action === 'grant';
      if (Boolean(prior.active) === active) {
        throw new TrainingError(active ? 'This qualification is already active.' : 'This qualification is not active.');
      }
      if (prior.effective_date && prior.effective_date > change.date) {
        throw new TrainingError('The effective date cannot precede the latest event in this scope.');
      }
      if (active) await policy(connection, change);
      if (!importId && active && change.qualification === 'mr' &&
          (!change.graduateDiscordId || await linkedDiscordForPilot(connection, target.pilot_id) !== change.graduateDiscordId)) {
        throw new TrainingError('The verified Discord account changed. Review graduation again.');
      }
      const eventId = randomUUID();
      await connection.execute(`INSERT INTO vuscg_training_qualification_events
        (event_id, user_id, public_pilot_id, qualification_id, program_id, action, effective_date, reviewer_user_id,
         reviewer_pilot_id, reviewer_discord_id, reviewer_role, reason, created_at, interaction_id, candidate_id, graduate_discord_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), ?, ?, ?)`,
      [eventId, target.id, target.pilot_id, change.qualification, change.program, change.action, change.date, actor.id,
        actor.pilotId, actor.discordId, actor.role, change.reason, id, importId, change.graduateDiscordId]);
      await connection.execute(`UPDATE vuscg_training_qualification_status SET active = ?, last_event_id = ?
        WHERE user_id = ? AND qualification_id = ? AND program_id = ?`, [active, eventId, ...identity]);
      if (!importId) {
        const targets = ['award'];
        if (change.qualification === 'ip') targets.push('ip_role');
        if (['mr', 'blackjack', 'mq9'].includes(change.qualification)) targets.push('type_rating');
        if (change.qualification === 'mr' && active) targets.push('graduation');
        for (const target of targets) {
          await connection.execute(`INSERT INTO vuscg_training_qualification_sync
            (event_id, target, next_attempt_at) VALUES (?, ?, UTC_TIMESTAMP())`, [eventId, target]);
        }
      }
      return { id: eventId, created: true };
    }, { qualifications: true });
  } catch (error) {
    if (error instanceof TrainingError) throw error;
    const durable = await readReceipt(db, id, change, actor).catch(receiptError => {
      if (receiptError instanceof TrainingError) throw receiptError;
      return null;
    });
    if (durable) return durable;
    throw error;
  }
}

async function activeAwards(db, userId) {
  const [rows] = await db.execute(`SELECT q.qualification_id, q.name, s.program_id,
    DATE_FORMAT(e.effective_date, '%Y-%m-%d') AS effective_date, e.candidate_id
    FROM vuscg_training_qualification_status s JOIN vuscg_training_qualifications q USING (qualification_id)
    JOIN vuscg_training_qualification_events e ON e.event_id = s.last_event_id
    WHERE s.user_id = ? AND s.active = TRUE ORDER BY q.qualification_id, s.program_id`, [userId]);
  return rows;
}

async function history(db, userId, limit, offset) {
  const [rows] = await db.query(`SELECT e.event_id, e.action, q.name, e.program_id, e.reason,
    e.reviewer_pilot_id, e.reviewer_discord_id, e.reviewer_role, e.candidate_id,
    DATE_FORMAT(e.effective_date, '%Y-%m-%d') AS effective_date, DATE_FORMAT(e.created_at, '%Y-%m-%d %H:%i') AS created_at,
    i.provenance,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('target', s.target, 'state', s.state, 'attempts', s.attempts,
      'result', (SELECT a.result FROM vuscg_training_qualification_sync_attempts a
        WHERE a.event_id = s.event_id AND a.target = s.target ORDER BY a.id DESC LIMIT 1)))
      FROM vuscg_training_qualification_sync s WHERE s.event_id = e.event_id) AS delivery
    FROM vuscg_training_qualification_events e JOIN vuscg_training_qualifications q USING (qualification_id)
    LEFT JOIN vuscg_training_qualification_imports i USING (candidate_id)
    WHERE e.user_id = ? ORDER BY e.created_at DESC, e.event_id DESC LIMIT ? OFFSET ?`, [userId, limit, offset]);
  return rows;
}

module.exports = { canChange, authorize, catalogEntry, preview, commitConfirmedChange, activeAwards, history };
