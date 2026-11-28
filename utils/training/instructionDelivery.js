const { createHash } = require('node:crypto');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { first, findPilot, linkedDiscordForPilot } = require('./service');
const { findTrainingThread } = require('./threads');
const { noMentions, safe, pilotLabel } = require('./discord');
const { TrainingError } = require('./validation');

const enabled = () => process.env.TRAINING_INSTRUCTION_DELIVERY_ENABLED !== 'false';
const marker = id => `Training instruction · ${id}`;
const retryMinutes = 5;

function resourceLink(item) {
  // Angle-bracket destinations prevent parentheses in valid URLs from escaping the link.
  return `[${safe(item.title.replace(/[\[\]]/g, ' '))}](<${item.url}>)`;
}

function buildInstruction(event, pilot) {
  const title = {
    start: 'vUSCG Training Enrollment', resume: 'vUSCG Training Enrollment Resumed',
    instruction: 'vUSCG Training Instructions', materials: 'vUSCG Training Materials',
    stage0: 'Stage Zero Flight Course',
  }[event.kind];
  const header = [pilotLabel(pilot), safe(event.label), `Instructor: C${event.actor_pilot_id}`];
  if (event.program_id) header.push('Status: Active');
  if (event.kind === 'stage0') header.push(
    'Command Staff selected Stage Zero as required for this pilot before continuing.',
    'Read the Welcome Guide first if it is included. Instructor Pilots review each flight. You can keep working while a review is pending, and an instructor will let you know if anything needs to be redone.',
  );
  const notes = event.note ? `\n\n**Instructor note**\n${safe(event.note)}` : '';
  const items = event.resources.map(item => `• ${resourceLink(item)}${item.description ? ` — ${safe(item.description)}` : ''}`);
  const links = items.length ? items.join('\n') : 'There are no configured links yet. Ask a training instructor for guidance.';
  const prefix = header.join('\n') + '\n\n**Training materials**\n';
  let description = prefix + links + notes;
  const files = [];
  if (description.length > 4000) {
    let preview = '';
    for (const item of items) {
      if ((preview + item).length > 2400) break;
      preview += item + '\n';
    }
    description = prefix + preview + '\nSee the attachment for the full resource list.' + notes;
    const full = event.resources.map(item => [item.title, item.url, item.description].filter(Boolean).join('\n')).join('\n\n');
    files.push(new AttachmentBuilder(Buffer.from(full), { name: 'training-materials.txt' }));
  }
  const embed = new EmbedBuilder().setTitle(title).setDescription(description).setFooter({ text: marker(event.event_id) });
  return { embeds: [embed], files, allowedMentions: noMentions, enforceNonce: true,
    nonce: createHash('sha256').update('p06:' + event.event_id).digest('hex').slice(0, 25) };
}

async function persist(connection, id, state, result, { channelId = null, messageId = null, actor = null } = {}) {
  await connection.beginTransaction();
  try {
    await connection.execute(`UPDATE vuscg_training_instruction_delivery SET state=?, result=?,
      next_attempt_at=DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? MINUTE),
      channel_id=COALESCE(?,channel_id), message_id=COALESCE(?,message_id)
      WHERE event_id=? AND target='discord'`, [state, result, retryMinutes, channelId, messageId, id]);
    await connection.execute(`INSERT INTO vuscg_training_instruction_attempts
      (event_id,target,result,actor_discord_id,actor_pilot_id,created_at) VALUES (?,'discord',?,?,?,UTC_TIMESTAMP(6))`,
    [id, result, actor?.discordId ?? null, actor?.pilotId ?? null]);
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  }
  return { state, result };
}

async function stillActive(connection, event) {
  if (!event.program_id) return true;
  const row = await first(connection, `SELECT en.active, p.enabled,
    EXISTS (SELECT 1 FROM vuscg_training_instruction_events newer WHERE newer.user_id=en.user_id
      AND newer.program_id=en.program_id AND newer.kind IN ('start','resume','pause') AND newer.event_seq > ?) AS stale
    FROM vuscg_training_enrollments en JOIN vuscg_training_programs p USING(program_id)
    WHERE en.user_id=? AND en.program_id=?`, [event.event_seq, event.user_id, event.program_id]);
  return row?.active && row.enabled && !row.stale;
}

async function findSent(thread, guild, id) {
  const messages = await thread.messages.fetch({ limit: 50 });
  return messages.find(message => message.author?.id === guild.client.user.id &&
    message.embeds.some(embed => embed.footer?.text === marker(id)));
}

