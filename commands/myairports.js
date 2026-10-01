const { EmbedBuilder } = require('discord.js');
const { resolvePilot, fetchAirportPage } = require('../utils/pilotStats');
const { sendEphemeralPages } = require('../utils/pagination');
const PAGE_SIZE = 10;
const stamp = v => `<t:${Math.floor(new Date(v).getTime() / 1000)}:d>`;

module.exports = {
  name: 'myairports',
  async execute({ interaction, db }) {
    await interaction.deferReply({ ephemeral: true });
    const pilot = await resolvePilot(db, interaction);
    if (pilot.error === 'unlinked') return interaction.editReply('❌ Your Discord account is not linked to a pilot, and no C#### identifier was found in your nickname.');
    if (pilot.error === 'missing_user') return interaction.editReply(`❌ Linked pilot **C${pilot.pilotId}** does not exist in phpVMS.`);
    const first = await fetchAirportPage(db, pilot.id, PAGE_SIZE, 0);
    if (!first.total) return interaction.editReply('You have no arrival visits on accepted PIREPs. Departures alone do not count as visits.');
    const pages = Math.ceil(first.total / PAGE_SIZE);
    return sendEphemeralPages(interaction, { pageCount: pages, id: `myairports:${interaction.id}`, render: async page => {
      const data = page === 0 ? first : await fetchAirportPage(db, pilot.id, PAGE_SIZE, page * PAGE_SIZE);
      const lines = data.rows.map(r => `**${r.code}** — ${r.name || 'Airport metadata unavailable'}\n${r.arrivals} arrival(s) · first ${stamp(r.first_visit)} · latest ${stamp(r.last_visit)}`);
      return { embeds: [new EmbedBuilder().setTitle(`C${pilot.pilot_id} — Arrival Airports`).setColor(0x3498db).setDescription(lines.join('\n\n')).setFooter({ text: `Page ${page + 1}/${pages} · Accepted PIREP arrivals only; departures do not count.` })] };
    }});
  },
};
