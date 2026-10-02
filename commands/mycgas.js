const { EmbedBuilder } = require('discord.js');
const config = require('../config/cgasStations');
const { loadTour, matchStations } = require('../utils/cgas');
const { resolveCommandPilot, fetchVisitsByCodes } = require('../utils/pilotStats');
const { sendEphemeralPages } = require('../utils/pagination');
const PAGE_SIZE = 8;
const date = v => v ? `<t:${Math.floor(new Date(v).getTime() / 1000)}:d>` : '—';

module.exports = { name: 'mycgas', async execute({ interaction, db, hasRole, roles }) {
  await interaction.deferReply({ ephemeral: true });
  const tour = loadTour(config);
  if (!tour.valid) return interaction.editReply(`ℹ️ The CGAS tour is not configured safely: ${tour.errors.join('; ')}.`);
  let pilot;
  try { pilot = await resolveCommandPilot(db, interaction, hasRole, roles); }
  catch (error) { console.error('CGAS pilot lookup failed:', error); return interaction.editReply('❌ The pilot database could not be queried. Please try again later.'); }
  if (pilot.error === 'conflicting_targets') return interaction.editReply('❌ Choose either `user` or `pilot_id`, not both.');
  if (pilot.error === 'forbidden_target') return interaction.editReply('❌ Only Command Staff and Instructor Pilots may view another pilot.');
  if (pilot.error === 'target_unlinked') return interaction.editReply(`❌ **${pilot.targetName}** is not linked to a phpVMS pilot.`);
  if (pilot.error === 'unlinked') return interaction.editReply('❌ Your Discord account is not linked to a pilot, and no C#### identifier was found in your nickname.');
  if (pilot.error === 'missing_user') return interaction.editReply(`❌ Linked pilot **C${pilot.pilotId}** does not exist in phpVMS.`);
  const codes = [...new Set(tour.stations.flatMap(s => s.airportCodes))];
  let visits;
  try { visits = await fetchVisitsByCodes(db, pilot.id, codes); }
  catch (error) { console.error('CGAS progress query failed:', error); return interaction.editReply('❌ The pilot database could not be queried. Please try again later.'); }
  const results = matchStations(tour.stations, visits);
  const completed = results.filter(s => s.visited).length;
  const pages = Math.ceil(results.length / PAGE_SIZE);
  return sendEphemeralPages(interaction, { pageCount: pages, id: `mycgas:${interaction.id}`, render: async page => {
    const lines = results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(s => `${s.visited ? '✅' : '⬜'} **${s.name}** (${s.airportCodes.join(' / ')})\nFirst: ${date(s.firstVisit)} · latest: ${date(s.lastVisit)}`);
    return { embeds: [new EmbedBuilder().setTitle(`${pilot.name || 'Pilot'} (C${pilot.pilot_id}) — CGAS Tour ${tour.version}`).setColor(0x1f8b4c).setDescription(`**${completed}/${results.length} (${Math.round(completed / results.length * 100)}%) complete**\nAn accepted PIREP arrival counts; departures do not.\n\n${lines.join('\n\n')}`).setFooter({ text: `Page ${page + 1}/${pages}` })] };
  }});
}};
