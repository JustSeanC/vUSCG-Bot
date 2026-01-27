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

    const trainingChannelId = '1174748570948223026';
    const welcomeGuideChannelId = '1350568038612865154';

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
      await db.query(
        'UPDATE users SET state = ?, rank_id = ? WHERE pilot_id = ?',
        [1, 12, pilotId]
      );

      // 3) Discord member updates (best-effort)
      let member;
      try {
        member = await interaction.guild.members.fetch(targetUser.id);
      } catch {
        return interaction.editReply({
          content: `❌ Could not find that Discord user in this server. Make sure they have joined first.`,
        });
      }

      try { await member.setNickname(nickname); }
      catch (e) { console.warn('⚠️ Nickname set failed:', e?.message ?? e); }

      try { await member.roles.add(CADET_ROLE_ID); }
      catch (e) { console.warn('⚠️ Adding Cadet role failed:', e?.message ?? e); }

      try { await member.roles.remove(GUEST_ROLE_ID); }
      catch (e) { console.warn('⚠️ Removing Guest role failed:', e?.message ?? e); }

      // 4) Create private thread
      const trainingChannel = await interaction.guild.channels.fetch(trainingChannelId);
      if (!trainingChannel) {
        return interaction.editReply({
          content: `❌ Could not find training channel (${trainingChannelId}).`,
        });
      }
      
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

      // 5) Add target + command runner + ALL instructor pilots
      const toAdd = new Set();
      toAdd.add(targetUser.id);
      toAdd.add(interaction.user.id);

      if (roles.INSTRUCTOR_PILOT_ROLE_ID) {
        try {
          // Ensure role.members is populated (requires GuildMembers intent enabled in Dev Portal)
          await interaction.guild.members.fetch({ withPresences: false });

          const role = await interaction.guild.roles.fetch(roles.INSTRUCTOR_PILOT_ROLE_ID);
          if (role) {
            for (const [id] of role.members) toAdd.add(id);
          }
        } catch (e) {
          console.warn('⚠️ Could not fetch/invite instructor role members:', e?.message ?? e);
        }
      } else {
        console.warn('⚠️ INSTRUCTOR_PILOT_ROLE_ID missing in .env; no instructors auto-added.');
      }

      let ok = 0, fail = 0;
      for (const id of toAdd) {
        const added = await safeAddToThread(thread, id);
        if (added) ok++;
        else fail++;
      }

      // 6) Kickoff message (NO role ping)
      let kickoff =
        `Welcome <@${targetUser.id}> — your account has been activated and you are ready to begin training.\n` +
        `Please view <#${welcomeGuideChannelId}> for our ACARS information and let us know here which training path you would like to follow first — **Fixed Wing** or **Rotary Wing**.`;

      if (notes) kickoff += `\n\n**Activation notes:** ${notes}`;

      await thread.send(kickoff);

      // 7) Confirm
      await interaction.editReply({
        content:
          `✅ Activated <@${targetUser.id}> as **${nickname}** (Pilot ID ${pilotId}).\n` +
          `✅ Private training thread created: **${thread.name}**\n` +
          `➕ Thread adds: ${ok} succeeded, ${fail} failed (non-fatal).`,
      });

    } catch (err) {
      console.error('❌ Error in activate command:', err);
      try {
        await interaction.editReply({ content: '❌ An error occurred during activation.' });
      } catch {
        console.warn('⚠️ Interaction expired before bot could reply.');
      }
    }
  },
};
