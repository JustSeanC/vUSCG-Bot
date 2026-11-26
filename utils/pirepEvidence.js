const { validPirepId } = require('./pirepBridge');

const PIREP_STATE = { PENDING: 1, ACCEPTED: 2, DELETED: 4, REJECTED: 6 };

function reportUrl(id, base = process.env.PIREP_BASE_URL || 'https://crew.vuscg.com/pireps') {
  if (!validPirepId(id)) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    url.pathname = url.pathname.replace(/\/$/, '') + '/' + id;
    return url.href.length <= 512 ? url.href : null;
  } catch {
    return null;
  }
}

async function readReport(db, id, { lock = false } = {}) {
  if (!validPirepId(id)) return null;
  const [rows] = await db.execute(`SELECT p.id, p.state, p.deleted_at, CAST(u.id AS CHAR) AS user_id,
    u.pilot_id, u.name FROM pireps p LEFT JOIN users u ON u.id = p.user_id
    WHERE p.id = ?${lock ? ' FOR SHARE' : ''}`, [id]);
  const report = rows[0];
  return report?.id === id ? report : null;
}

function reportState(report) {
  return report && report.deleted_at == null ? Number(report.state) : PIREP_STATE.DELETED;
}

module.exports = { PIREP_STATE, reportUrl, readReport, reportState };
