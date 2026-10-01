const { EmbedBuilder } = require('discord.js');
const stations = require('../config/cgasStations');
const { matchStations } = require('../utils/cgas');
const { resolvePilot, fetchVisitsByCodes } = require('../utils/pilotStats');
const { sendEphemeralPages } = require('../utils/pagination');
const PAGE_SIZE = 8;
const date = v => v ? `<t:${Math.floor(new Date(v).getTime() / 1000)}:d>` : '—';

module.exports = { name: 'mycgas', async execute({ interaction, db }) {
  await interaction.deferReply({ ephemeral: true });
  if (!stations.length) return interaction.editReply('ℹ️ The CGAS station list is not configured. An administrator can populate `config/cgasStations.js` using the documented format.');
  const pilot = await resolvePilot(db, interaction);
  if (pilot.error === 'unlinked') return interaction.editReply('❌ Your Discord account is not linked to a pilot, and no C#### identifier was found in your nickname.');
  if (pilot.error === 'missing_user') return interaction.editReply(`❌ Linked pilot **C${pilot.pilotId}** does not exist in phpVMS.`);
  const codes = [...new Set(stations.flatMap(s => s.airportCodes).map(c => c.toUpperCase()))];
  const results = matchStations(stations, await fetchVisitsByCodes(db, pilot.id, codes));
  const completed = results.filter(s => s.visited).length;
  const pages = Math.ceil(results.length / PAGE_SIZE);
  return sendEphemeralPages(interaction, { pageCount: pages, id: `mycgas:${interaction.id}`, render: async page => {
    const lines = results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(s => `${s.visited ? '✅' : '⬜'} **${s.name}** (${s.airportCodes.join(' / ')})\nFirst: ${date(s.firstVisit)} · latest: ${date(s.lastVisit)}`);
    return { embeds: [new EmbedBuilder().setTitle(`C${pilot.pilot_id} — CGAS Visits`).setColor(0x1f8b4c).setDescription(`**${completed}/${results.length} (${Math.round(completed / results.length * 100)}%) complete**\nAn accepted PIREP arrival counts; departures do not.\n\n${lines.join('\n\n')}`).setFooter({ text: `Page ${page + 1}/${pages}` })] };
  }});
}};
