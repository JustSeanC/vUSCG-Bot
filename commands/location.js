const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

function statusInfo(codeRaw) {
  const code = (codeRaw || '').toUpperCase();

  switch (code) {
    case 'A': return { label: 'Active', emoji: '🟢', code: 'A' };
    case 'M': return { label: 'Maintenance', emoji: '🛠️', code: 'M' };
    case 'S': return { label: 'Stored', emoji: '📦', code: 'S' };
    case 'R': return { label: 'Retired', emoji: '🪦', code: 'R' };
    case 'C': return { label: 'Scrapped', emoji: '🗑️', code: 'C' };
    default:  return { label: 'Unknown', emoji: '❔', code: code || '?' };
  }
}

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

      // 1) Registration lookup (exact match)
      const [regRows] = await db.query(
        `SELECT registration, airport_id, hub_id, status, flight_time, icao
         FROM aircraft
         WHERE registration = ?`,
        [input]
      );

      if (regRows.length > 0) {
        const ac = regRows[0];
        const hours = ac.flight_time != null ? (ac.flight_time / 60).toFixed(1) : '0.0';
        const s = statusInfo(ac.status);

        const embed = new EmbedBuilder()
          .setTitle(`Aircraft: ${ac.registration}`)
          .addFields(
            { name: 'Type', value: ac.icao || 'Unknown', inline: true },
            { name: 'Status', value: `${s.emoji} **${s.code}** — ${s.label}`, inline: true },
            { name: 'Total Flight Time', value: `${hours} hours`, inline: true },
            { name: 'Current Location', value: ac.airport_id || 'Unknown', inline: true },
            { name: 'Home Location', value: ac.hub_id || 'Unknown', inline: true },
          )
          .setColor('Blue');

        return interaction.editReply({ embeds: [embed] });
      }

      // 2) Type lookup (icao)
      const [typeRows] = await db.query(
        `SELECT registration, icao, status, airport_id, hub_id
         FROM aircraft
         WHERE icao = ?
         ORDER BY registration ASC`,
        [input]
      );

      if (typeRows.length > 0) {
        return handlePagination(
          interaction,
          typeRows,
          `Aircraft Type: ${input}`,
          ac => {
            const s = statusInfo(ac.status);
            const cur = ac.airport_id || 'UNK';
            const home = ac.hub_id || 'UNK';
            return `• **${ac.registration}** — ${s.emoji} ${s.code} | Cur: **${cur}** | Home: **${home}**`;
          }
        );
      }

      // 3) Airport lookup (current location airport_id)
      const [airportRows] = await db.query(
        `SELECT registration, icao, status, airport_id, hub_id
         FROM aircraft
         WHERE airport_id = ?
         ORDER BY icao ASC, registration ASC`,
        [input]
      );

      if (airportRows.length > 0) {
        return handlePagination(
          interaction,
          airportRows,
          `Aircraft Currently at: ${input}`,
          ac => {
            const s = statusInfo(ac.status);
            const home = ac.hub_id || 'UNK';
            const type = ac.icao || 'UNK';
            return `• **${ac.registration}** (${type}) — ${s.emoji} ${s.code} | Home: **${home}**`;
          }
        );
      }

      // 4) Nothing found
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
