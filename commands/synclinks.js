const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    // Only sync members who have either of these roles:
    const ROLE_PILOT = '1174513368992862218';
    const ROLE_TRAINEE = '1174513529253007370';

    await interaction.deferReply({ ephemeral: true });

    try {
      const guild = interaction.guild;

      let scanned = 0;         // total members scanned (all pages)
      let considered = 0;      // members with pilot/trainee role
      let linked = 0;
      let skippedNoCid = 0;
      let skippedNoPilot = 0;

      let after = undefined;
      let page = 0;

      while (true) {
        // REST pagination (avoids GuildMembersTimeout)
        const batch = await guild.members.fetch({
          limit: 1000,
          ...(after ? { after } : {}),
          withPresences: false,
          force: true,
        });

        if (batch.size === 0) break;

        page++;
        scanned += batch.size;

        for (const member of batch.values()) {
          // ✅ Role filter: only Pilot or Trainee
          const hasPilotOrTrainee =
            member.roles.cache.has(ROLE_PILOT) || member.roles.cache.has(ROLE_TRAINEE);

          if (!hasPilotOrTrainee) continue;

          considered++;

          const displayName = member.nickname || member.displayName || '';
          const m = displayName.match(/\bC(\d{3,6})\b/i);

          if (!m) {
            skippedNoCid++;
            continue;
          }

          const pilotId = parseInt(m[1], 10);
          const discordId = member.user.id;

          // Confirm pilot exists in phpVMS
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

        after = batch.last().id;

        // Progress update every 2 pages
        if (page % 2 === 0) {
          await interaction.editReply({
            content:
              `⏳ Syncing links...\n` +
              `• Pages: **${page}**\n` +
              `• Scanned: **${scanned}**\n` +
              `• Considered (Pilot/Trainee): **${considered}**\n` +
              `• Linked/Updated: **${linked}**\n` +
              `• Skipped (no C####): **${skippedNoCid}**\n` +
              `• Skipped (pilot not found): **${skippedNoPilot}**`,
          });
        }

        await sleep(750); // light throttle
      }

      await interaction.editReply({
        content:
          `✅ Link sync complete.\n` +
          `• Scanned: **${scanned}**\n` +
          `• Considered (Pilot/Trainee): **${considered}**\n` +
          `• Linked/Updated: **${linked}**\n` +
          `• Skipped (no C####): **${skippedNoCid}**\n` +
          `• Skipped (pilot not found): **${skippedNoPilot}**`,
      });
    } catch (err) {
      console.error('❌ Error in synclinks:', err);
      await interaction.editReply({
        content: '❌ An error occurred while syncing links.',
      });
    }
  },
};
