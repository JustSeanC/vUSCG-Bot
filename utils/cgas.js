const crypto = require('crypto');

function normalizeStations(stations = []) {
  return stations.map(s => ({
    ...s,
    id: String(s.id || '').trim(),
    name: String(s.name || '').trim(),
    airportCodes: [...new Set((s.airportCodes || []).map(c => String(c).trim().toUpperCase()).filter(Boolean))].sort(),
  }));
}

function loadTour(config) {
  const version = String(config?.version || '').trim();
  const stations = normalizeStations(config?.stations);
  const ids = new Set();
  const errors = [];
  if (!version) errors.push('tour version is missing');
  if (!stations.length) errors.push('station roster is empty');
  for (const station of stations) {
    if (!station.id || ids.has(station.id)) errors.push(`station ID is missing or duplicated: ${station.id || '(empty)'}`);
    ids.add(station.id);
    if (!station.name) errors.push(`station ${station.id || '(unknown)'} has no display name`);
    if (!station.airportCodes.length) errors.push(`station ${station.id || '(unknown)'} has no airport aliases`);
  }
  const requirements = stations.map(({ id, airportCodes }) => ({ id, airportCodes }));
  const requirementHash = crypto.createHash('sha256').update(JSON.stringify(requirements)).digest('hex');
  return { version, stations, requirements, requirementHash, valid: errors.length === 0, errors };
}

function matchStations(stations, airportRows) {
  const visits = new Map(airportRows.map(r => [String(r.code).toUpperCase(), r]));
  return normalizeStations(stations).map(station => {
    const matches = station.airportCodes.map(c => visits.get(c)).filter(Boolean);
    const first = matches.filter(r => r.first_visit).sort((a, b) => {
      const date = new Date(a.first_visit) - new Date(b.first_visit);
      return date || String(a.first_pirep_id || '').localeCompare(String(b.first_pirep_id || ''));
    })[0];
    const dates = matches.flatMap(r => [r.first_visit, r.last_visit]).filter(Boolean).map(v => new Date(v));
    return { ...station, visited: matches.length > 0, firstVisit: first ? new Date(first.first_visit) : null,
      firstPirepId: first?.first_pirep_id || null, lastVisit: dates.length ? new Date(Math.max(...dates)) : null };
  });
}

function completionFromVisits(tour, airportRows) {
  if (!tour.valid) return { complete: false, results: [], error: tour.errors.join('; ') };
  const results = matchStations(tour.stations, airportRows);
  if (results.some(s => !s.visited)) return { complete: false, results };
  const finalStation = [...results].sort((a, b) => (b.firstVisit - a.firstVisit) ||
    String(b.firstPirepId || '').localeCompare(String(a.firstPirepId || '')) || a.id.localeCompare(b.id))[0];
  return { complete: true, results, completedAt: finalStation.firstVisit, finalStation,
    finalPirepId: finalStation.firstPirepId };
}

module.exports = { normalizeStations, loadTour, matchStations, completionFromVisits };
