const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

async function sendEphemeralPages(interaction, { pageCount, render, id, timeout = 5 * 60 * 1000 }) {
  let page = 0;
  const controls = () => pageCount <= 1 ? [] : [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${id}:prev`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`${id}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === pageCount - 1)
  )];
  const message = await interaction.editReply({ ...(await render(page)), components: controls() });
  if (pageCount <= 1 || !message?.createMessageComponentCollector) return;
  const collector = message.createMessageComponentCollector({ time: timeout });
  collector.on('collect', async button => {
    if (button.user.id !== interaction.user.id) return button.reply({ content: 'Only the requester can use these buttons.', ephemeral: true });
    page = Math.max(0, Math.min(pageCount - 1, page + (button.customId.endsWith(':next') ? 1 : -1)));
    await button.update({ ...(await render(page)), components: controls() });
  });
  collector.on('end', async () => { try { await interaction.editReply({ components: [] }); } catch {} });
}

module.exports = { sendEphemeralPages };
