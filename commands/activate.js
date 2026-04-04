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

    const trainingChannelId = '1174748570948223026';
    const welcomeGuideChannelId = '1350568038612865154';
    const registrationChannelId = '1357177317486628905';
    const ronUserId = '396783529327067136';
    const CADET_ROLE_ID = '1174513529253007370';
    const GUEST_ROLE_ID = '1174513627273887895';
    const STAGE_ZERO_LINK =
      'https://drive.google.com/drive/folders/1slR36azctaZclnz1D9kus9xKjv0x8XRg?usp=drive_link';

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

    try {
      // 1) Validate pilot exists in phpVMS
      const [rows] = await db.query('SELECT name FROM users WHERE pilot_id = ?', [pilotId]);
      if (rows.length === 0) {
        return interaction.editReply({
          content: `❌ No user found with Pilot ID ${pilotId}`,
        });
      }

      const fullName = rows[0].name.trim();
      const [firstName, ...lastParts] = fullName.split(' ');
      const lastInitial = lastParts.length ? lastParts[0][0].toUpperCase() : '';
      const nickname = `C${pilotId} ${firstName} ${lastInitial}`;

      // 2) Update DB
      await db.query('UPDATE users SET state = ?, rank_id = ? WHERE pilot_id = ?', [1, 12, pilotId]);

      // 3) Discord member updates (best-effort)
      let member;
      try {
        member = await interaction.guild.members.fetch(targetUser.id);
      } catch {
        return interaction.editReply({
          content: `❌ Could not find that Discord user in this server. Make sure they have joined first.`,
        });
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

      // 4) Create private thread
      const trainingChannel = await interaction.guild.channels.fetch(trainingChannelId);
      if (!trainingChannel) {
        return interaction.editReply({
          content: `❌ Could not find training channel (${trainingChannelId}).`,
        });
      }

      // Link discord_id <-> pilot_id
      await db.query(
        `INSERT INTO discord_links (discord_id, pilot_id)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE pilot_id = VALUES(pilot_id), linked_at = CURRENT_TIMESTAMP`,
        [targetUser.id, pilotId]
      );

      const thread = await trainingChannel.threads.create({
        name: `Training Case for C${pilotId}`,
        autoArchiveDuration: 1440,
        type: 12, // PrivateThread
        reason: `Training onboarding for C${pilotId}`,
        invitable: true,
      });

      // 5) Add only target + command runner + Ron
const toAdd = new Set();
toAdd.add(targetUser.id);
toAdd.add(interaction.user.id);
toAdd.add(ronUserId);

let ok = 0,
  fail = 0;
for (const id of toAdd) {
  const added = await safeAddToThread(thread, id);
  if (added) ok++;
  else fail++;
}

      // 6) Kickoff message
let kickoff =
  `${roles.INSTRUCTOR_PILOT_ROLE_ID ? `<@&${roles.INSTRUCTOR_PILOT_ROLE_ID}> ` : ''}` +
  `Welcome <@${targetUser.id}> — your account has been activated and you are ready to begin training.\n` +
  `Please view <#${welcomeGuideChannelId}> for our ACARS information and let us know here which training path you would like to follow first — **Fixed Wing** or **Rotary Wing**.`;

if (notes) kickoff += `\n\n**Activation notes:** ${notes}`;

await thread.send({
  content: kickoff,
  allowedMentions: {
    users: [targetUser.id],
    roles: roles.INSTRUCTOR_PILOT_ROLE_ID ? [roles.INSTRUCTOR_PILOT_ROLE_ID] : [],
  },
});

      // 6b) NEW: Stage Zero follow-up message (only when hours band is selected)
      if (lowHours === 'yes') {
        await thread.send(
          `📘 **Stage Zero Flight Course (50–100 hours)**\n` +
            `Because your VATSIM records show that you have **less than 100 hours**, please complete our required **Stage Zero** course before continuing:\n` +
            `${STAGE_ZERO_LINK}\n\n` +
            `To complete Stage Zero properly, please ensure you read the Welcome Guide found in the folder first before beginning the training stage. \n` +
            `As you complete each flight, an Instructor Pilot will review. You can continue moving forward even if an Instructor Pilot has not yet reviewed a flight. \n` +
            `If there are any issues, you will be asked to re-do a specific portion of the flight. \n` +
            `Once you complete all of the Stage Zero flights, an Instructor Pilot will guide you in your journey to becoming a fully mission rated pilot of the vUSCG!`
        );
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
    `✅ Private training thread created: **${thread.name}**\n` +
    `➕ Thread adds: ${ok} succeeded, ${fail} failed (non-fatal).\n` +
    `📝 Registration log: ${registrationLogStatus}` +
    (lowHours === 'yes' ? `\n📘 Stage Zero link posted (50–100 hours selected).` : ''),
});

    } catch (err) {
      console.error('❌ /activate error:', err);
      return interaction.editReply({
        content: `❌ Activation failed: ${err?.message ?? err}`,
      });
    }
  },
};
    