async function tryInstructionDelivery(db, guild, id, retryActor = null) {
  if (!enabled() || !guild || guild.id !== process.env.GUILD_ID) return { state: 'pending', result: 'delivery_disabled' };
  const connection = await db.getConnection();
  const name = `p06:discord:${id}`;
  let reusable = false;
  try {
    if (!(await first(connection, 'SELECT GET_LOCK(?,0) AS acquired', [name])).acquired) {
      reusable = true;
      return { state: 'pending', result: 'delivery_busy' };
    }
    try {
      const event = await first(connection, `SELECT e.*, CAST(e.user_id AS CHAR) AS owner_id, d.state, d.channel_id, d.result,
        d.next_attempt_at<=UTC_TIMESTAMP(6) AS due FROM vuscg_training_instruction_events e
        JOIN vuscg_training_instruction_delivery d ON d.event_id=e.event_id AND d.target='discord'
        WHERE e.event_id=? AND e.guild_id=?`, [id, guild.id]);
      if (!event || ['complete', 'superseded'].includes(event.state)) return event ?? { state: 'none' };
      if (!retryActor && (!event.due || event.state === 'uncertain')) return event;
      const uncertain = ['sending', 'uncertain'].includes(event.state);
      let pilot;
      let thread;
      try {
        pilot = await findPilot(connection, event.public_pilot_id);
        if (pilot.id !== event.owner_id || await linkedDiscordForPilot(connection, pilot.pilot_id) !== event.trainee_discord_id) {
          return await persist(connection, id, uncertain ? 'uncertain' : 'retry', 'discord_link_changed');
        }
        const parent = await guild.channels.fetch(process.env.TRAINING_CHANNEL_ID || '1174748570948223026');
        thread = await findTrainingThread(parent, { pilotId: pilot.pilot_id, discordId: event.trainee_discord_id });
        if (!thread) return await persist(connection, id, uncertain ? 'uncertain' : 'retry', 'private_thread_unavailable');
        if (uncertain) {
          if (event.channel_id !== thread.id) return await persist(connection, id, 'uncertain', 'original_thread_unavailable');
          const prior = await findSent(thread, guild, id);
          if (prior) return await persist(connection, id, 'complete', 'reconciled', { messageId: prior.id });
          if (!retryActor) return await persist(connection, id, 'uncertain', 'send_outcome_unknown');
        }
        if (!(await stillActive(connection, event))) return await persist(connection, id, 'superseded', 'enrollment_changed');
        if (thread.archived) await thread.setArchived(false, 'Deliver audited training instruction');
      } catch (error) {
        const reason = error instanceof TrainingError ? 'discord_link_changed' : 'discord_preflight_failed';
        return persist(connection, id, uncertain ? 'uncertain' : 'retry', reason);
      }
      const payload = buildInstruction(event, pilot);
      await persist(connection, id, 'sending', retryActor ? 'staff_retry' : 'send_started', { channelId: thread.id, actor: retryActor });
      let message;
      try {
        message = await thread.send(payload);
      } catch (error) {
        const definite = [400, 401, 403, 404, 413, 429].includes(error.status);
        return persist(connection, id, definite ? 'retry' : 'uncertain', definite ? 'discord_rejected' : 'send_outcome_unknown');
      }
      return persist(connection, id, 'complete', event.resources.length ? 'delivered' : 'delivered_without_links', { messageId: message.id });
    } finally {
      await connection.execute('SELECT RELEASE_LOCK(?)', [name]);
      reusable = true;
    }
  } finally {
    if (reusable) connection.release();
    else connection.destroy();
  }
}

function startInstructionWorker(client, db, guildId) {
  if (!enabled() || !guildId || guildId !== process.env.GUILD_ID) return;
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const [rows] = await db.execute(`SELECT d.event_id FROM vuscg_training_instruction_delivery d
        JOIN vuscg_training_instruction_events e USING(event_id)
        WHERE d.target='discord' AND d.state IN ('pending','retry','sending')
          AND e.guild_id=? AND d.next_attempt_at<=UTC_TIMESTAMP(6)
        ORDER BY d.next_attempt_at, d.event_id LIMIT 10`, [guildId]);
      if (rows.length) {
        const guild = await client.guilds.fetch(guildId);
        for (const row of rows) await tryInstructionDelivery(db, guild, row.event_id);
      }
    } catch (error) {
      console.warn('Training instruction delivery failed:', error.code || error.name);
    } finally {
      running = false;
    }
  }
  void tick();
  setInterval(tick, 60_000);
}

function deliverySummary(result) {
  if (result.state === 'complete') return 'Delivered to the private training thread.';
  if (result.result === 'private_thread_unavailable') return 'The private training thread is missing, locked, ambiguous, or inaccessible. Delivery is retained for recovery.';
  if (result.result === 'discord_link_changed') return 'The linked account changed. Review the link before attempting delivery.';
  if (result.state === 'superseded') return 'Delivery was superseded by a change to the enrollment.';
  if (result.state === 'uncertain') return 'Discord delivery is uncertain. Command Staff can inspect the thread and reconcile or retry this event.';
  if (result.state === 'none') return 'This request has no Discord delivery.';
  if (result.result === 'delivery_disabled') return 'Discord delivery is disabled. The event remains queued.';
  return 'Discord delivery is queued for retry.';
}

module.exports = { startInstructionWorker, tryInstructionDelivery, buildInstruction, deliverySummary };
