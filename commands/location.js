const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

async function handlePagination(interaction, dataRows, title, formatRow) {
  const pageSize = 10;
  let page = 0;

  const generateEmbed = (page) => {
    const start = page * pageSize;
    const end = start + pageSize;
    const slice = dataRows.slice(start, end);

    return new EmbedBuilder()
      .setTitle(title)
      .setDescription(slice.map(formatRow).join('\n'))
      .setFooter({ text: `Page ${page + 1} of ${Math.ceil(dataRows.length / pageSize)}` })
      .setColor('Blue');
  };

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('prev')
      .setLabel('⬅️ Previous')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('next')
      .setLabel('➡️ Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(dataRows.length <= pageSize)
  );

  const message = await interaction.editReply({
    embeds: [generateEmbed(page)],
    components: [row],
  });

  const collector = message.createMessageComponentCollector({ time: 5 * 60 * 1000 });

  collector.on('collect', async i => {
    if (i.user.id !== interaction.user.id) {
      return i.reply({ content: '❌ Only the original requester can use these buttons.', ephemeral: true });
    }

    if (i.customId === 'next') page++;
    else if (i.customId === 'prev') page--;

    const newRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('prev')
        .setLabel('⬅️ Previous')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId('next')
        .setLabel('➡️ Next')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page >= Math.floor((dataRows.length - 1) / pageSize))
    );

    await i.update({
      embeds: [generateEmbed(page)],
      components: [newRow],
    });
  });

  collector.on('end', async () => {
    try {
      await message.edit({ components: [] });
    } catch {
      console.warn('⚠️ Could not remove buttons after timeout.');
    }
  });
}

module.exports = {
  name: 'location',

  async execute(ctx) {
    const { interaction, db } = ctx;

    const input = interaction.options.getString('search').toUpperCase();

    try {
      await interaction.deferReply();

      // 1) by registration
      const [regRows] = await db.query(
        'SELECT airport_id, flight_time, icao FROM aircraft WHERE registration = ?',
        [input]
      );

      if (regRows.length > 0) {
        const aircraft = regRows[0];
        const hours = (aircraft.flight_time / 60).toFixed(1);

        const embed = new EmbedBuilder()
          .setTitle(`Aircraft Info: ${input}`)
          .addFields(
            { name: 'Current Location', value: aircraft.airport_id || 'Unknown', inline: true },
            { name: 'Aircraft Type', value: aircraft.icao || 'Unknown', inline: true },
            { name: 'Total Flight Time', value: `${hours} hours`, inline: true }
          )
          .setColor('Blue');

        return interaction.editReply({ embeds: [embed] });
      }

      // 2) by type
      const [typeRows] = await db.query(
        'SELECT registration, airport_id FROM aircraft WHERE icao = ?',
        [input]
      );

      if (typeRows.length > 0) {
        return handlePagination(
          interaction,
          typeRows,
          `Aircraft Type: ${input}`,
          ac => `• **${ac.registration}** — ${ac.airport_id || 'Unknown'}`
        );
      }

      // 3) by airport
      const [locationRows] = await db.query(
        'SELECT registration, icao FROM aircraft WHERE airport_id = ?',
        [input]
      );

      if (locationRows.length > 0) {
        return handlePagination(
          interaction,
          locationRows,
          `Aircraft at Airport: ${input}`,
          ac => `• **${ac.registration}** — ${ac.icao || 'Unknown'}`
        );
      }

      await interaction.editReply({
        content: `❌ No aircraft found matching **${input}**.`,
      });

    } catch (err) {
      console.error('❌ Error fetching location info:', err);
      await interaction.editReply({
        content: '❌ An error occurred while fetching location info.',
      });
    }
  },
};
