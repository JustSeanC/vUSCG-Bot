const { EmbedBuilder } = require('discord.js');
const config = require('../config/cgasStations');
const { loadTour, matchStations } = require('../utils/cgas');
const { isStaff, ACCEPTED_PIREP_STATE } = require('../utils/pilotStats');
const { sendEphemeralPages } = require('../utils/pagination');

const PAGE_SIZE = 10;

async function fetchCgasLeaderboard(db, tour) {
  const codes = [...new Set(tour.stations.flatMap(station => station.airportCodes))];
  const placeholders = codes.map(() => '?').join(',');
  const [pilots] = await db.query('SELECT id, pilot_id, name FROM users WHERE state=1 ORDER BY id');
  const [visits] = codes.length ? await db.query(`SELECT user_id, arr_airport_id AS code,
    MIN(submitted_at) AS first_visit, MAX(submitted_at) AS last_visit,
    SUBSTRING_INDEX(GROUP_CONCAT(id ORDER BY submitted_at, id SEPARATOR ','), ',', 1) AS first_pirep_id
    FROM pireps WHERE state=? AND deleted_at IS NULL AND arr_airport_id IN (${placeholders})
    GROUP BY user_id, arr_airport_id`, [ACCEPTED_PIREP_STATE, ...codes]) : [[]];
  const byUser = new Map();
  for (const visit of visits) {
    const key = String(visit.user_id);
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(visit);
  }
  return pilots.map(pilot => {
    const stations = matchStations(tour.stations, byUser.get(String(pilot.id)) || []);
    return { ...pilot, visited: stations.filter(station => station.visited).length };
  }).sort((a, b) => b.visited - a.visited || Number(a.pilot_id) - Number(b.pilot_id));
}

module.exports = {
  name: 'cgasleaderboard',
  fetchCgasLeaderboard,
  async execute({ interaction, db, hasRole, roles }) {
    await interaction.deferReply({ ephemeral: true });
    if (!isStaff(hasRole, roles)) return interaction.editReply('❌ Only Command Staff and Instructor Pilots may view the CGAS leaderboard.');
    const tour = loadTour(config);
    if (!tour.valid) return interaction.editReply(`ℹ️ The CGAS tour is not configured safely: ${tour.errors.join('; ')}.`);
    let pilots;
    try { pilots = await fetchCgasLeaderboard(db, tour); }
    catch (error) { console.error('CGAS leaderboard query failed:', error); return interaction.editReply('❌ The pilot database could not be queried. Please try again later.'); }
    if (!pilots.length) return interaction.editReply('ℹ️ No active pilots were found.');
    const pageCount = Math.ceil(pilots.length / PAGE_SIZE);
    return sendEphemeralPages(interaction, { pageCount, id: `cgasleaderboard:${interaction.id}`, render: async page => {
      const offset = page * PAGE_SIZE;
      const lines = pilots.slice(offset, offset + PAGE_SIZE).map((pilot, index) => {
        const complete = pilot.visited === tour.stations.length ? ' 🏆' : '';
        return `**${offset + index + 1}. ${pilot.name || 'Pilot'} (C${pilot.pilot_id})** — ${pilot.visited}/${tour.stations.length}${complete}`;
      });
      return { embeds: [new EmbedBuilder().setColor(0x1f8b4c).setTitle(`CGAS Tour ${tour.version} — Pilot Progress`)
        .setDescription(lines.join('\n')).setFooter({ text: `Page ${page + 1}/${pageCount} · Most stations visited first` })] };
    }});
  },
};
