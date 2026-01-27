module.exports = {
  name: 'moveaircraft',

  async execute(ctx) {
    const { interaction, db, hasRole, roles, client } = ctx;

    // Misconfig check
    if (!roles.COMMAND_STAFF_ROLE_ID) {
      return interaction.reply({
        content: '❌ Bot misconfiguration: COMMAND_STAFF_ROLE_ID is missing in .env',
        ephemeral: true,
      });
    }

    // Permission check
    if (!hasRole(roles.COMMAND_STAFF_ROLE_ID)) {
      return interaction.reply({
        content: '❌ You do not have permission to use this command.',
        ephemeral: true,
      });
    }

    const ferryChannelId = '1397078967244161224';

    const registration = interaction.options.getString('registration', true).trim().toUpperCase();
    const newLocation = interaction.options.getString('airport', true).trim().toUpperCase();
    const reasonRaw = interaction.options.getString('reason');
    const reason = reasonRaw && reasonRaw.trim().length ? reasonRaw.trim() : 'No reason provided';

    await interaction.deferReply({ ephemeral: true });

    try {
      // 1) Find aircraft + current location
      const [acRows] = await db.query(
        'SELECT airport_id FROM aircraft WHERE registration = ? LIMIT 1',
        [registration]
      );

      if (acRows.length === 0) {
        return interaction.editReply({
          content: `❌ No aircraft found with registration **${registration}**.`,
        });
      }

      const currentLocation = (acRows[0].airport_id || 'UNKNOWN').toUpperCase();

      // 2) Validate destination airport exists
      const [aptRows] = await db.query(
        'SELECT icao FROM airports WHERE icao = ? LIMIT 1',
        [newLocation]
      );

      if (aptRows.length === 0) {
        return interaction.editReply({
          content: `❌ Airport **${newLocation}** was not found in the airports table. Add it first, then try again.`,
        });
      }

      // 3) Update aircraft location
      await db.query(
        'UPDATE aircraft SET airport_id = ? WHERE registration = ?',
        [newLocation, registration]
      );

      // 4) Log to ferry list channel
      try {
        const ch = await client.channels.fetch(ferryChannelId);
        if (ch && ch.isTextBased()) {
          await ch.send(
            `<@${interaction.user.id}> moved **${registration}** from **${currentLocation}** to **${newLocation}** for **${reason}**`
          );
        }
      } catch (e) {
        console.warn('⚠️ Could not post to ferry list channel:', e?.message ?? e);
      }

      // 5) Staff confirmation
      await interaction.editReply({
        content: `✅ Updated **${registration}**: **${currentLocation}** → **${newLocation}** (Reason: ${reason})`,
      });

    } catch (err) {
      console.error('❌ Error in moveaircraft:', err);
      await interaction.editReply({
        content: '❌ An error occurred while moving the aircraft.',
      });
    }
  },
};
