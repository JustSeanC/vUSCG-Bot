module.exports = {
  name: 'synclinks',

  async execute(ctx) {
    const { interaction, db, hasRole, roles } = ctx;

    if (!roles.COMMAND_STAFF_ROLE_ID) {
      return interaction.reply({
        content: '❌ Bot misconfiguration: COMMAND_STAFF_ROLE_ID missing in .env',
        ephemeral: true,
      });
    }

    if (!hasRole(roles.COMMAND_STAFF_ROLE_ID)) {
      return interaction.reply({
        content: '❌ You do not have permission to use this command.',
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // Fetch all members so role/member caches are populated
      const members = await interaction.guild.members.fetch();

      let scanned = 0;
      let linked = 0;
      let skippedNoCid = 0;
      let skippedNoPilot = 0;

      for (const [, member] of members) {
        scanned++;

        const displayName = member.nickname || member.displayName || '';
        const m = displayName.match(/\bC(\d{3,6})\b/i);
        if (!m) {
          skippedNoCid++;
          continue;
        }

        const pilotId = parseInt(m[1], 10);
        const discordId = member.user.id;

        // Make sure pilot exists in phpVMS
        const [u] = await db.query(
          'SELECT pilot_id FROM users WHERE pilot_id = ? LIMIT 1',
          [pilotId]
        );
        if (u.length === 0) {
          skippedNoPilot++;
          continue;
        }

        // Upsert link
        await db.query(
          `INSERT INTO discord_links (discord_id, pilot_id)
           VALUES (?, ?)
           ON DUPLICATE KEY UPDATE pilot_id = VALUES(pilot_id), linked_at = CURRENT_TIMESTAMP`,
          [discordId, pilotId]
        );

        linked++;
      }

      await interaction.editReply({
        content:
          `✅ Link sync complete.\n` +
          `• Scanned: **${scanned}**\n` +
          `• Linked/Updated: **${linked}**\n` +
          `• Skipped (no C#### in nickname): **${skippedNoCid}**\n` +
          `• Skipped (pilot_id not in phpVMS): **${skippedNoPilot}**`,
      });
    } catch (err) {
      console.error('❌ Error in synclinks:', err);
      await interaction.editReply({ content: '❌ An error occurred while syncing links.' });
    }
  },
};
