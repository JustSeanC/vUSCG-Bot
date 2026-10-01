const { EmbedBuilder } = require('discord.js');
const config = require('../config/cgasStations');
const { loadTour, matchStations } = require('../utils/cgas');
const { resolveCommandPilot, fetchActivity, fetchLifetimeStats, fetchVisitsByCodes, activityStatus, formatMinutes } = require('../utils/pilotStats');

const unix = date => Math.floor(date.getTime() / 1000);

module.exports = {
  name: 'myactivity',
  async execute({ interaction, db, hasRole, roles }) {
    await interaction.deferReply({ ephemeral: true });
    let pilot;
    try { pilot = await resolveCommandPilot(db, interaction, hasRole, roles); }
    catch (error) { console.error('Activity pilot lookup failed:', error); return interaction.editReply('❌ The pilot database could not be queried. Please try again later.'); }
    if (pilot.error === 'conflicting_targets') return interaction.editReply('❌ Choose either `user` or `pilot_id`, not both.');
    if (pilot.error === 'forbidden_target') return interaction.editReply('❌ Only Command Staff and Instructor Pilots may view another pilot.');
    if (pilot.error === 'target_unlinked') return interaction.editReply(`❌ **${pilot.targetName}** is not linked to a phpVMS pilot.`);
    if (pilot.error === 'unlinked') return interaction.editReply('❌ Your Discord account is not linked to a pilot, and no C#### pilot identifier was found in your nickname.');
    if (pilot.error === 'missing_user') return interaction.editReply(`❌ Your account resolves to **C${pilot.pilotId}**, but that pilot does not exist in phpVMS.`);

    const tour = loadTour(config);
    let values;
    try { values = await Promise.all([
      fetchActivity(db, pilot.id), fetchLifetimeStats(db, pilot.id),
      fetchVisitsByCodes(db, pilot.id, tour.valid ? [...new Set(tour.stations.flatMap(s => s.airportCodes))] : []),
    ]); } catch (error) { console.error('Activity statistics query failed:', error); return interaction.editReply('❌ The pilot database could not be queried. Please try again later.'); }
    const [lastSubmitted, stats, stationVisits] = values;
    const activity = activityStatus(lastSubmitted);
    const completed = tour.valid ? matchStations(tour.stations, stationVisits).filter(s => s.visited).length : 0;
    const aircraft = stats.aircraft.length
      ? stats.aircraft.map(a => a.registration || `Aircraft ID ${a.aircraft_id} (registration unavailable)`).join(', ').slice(0, 1000)
      : 'None';
    const activityText = activity
      ? `Last submitted: <t:${unix(activity.last)}:F> (<t:${unix(activity.last)}:R>)\nDays since submission: **${activity.daysSince}**\n90-day cutoff: <t:${unix(activity.cutoff)}:F> (<t:${unix(activity.cutoff)}:R>)\nStatus: **${activity.label}**${activity.remainingMs > 0 ? ` — ${activity.daysRemaining} day(s) remaining` : ''}`
      : '**No submitted flights found.** No last-flight date or grace period has been assumed.';
    const embed = new EmbedBuilder().setTitle(`${pilot.name || 'Pilot'} (C${pilot.pilot_id}) — Pilot Activity`).setColor(activity?.color || 0x95a5a6)
      .setDescription(`**90-day activity (submitted PIREPs)**\n${activityText}`)
      .addFields(
        { name: 'Accepted PIREPs', value: String(stats.accepted_count || 0), inline: true },
        { name: 'Flight time', value: formatMinutes(stats.flight_minutes), inline: true },
        { name: 'Distance', value: `${Number(stats.distance_nm || 0).toLocaleString()} NM`, inline: true },
        { name: 'Unique arrival airports', value: String(stats.unique_arrivals || 0), inline: true },
        { name: 'Unique airframes', value: String(stats.unique_aircraft || 0), inline: true },
        { name: 'CGAS completion', value: tour.valid ? `${completed}/${tour.stations.length} (tour ${tour.version})` : 'Station list not configured', inline: true },
        { name: 'Airframes flown', value: aircraft, inline: false },
      ).setFooter({ text: 'Lifetime statistics use accepted PIREPs only; arrivals, not departures, count as visits.' });
    return interaction.editReply({ embeds: [embed] });
  },
};
