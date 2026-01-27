module.exports = {
  name: 'jumpseat',

  async execute(ctx) {
    const { interaction, db } = ctx;

    const dest = interaction.options.getString('airport', true).trim().toUpperCase();

    // Get display name (nickname if present, else username)
    const displayName =
      interaction.member?.nickname ||
      interaction.member?.displayName ||
      interaction.user?.username ||
      '';

    // ✅ NEW: Try to resolve pilotId from discord_links first (more reliable)
    let pilotId = null;
    try {
      const discordId = interaction.user.id;

      const [linkRows] = await db.query(
        'SELECT pilot_id FROM discord_links WHERE discord_id = ? LIMIT 1',
        [discordId]
      );

      if (linkRows.length > 0 && linkRows[0].pilot_id != null) {
        pilotId = parseInt(linkRows[0].pilot_id, 10);
      }
    } catch (e) {
      console.warn('⚠️ discord_links lookup failed, falling back to nickname parse:', e?.message ?? e);
    }

    // Fallback: Extract pilot ID from something like "C3015 ..."
    if (!pilotId) {
      const m = displayName.match(/\bC(\d{3,6})\b/i);
      if (!m) {
        return interaction.reply({
          content:
            `❌ I couldn't find your Pilot ID in your server nickname.\n` +
            `I looked at: **${displayName || '(blank)'}**\n\n` +
            `Your nickname needs to include something like **C3015**.\n` +
            `Ask Command Staff for assistance, then try again.`,
          ephemeral: true,
        });
      }

      pilotId = parseInt(m[1], 10);
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // 1) Validate destination airport exists
      const [aptRows] = await db.query(
        'SELECT icao FROM airports WHERE icao = ? LIMIT 1',
        [dest]
      );

      if (aptRows.length === 0) {
        return interaction.editReply({
          content: `❌ Airport **${dest}** does not exist in the database.`,
        });
      }

      // 2) Fetch current pilot location
      const [userRows] = await db.query(
        'SELECT pilot_id, curr_airport_id FROM users WHERE pilot_id = ? LIMIT 1',
        [pilotId]
      );

      if (userRows.length === 0) {
        return interaction.editReply({
          content: `❌ I resolved Pilot **C${pilotId}**, but that Pilot ID does not exist in phpVMS.`,
        });
      }

      const current = (userRows[0].curr_airport_id || 'UNKNOWN').toUpperCase();

      if (current === dest) {
        return interaction.editReply({
          content: `✅ You are already listed at **${dest}** (Pilot **C${pilotId}**).`,
        });
      }

      // 3) Update location
      await db.query(
        'UPDATE users SET curr_airport_id = ? WHERE pilot_id = ?',
        [dest, pilotId]
      );

      // 4) Confirm
      await interaction.editReply({
        content: `✅ Jumpseat complete for **C${pilotId}**: **${current} → ${dest}**`,
      });

    } catch (err) {
      console.error('❌ Error in jumpseat:', err);
      await interaction.editReply({
        content: '❌ An error occurred while processing jumpseat travel.',
      });
    }
  },
};
