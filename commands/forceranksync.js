module.exports = {
  name: 'forceranksync',

  async execute(ctx) {
    const { interaction, db, hasRole, roles } = ctx;

    if (!hasRole(roles.COMMAND_STAFF_ROLE_ID)) {
      return interaction.reply({
        content: '❌ You do not have permission to use this command.',
        ephemeral: true,
      });
    }

    try {
      await interaction.deferReply();

      const [ranks] = await db.query(
        'SELECT id, hours FROM ranks WHERE id IN (14, 15, 16, 17) ORDER BY hours ASC'
      );

      const [pilots] = await db.query(
        'SELECT id, pilot_id, rank_id, flight_time FROM users'
      );

      let updatedCount = 0;

      for (const pilot of pilots) {
        const hours = pilot.flight_time / 60;
        let newRankId = pilot.rank_id;

        if (pilot.rank_id >= 13) {
          let qualifiedRank = null;

          for (const rank of ranks) {
            if (hours >= rank.hours) qualifiedRank = rank.id;
          }

          newRankId = qualifiedRank !== null ? qualifiedRank : 13;
        }

        if (newRankId !== pilot.rank_id) {
          await db.query('UPDATE users SET rank_id = ? WHERE id = ?', [newRankId, pilot.id]);
          updatedCount++;
          console.log(`✅ Updated C${pilot.pilot_id} → rank_id ${newRankId} (${hours.toFixed(1)} hrs)`);
        }
      }

      await interaction.editReply({
        content: `✅ Force rank sync complete. ${updatedCount} pilots updated.`,
      });

    } catch (err) {
      console.error('❌ Error in forceranksync:', err);
      await interaction.editReply({
        content: '❌ An error occurred during force rank sync.',
      });
    }
  },
};
