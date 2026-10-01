const { EmbedBuilder } = require('discord.js');
const stations = require('../config/cgasStations');
const { matchStations } = require('../utils/cgas');
const { resolvePilot, fetchActivity, fetchLifetimeStats, fetchVisitsByCodes, activityStatus, formatMinutes } = require('../utils/pilotStats');

const unix = date => Math.floor(date.getTime() / 1000);

module.exports = {
  name: 'myactivity',
  async execute({ interaction, db }) {
    await interaction.deferReply({ ephemeral: true });
    const pilot = await resolvePilot(db, interaction);
    if (pilot.error === 'unlinked') return interaction.editReply('❌ Your Discord account is not linked to a pilot, and no C#### pilot identifier was found in your nickname.');
    if (pilot.error === 'missing_user') return interaction.editReply(`❌ Your account resolves to **C${pilot.pilotId}**, but that pilot does not exist in phpVMS.`);

    const [lastSubmitted, stats, stationVisits] = await Promise.all([
      fetchActivity(db, pilot.id), fetchLifetimeStats(db, pilot.id),
      fetchVisitsByCodes(db, pilot.id, [...new Set(stations.flatMap(s => s.airportCodes || []).map(c => String(c).toUpperCase()))]),
    ]);
    const activity = activityStatus(lastSubmitted);
    const completed = matchStations(stations, stationVisits).filter(s => s.visited).length;
    const aircraft = stats.aircraft.length
      ? stats.aircraft.map(a => a.registration || `Aircraft ID ${a.aircraft_id} (registration unavailable)`).join(', ').slice(0, 1000)
      : 'None';
    const activityText = activity
      ? `Last submitted: <t:${unix(activity.last)}:F> (<t:${unix(activity.last)}:R>)\nDays since submission: **${activity.daysSince}**\n90-day cutoff: <t:${unix(activity.cutoff)}:F> (<t:${unix(activity.cutoff)}:R>)\nStatus: **${activity.label}**${activity.remainingMs > 0 ? ` — ${activity.daysRemaining} day(s) remaining` : ''}`
      : '**No submitted flights found.** No last-flight date or grace period has been assumed.';
    const embed = new EmbedBuilder().setTitle('My Pilot Activity').setColor(activity?.color || 0x95a5a6)
      .setDescription(`Pilot **C${pilot.pilot_id}**\n\n**90-day activity (submitted PIREPs)**\n${activityText}`)
      .addFields(
        { name: 'Accepted PIREPs', value: String(stats.accepted_count || 0), inline: true },
        { name: 'Flight time', value: formatMinutes(stats.flight_minutes), inline: true },
        { name: 'Distance', value: `${Number(stats.distance_nm || 0).toLocaleString()} NM`, inline: true },
        { name: 'Unique arrival airports', value: String(stats.unique_arrivals || 0), inline: true },
        { name: 'Unique airframes', value: String(stats.unique_aircraft || 0), inline: true },
        { name: 'CGAS completion', value: stations.length ? `${completed}/${stations.length}` : 'Station list not configured', inline: true },
        { name: 'Airframes flown', value: aircraft, inline: false },
      ).setFooter({ text: 'Lifetime statistics use accepted PIREPs only; arrivals, not departures, count as visits.' });
    return interaction.editReply({ embeds: [embed] });
  },
};
