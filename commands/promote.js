module.exports = {
  name: 'promote',

  async execute(ctx) {
    const { interaction, db, hasRole, roles } = ctx;

    if (!(hasRole(roles.INSTRUCTOR_PILOT_ROLE_ID) || hasRole(roles.COMMAND_STAFF_ROLE_ID))) {
      return interaction.reply({
        content: '❌ You do not have permission to use this command.',
        ephemeral: true,
      });
    }

    if (!roles.COMMAND_STAFF_ROLE_ID || !roles.INSTRUCTOR_PILOT_ROLE_ID) {
      return interaction.reply({
        content: '❌ Bot misconfiguration: missing COMMAND_STAFF_ROLE_ID or INSTRUCTOR_PILOT_ROLE_ID in .env',
        ephemeral: true,
      });
    }

    const pilotId = interaction.options.getInteger('pilot_id');
    const targetUser = interaction.options.getUser('user');
    const track = interaction.options.getString('track');

    const rolePilot  = '1174513368992862218';
    const roleCadet  = '1174513529253007370';
    const roleRotary = '1210792334749601862';
    const roleFixed  = '1210792296199749672';
    const roleO2     = '1412811531925717245';

    try {
      const [rows] = await db.query('SELECT name FROM users WHERE pilot_id = ?', [pilotId]);
      if (rows.length === 0) {
        return interaction.reply({ content: `❌ No user found with Pilot ID ${pilotId}`, ephemeral: true });
      }

      const fullName = rows[0].name.trim();
      const [firstName, ...lastParts] = fullName.split(' ');
      const lastInitial = lastParts.length ? lastParts[0][0].toUpperCase() : '';
      const nickname = `C${pilotId} ${firstName} ${lastInitial}`;

      await interaction.deferReply();

      await db.query('UPDATE users SET rank_id = ? WHERE pilot_id = ?', [13, pilotId]);

      const member = await interaction.guild.members.fetch(targetUser.id);
      await member.setNickname(nickname);

      await member.roles.remove(roleCadet);
      await member.roles.add(rolePilot);
      await member.roles.add(roleO2);
      await member.roles.add(track === 'rotary' ? roleRotary : roleFixed);

      // Post confirmation in associated training thread (if found)
      try {
        const trainingChannelId = process.env.TRAINING_CHANNEL_ID || '1174748570948223026';
        const trainingChannel = await interaction.guild.channels.fetch(trainingChannelId);

        if (trainingChannel?.threads) {
          let thread = null;
          const cidTokenRegex = new RegExp(`(^|[^A-Z0-9])C${pilotId}([^0-9]|$)`, 'i');
          const threadMatchesCid = (t) => cidTokenRegex.test(String(t?.name || ''));

          const activeThreads = await trainingChannel.threads.fetchActive();
          thread = activeThreads?.threads?.find(threadMatchesCid) || null;

          if (!thread) {
            const archivedPrivate = await trainingChannel.threads.fetchArchived({ type: 'private', limit: 100 });
            thread = archivedPrivate?.threads?.find(threadMatchesCid) || null;
          }

          if (!thread) {
            const archivedPublic = await trainingChannel.threads.fetchArchived({ type: 'public', limit: 100 });
            thread = archivedPublic?.threads?.find(threadMatchesCid) || null;
          }

          if (thread) {
            try {
              await thread.setArchived(false, 'Posting promotion confirmation');
            } catch (e) {
              console.warn(`⚠️ Could not unarchive training thread for C${pilotId}:`, e?.message ?? e);
            }

            await thread.send(
              `✅ **Promotion Update**\n` +
              `<@${targetUser.id}> has been promoted to **O-2 LTJG** on the **${track === 'rotary' ? 'Rotary Wing' : 'Fixed Wing'}** track.\n` +
              `vUSCG CID: **C${pilotId}**.`
            );
          } else {
            console.warn(`⚠️ No associated training thread found for C${pilotId}.`);
          }
        }
      } catch (e) {
        console.warn(`⚠️ Could not post promotion confirmation in training thread for C${pilotId}:`, e?.message ?? e);
      }

      await interaction.editReply({
        content: `✅ Promoted <@${targetUser.id}> to **O-2 LTJG** – ${track === 'rotary' ? 'Rotary Wing' : 'Fixed Wing'}`,
      });

    } catch (err) {
      console.error('❌ Error in promote command:', err);
      try {
        await interaction.editReply({ content: '❌ An error occurred during promotion.' });
      } catch {
        console.warn('⚠️ Interaction expired before bot could reply.');
      }
    }
  },
};
