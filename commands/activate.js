const { first, linkedPilot } = require('../utils/training/service');
const { TrainingError } = require('../utils/training/validation');
const { saveInstruction } = require('../utils/training/instructions');
const { tryInstructionDelivery, deliverySummary } = require('../utils/training/instructionDelivery');
const { findPrivateTrainingThreads } = require('../utils/training/threads');

module.exports = {
  name: 'activate',

  async execute(ctx) {
    const { interaction, db, hasRole, roles } = ctx;

    if (!roles.COMMAND_STAFF_ROLE_ID) {
      return interaction.reply({
        content: '❌ Bot misconfiguration: COMMAND_STAFF_ROLE_ID is missing in .env',
        ephemeral: true,
      });
    }

    if (!hasRole(roles.COMMAND_STAFF_ROLE_ID)) {
      return interaction.reply({
        content: '❌ You do not have permission to use this command.',
        ephemeral: true,
      });
    }

    const pilotId = interaction.options.getInteger('pilot_id');
    const targetUser = interaction.options.getUser('user');

    const notesRaw = interaction.options.getString('notes'); // optional
    const notes = notesRaw ? notesRaw.trim() : null;

    // NEW: optional dropdown for hours band
    const lowHours = interaction.options.getString('low_hours'); // optional

    const trainingChannelId = process.env.TRAINING_CHANNEL_ID || '1174748570948223026';
    const welcomeGuideChannelId = '1350568038612865154';
    const registrationChannelId = '1357177317486628905';
    const ronUserId = '396783529327067136';
    const CADET_ROLE_ID = '1174513529253007370';
    const GUEST_ROLE_ID = '1174513627273887895';
    const safeAddToThread = async (thread, userId) => {
      try {
        await thread.members.add(userId);
        return true;
      } catch (e) {
        console.warn(`⚠️ Could not add ${userId} to thread ${thread.id}:`, e?.message ?? e);
        return false;
      }
    };
const getEmbedFieldValue = (embed, fieldName) => {
  const field = embed.fields?.find(
    f => String(f.name).trim().toLowerCase() === String(fieldName).trim().toLowerCase()
  );
  return field?.value ?? null;
};

const normalizePilotId = value => String(value ?? '').replace(/\D/g, '');

const logActivationToRegistrationChannel = async ({
  guild,
  interaction,
  pilotId,
  fullName,
  nickname,
  targetUser,
}) => {
  try {
    const registrationChannel = await guild.channels.fetch(registrationChannelId);

    if (!registrationChannel || !registrationChannel.isTextBased()) {
      return 'failed (registration channel not found or not text-based)';
    }

    const messages = await registrationChannel.messages.fetch({ limit: 100 });

    const matchingMessage = messages.find(msg => {
      if (!msg.embeds?.length) return false;

      return msg.embeds.some(embed => {
        const pilotField = getEmbedFieldValue(embed, 'Pilot ID');
        return normalizePilotId(pilotField) === String(pilotId);
      });
    });

    const activatedBy =
      interaction.member?.displayName ||
      interaction.user.globalName ||
      interaction.user.username;

    const timestamp = Math.floor(Date.now() / 1000);

    const content =
      `✅ **C${pilotId}** (**${fullName}**) has been activated by **${activatedBy}** at <t:${timestamp}:F>.\n` +
      `Discord user: **${targetUser.username}** | Nickname set to **${nickname}**`;

    if (matchingMessage) {
      await matchingMessage.reply({ content });
      return 'replied to original registration post';
    }

    await registrationChannel.send({ content });
    return 'posted new activation message (original registration post not found)';
  } catch (err) {
    console.warn('⚠️ Could not log activation to registration channel:', err?.message ?? err);
    return `failed (${err?.message ?? 'unknown error'})`;
  }
};
    await interaction.deferReply({ ephemeral: true });

    let connection;
    const locks = [];
    try {
      let stageActor;
      if (lowHours === 'yes') {
        if (!process.env.GUILD_ID || interaction.guildId !== process.env.GUILD_ID) {
          throw new TrainingError('Stage Zero can only be assigned in the configured vUSCG server.');
        }
        const reviewer = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
        if (!reviewer.roles.cache.has(roles.COMMAND_STAFF_ROLE_ID)) throw new TrainingError('Command Staff permissions could not be verified.');
        const linked = await linkedPilot(db, interaction);
        stageActor = { pilotId: linked.pilot_id, discordId: interaction.user.id };
      }
      // 1) Validate pilot exists in phpVMS
      const [rows] = await db.query('SELECT CAST(id AS CHAR) AS id, name, rank_id FROM users WHERE pilot_id = ?', [pilotId]);
      if (rows.length === 0) {
        return interaction.editReply({
          content: `❌ No user found with Pilot ID ${pilotId}`,
        });
      }

      if (Number(rows[0].rank_id) >= 13) {
        return interaction.editReply({ content: 'This pilot already holds LTJG or a higher rank. Review their existing account link before making changes.' });
      }

      const fullName = rows[0].name.trim();
      const [firstName, ...lastParts] = fullName.split(' ');
      const lastInitial = lastParts.length ? lastParts[0][0].toUpperCase() : '';
      const nickname = `C${pilotId} ${firstName} ${lastInitial}`;

      // Validate the Discord destination before changing the pilot record.
      let member;
      try {
        member = await interaction.guild.members.fetch(targetUser.id);
      } catch {
        return interaction.editReply({
          content: `❌ Could not find that Discord user in this server. Make sure they have joined first.`,
        });
      }

      const trainingChannel = await interaction.guild.channels.fetch(trainingChannelId);
      if (!trainingChannel?.threads) {
        return interaction.editReply({ content: `❌ Could not find training channel (${trainingChannelId}).` });
      }

      connection = await db.getConnection();
      for (const key of [`p06:activation:pilot:${pilotId}`, `p06:activation:discord:${targetUser.id}`]) {
        if (!(await first(connection, 'SELECT GET_LOCK(?,0) AS acquired', [key])).acquired) {
          throw new TrainingError('An activation is already in progress for this pilot or Discord account.');
        }
        locks.push(key);
      }

      const [links] = await db.query(`SELECT CAST(discord_id AS CHAR) AS discord_id, pilot_id
        FROM discord_links WHERE discord_id = ? OR pilot_id = ?`, [targetUser.id, pilotId]);
      if (links.some(link => link.discord_id !== targetUser.id || String(link.pilot_id) !== String(pilotId))) {
        return interaction.editReply({ content: 'An existing Discord or pilot link conflicts with this request. Review the link before activation.' });
      }

      const matches = await findPrivateTrainingThreads(trainingChannel, pilotId);
      if (matches.length > 1) {
        return interaction.editReply({ content: 'Multiple private training threads match this pilot. Resolve the duplicates before activation.' });
      }

      if (matches.length === 1 && !(await matches[0].members.fetch({ member: targetUser.id, force: true }).catch(() => null))) {
        return interaction.editReply({ content: 'The linked member is missing from the existing private training thread. Verify access before retrying.' });
      }

      const [activation] = await db.query(`UPDATE users SET state = ?, rank_id = ? WHERE pilot_id = ?
        AND (rank_id IS NULL OR rank_id < 13)`, [1, 12, pilotId]);
      if (!activation.affectedRows) {
        return interaction.editReply({ content: 'The pilot rank changed during activation. Review their account before proceeding.' });
      }

      try {
        await member.setNickname(nickname);
      } catch (e) {
        console.warn('⚠️ Nickname set failed:', e?.message ?? e);
      }

      try {
        await member.roles.add(CADET_ROLE_ID);
      } catch (e) {
        console.warn('⚠️ Adding Cadet role failed:', e?.message ?? e);
      }

      try {
        await member.roles.remove(GUEST_ROLE_ID);
      } catch (e) {
        console.warn('⚠️ Removing Guest role failed:', e?.message ?? e);
      }

      // Link discord_id <-> pilot_id
      await db.query(
        `INSERT INTO discord_links (discord_id, pilot_id)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE pilot_id = VALUES(pilot_id), linked_at = CURRENT_TIMESTAMP`,
        [targetUser.id, pilotId]
      );

      let stageEvent;
      let stageNotice = '';
      if (stageActor) {
        try {
          stageEvent = await saveInstruction(db, {
            source: 'stage0', pilot: { id: rows[0].id, pilot_id: pilotId }, traineeDiscordId: targetUser.id,
            actor: stageActor, interactionId: interaction.id, guildId: interaction.guildId,
          });
        } catch (error) {
          console.warn('Stage Zero instructions could not be saved:', error.code || error.name);
          stageNotice = 'Stage Zero instructions were not queued. Verify migration 008 and the Stage Zero category, then retry activation.';
        }
      }

      const existingThread = matches[0];
      const thread = existingThread ?? await trainingChannel.threads.create({
        name: `Training Case for C${pilotId}`,
        autoArchiveDuration: 1440,
        type: 12, // PrivateThread
        reason: `Training onboarding for C${pilotId}`,
        invitable: true,
      });
      let ok = 0;
      let fail = 0;
      if (!existingThread) {
        const toAdd = new Set([targetUser.id, interaction.user.id, ronUserId]);
        for (const id of toAdd) {
          if (await safeAddToThread(thread, id)) ok++;
          else fail++;
        }

        let kickoff =
          `${roles.INSTRUCTOR_PILOT_ROLE_ID ? `<@&${roles.INSTRUCTOR_PILOT_ROLE_ID}> ` : ''}` +
          `Welcome <@${targetUser.id}> — your account has been activated and you are ready to begin training.\n` +
          `Please view <#${welcomeGuideChannelId}> for our ACARS information and let us know here which training path you would like to follow first — **Fixed Wing** or **Rotary Wing**.`;
        if (notes) kickoff += `\n\n**Activation notes:** ${notes}`;
        await thread.send({
          content: kickoff,
          allowedMentions: { users: [targetUser.id], roles: roles.INSTRUCTOR_PILOT_ROLE_ID ? [roles.INSTRUCTOR_PILOT_ROLE_ID] : [] },
        });
      }
      if (stageEvent) {
        const delivered = await tryInstructionDelivery(db, interaction.guild, stageEvent.event_id).catch(() => ({ state: 'pending' }));
        const missing = stageEvent.resources.length === 0 ? ' Stage Zero has no configured links. Configure links and share them privately.' : '';
        stageNotice = `${deliverySummary(delivered)}${missing} Stage Zero event: \`${stageEvent.event_id}\`.`;
      }

      // 7) Log activation in registration channel
const registrationLogStatus = await logActivationToRegistrationChannel({
  guild: interaction.guild,
  interaction,
  pilotId,
  fullName,
  nickname,
  targetUser,
});

// 8) Confirm
await interaction.editReply({
  content:
    `✅ Activated <@${targetUser.id}> as **${nickname}** (Pilot ID ${pilotId}).\n` +
    `✅ Private training thread ${existingThread ? 'reused' : 'created'}: **${thread.name}**\n` +
    `➕ Thread adds: ${ok} succeeded, ${fail} failed (non-fatal).\n` +
    `📝 Registration log: ${registrationLogStatus}` +
    (stageNotice ? `\n📘 ${stageNotice}` : ''),
});

    } catch (err) {
      if (!(err instanceof TrainingError)) console.warn('Activation failed:', err.code || err.name);
      return interaction.editReply({
        content: err instanceof TrainingError ? err.message : 'Activation did not finish. Review the pilot link and private thread before retrying.',
      });
    } finally {
      if (connection) {
        try {
          for (const key of locks) await connection.execute('SELECT RELEASE_LOCK(?)', [key]);
          connection.release();
        } catch {
          connection.destroy();
        }
      }
    }
  },
};
    
