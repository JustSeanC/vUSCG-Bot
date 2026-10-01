function normalizeStations(stations) {
  return stations.map(s => ({ ...s, airportCodes: [...new Set((s.airportCodes || []).map(c => String(c).toUpperCase()))] }));
}

function matchStations(stations, airportRows) {
  const visits = new Map(airportRows.map(r => [String(r.code).toUpperCase(), r]));
  return normalizeStations(stations).map(station => {
    const matches = station.airportCodes.map(c => visits.get(c)).filter(Boolean);
    const dates = matches.flatMap(r => [r.first_visit, r.last_visit]).filter(Boolean).map(v => new Date(v));
    return {
      ...station,
      visited: matches.length > 0,
      firstVisit: dates.length ? new Date(Math.min(...dates)) : null,
      lastVisit: dates.length ? new Date(Math.max(...dates)) : null,
    };
  });
}

module.exports = { normalizeStations, matchStations };
