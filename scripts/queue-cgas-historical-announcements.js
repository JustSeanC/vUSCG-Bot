const mysql = require('mysql2/promise');
require('dotenv').config();
const config = require('../config/cgasStations');
const { loadTour } = require('../utils/cgas');
const { queueHistoricalAnnouncements } = require('../utils/cgasTourChecker');

async function main() {
  const requestedVersion = process.argv[2];
  const confirmation = process.argv[3];
  const tour = loadTour(config);
  if (!tour.valid) throw new Error(`Invalid CGAS tour configuration: ${tour.errors.join('; ')}`);
  if (requestedVersion !== tour.version || confirmation !== '--confirm') {
    throw new Error(`Refusing to queue announcements. Run: npm run cgas:announce-baseline -- ${tour.version} --confirm`);
  }
  const db = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, timezone: 'Z',
  });
  try {
    const result = await queueHistoricalAnnouncements(db, tour);
    if (result.alreadyQueued) {
      console.log(`Historical announcements for CGAS tour ${tour.version} were already queued; no records changed.`);
    } else {
      console.log(`Queued ${result.queued} historical CGAS completion announcement(s) for tour ${tour.version}.`);
      console.log('The running checker will deliver these jobs with its normal retry and duplicate safeguards.');
    }
  } finally { await db.end(); }
}

main().catch(error => { console.error(`Failed to queue historical CGAS announcements: ${error.message}`); process.exitCode = 1; });
