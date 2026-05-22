module.exports = {
  name: 'activity90',

  async execute(ctx) {
    const { interaction, db, client, hasRole, roles } = ctx;

    if (!hasRole(roles.COMMAND_STAFF_ROLE_ID)) {
      return interaction.reply({
        content: '❌ You do not have permission to use this command.',
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const { runActivity90DayReport } = require('../utils/activity90Day');
      const result = await runActivity90DayReport({
        client,
        db,
        channelId: '1507352324194959360',
        force: true,
      });

      if (result?.skipped) {
        return interaction.editReply('ℹ️ Activity report skipped (already posted today).');
      }

      return interaction.editReply(
        `✅ 90-day activity report posted. Active: **${result.activeCount}**, Added: **${result.added}**, Removed: **${result.removed}**.`
      );
    } catch (err) {
      console.error('❌ Error running /activity90:', err);
      return interaction.editReply('❌ Failed to run 90-day activity report.');
    }
  },
};
