const MS_PER_DAY = 86_400_000;
const ACCEPTED_PIREP_STATE = 2;

function parseUtc(value) {
  if (!value) return null;
  if (value instanceof Date) return new Date(value.getTime());
  const text = String(value);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
}

function activityStatus(lastSubmittedAt, now = new Date()) {
  const last = parseUtc(lastSubmittedAt);
  if (!last || Number.isNaN(last.getTime())) return null;
  const cutoff = new Date(last.getTime() + 90 * MS_PER_DAY);
  const remainingMs = cutoff.getTime() - now.getTime();
  const daysSince = Math.floor((now.getTime() - last.getTime()) / MS_PER_DAY);
  const daysRemaining = Math.ceil(remainingMs / MS_PER_DAY);
  return {
    last, cutoff, remainingMs, daysSince: Math.max(0, daysSince), daysRemaining,
    color: remainingMs <= 0 ? 0xe74c3c : daysRemaining <= 10 ? 0xf1c40f : 0x2ecc71,
    label: remainingMs <= 0 ? 'Cutoff reached' : daysRemaining <= 10 ? 'Warning' : 'Active',
  };
}

function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

async function resolvePilot(db, interaction, { allowNicknameFallback = true } = {}) {
  const [links] = await db.query(
    'SELECT pilot_id FROM discord_links WHERE discord_id = ? LIMIT 1',
    [interaction.user.id]
  );
  let pilotId = links[0]?.pilot_id;
  let source = 'discord_links';
  if (pilotId == null && allowNicknameFallback) {
    const display = interaction.member?.nickname || interaction.member?.displayName || interaction.user?.username || '';
    pilotId = display.match(/\bC(\d{3,6})\b/i)?.[1];
    source = 'nickname';
  }
  if (pilotId == null) return { error: 'unlinked' };
  const [users] = await db.query(
    'SELECT id, pilot_id, name FROM users WHERE pilot_id = ? LIMIT 1',
    [pilotId]
  );
  if (!users.length) return { error: 'missing_user', pilotId: Number(pilotId), source };
  return { ...users[0], source };
}

function isStaff(hasRole, roles) {
  return Boolean(hasRole?.(roles?.COMMAND_STAFF_ROLE_ID) || hasRole?.(roles?.INSTRUCTOR_PILOT_ROLE_ID));
}

async function resolveCommandPilot(db, interaction, hasRole, roles) {
  const targetUser = interaction.options?.getUser?.('user') || null;
  const targetPilotId = interaction.options?.getInteger?.('pilot_id') ?? null;
  if (targetUser && targetPilotId != null) return { error: 'conflicting_targets' };
  if ((targetUser || targetPilotId != null) && !isStaff(hasRole, roles)) return { error: 'forbidden_target' };
  if (!targetUser && targetPilotId == null) return resolvePilot(db, interaction);

  let pilotId = targetPilotId;
  if (targetUser) {
    const [links] = await db.query('SELECT pilot_id FROM discord_links WHERE discord_id = ? LIMIT 1', [targetUser.id]);
    if (links[0]?.pilot_id == null) return { error: 'target_unlinked', targetName: targetUser.displayName || targetUser.username };
    pilotId = links[0].pilot_id;
  }
  const [users] = await db.query('SELECT id, pilot_id, name FROM users WHERE pilot_id = ? LIMIT 1', [pilotId]);
  if (!users.length) return { error: 'missing_user', pilotId: Number(pilotId) };
  return { ...users[0], source: targetUser ? 'discord_links_target' : 'pilot_id_target', targetUser };
}

async function fetchActivity(db, userId) {
  const [rows] = await db.query(
    'SELECT MAX(submitted_at) AS last_submitted_at FROM pireps WHERE user_id = ?',
    [userId]
  );
  return rows[0]?.last_submitted_at || null;
}

async function fetchLifetimeStats(db, userId) {
  const [rows] = await db.query(`
    SELECT COUNT(*) AS accepted_count,
           COUNT(DISTINCT p.aircraft_id) AS unique_aircraft,
           COALESCE(SUM(p.flight_time), 0) AS flight_minutes,
           COALESCE(SUM(p.distance), 0) AS distance_nm,
           COUNT(DISTINCT p.arr_airport_id) AS unique_arrivals
      FROM pireps p
     WHERE p.user_id = ? AND p.state = ? AND p.deleted_at IS NULL`, [userId, ACCEPTED_PIREP_STATE]);
  const [aircraft] = await db.query(`
    SELECT p.aircraft_id, MAX(a.registration) AS registration
      FROM pireps p LEFT JOIN aircraft a ON a.id = p.aircraft_id
     WHERE p.user_id = ? AND p.state = ? AND p.deleted_at IS NULL AND p.aircraft_id IS NOT NULL
     GROUP BY p.aircraft_id ORDER BY registration, p.aircraft_id`, [userId, ACCEPTED_PIREP_STATE]);
  return { ...(rows[0] || {}), aircraft };
}

async function fetchAirportPage(db, userId, limit, offset) {
  const params = [userId, ACCEPTED_PIREP_STATE];
  const [countRows] = await db.query(`SELECT COUNT(DISTINCT arr_airport_id) AS total
    FROM pireps WHERE user_id = ? AND state = ? AND deleted_at IS NULL AND arr_airport_id IS NOT NULL`, params);
  const [rows] = await db.query(`
    SELECT p.arr_airport_id AS code, MAX(a.name) AS name, COUNT(*) AS arrivals,
           MIN(p.submitted_at) AS first_visit, MAX(p.submitted_at) AS last_visit
      FROM pireps p LEFT JOIN airports a ON a.icao = p.arr_airport_id
     WHERE p.user_id = ? AND p.state = ? AND p.deleted_at IS NULL AND p.arr_airport_id IS NOT NULL
     GROUP BY p.arr_airport_id ORDER BY p.arr_airport_id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { total: Number(countRows[0]?.total || 0), rows };
}

async function fetchVisitsByCodes(db, userId, codes) {
  if (!codes.length) return [];
  const placeholders = codes.map(() => '?').join(',');
  const [rows] = await db.query(`
    SELECT arr_airport_id AS code, COUNT(*) AS arrivals,
           MIN(submitted_at) AS first_visit, MAX(submitted_at) AS last_visit,
           SUBSTRING_INDEX(GROUP_CONCAT(id ORDER BY submitted_at, id SEPARATOR ','), ',', 1) AS first_pirep_id
      FROM pireps WHERE user_id = ? AND state = ? AND deleted_at IS NULL
       AND arr_airport_id IN (${placeholders})
     GROUP BY arr_airport_id`, [userId, ACCEPTED_PIREP_STATE, ...codes]);
  return rows;
}

module.exports = { ACCEPTED_PIREP_STATE, activityStatus, formatMinutes, resolvePilot, resolveCommandPilot, isStaff, fetchActivity, fetchLifetimeStats, fetchAirportPage, fetchVisitsByCodes, parseUtc };
