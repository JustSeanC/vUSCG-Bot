// rankSync.js
// Keeps Discord roles in sync with phpVMS rank_id values (O-2 → O-6).

// Map phpVMS rank_id → Discord role ID
const rankRoles = {
  13: "1412811531925717245", // O-2 LTJG
  14: "1412809022523834449", // O-3 LT
  15: "1412809241634410566", // O-4 LCDR
  16: "1412809285360029706", // O-5 CDR
  17: "1412809322357850255", // O-6 CAPT
};

async function syncRanks(client, db, guildId) {
  const guild = await client.guilds.fetch(guildId);
  await guild.members.fetch(); // populate cache

// Pull active (state=1) and on-leave (state=3) pilots
const [rows] = await db.query(
  "SELECT pilot_id, rank_id, flight_time, state FROM users WHERE state IN (1,3) AND pilot_id >= 2000"
);

for (const pilot of rows) {
  try {
    const expectedNickname = `C${pilot.pilot_id} `;
    const member = guild.members.cache.find(m =>
      m.nickname && m.nickname.startsWith(expectedNickname)
    );

    if (!member) {
      console.warn(`⚠️ Skipping pilot ${pilot.pilot_id} — no Discord member with nickname "${expectedNickname}…"`);
      continue;
    }

    const hours = pilot.flight_time / 60;
    console.log(
      `🔍 Sync check → Pilot C${pilot.pilot_id} | DB rank_id=${pilot.rank_id} | state=${pilot.state} | flight_time=${pilot.flight_time} mins (~${hours.toFixed(1)} hrs)`
    );

    let effectiveRankId = pilot.rank_id;

    // Clamp: if <50 hrs, force O-2
    if (hours < 50) {
      effectiveRankId = 13;
    }

    const desiredRank = rankRoles[effectiveRankId] || null;

    // Remove all O-2 → O-6 roles except the desired one
    const rolesToRemove = Object.values(rankRoles).filter(r => r !== desiredRank);
    for (const roleId of rolesToRemove) {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId).catch(() => {});
      }
    }

    // Add the correct rank role
    if (desiredRank && !member.roles.cache.has(desiredRank)) {
      await member.roles.add(desiredRank).catch(() => {});
      console.log(`✅ Synced ${member.user.tag} → rank_id ${effectiveRankId}`);
    }

  } catch (err) {
    console.error(`❌ Error syncing pilot ${pilot.pilot_id}:`, err.message);
  }
}




  console.log(`[⏰ Rank Sync] Completed at ${new Date().toLocaleTimeString()}`);
}

module.exports = syncRanks;
