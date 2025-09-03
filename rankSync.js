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

// Roles that should never be removed
const permanentRoles = [
  "1174513368992862218", // vUSCG Pilot (Line Pilot badge)
];

async function syncRanks(client, db, guildId) {
  const guild = await client.guilds.fetch(guildId);

  // Pull active pilots
  const [rows] = await db.query(
    "SELECT pilot_id, discord_id, rank_id FROM users WHERE state = 1"
  );

  for (const pilot of rows) {
    try {
      const member = await guild.members.fetch(pilot.discord_id).catch(() => null);
      if (!member) continue;

      const desiredRank = rankRoles[pilot.rank_id] || null;

      // Remove all O-2 → O-6 roles except the one they should have
      const rolesToRemove = Object.values(rankRoles).filter(r => r !== desiredRank);
      for (const roleId of rolesToRemove) {
        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId).catch(() => {});
        }
      }

      // Add the correct rank role if missing
      if (desiredRank && !member.roles.cache.has(desiredRank)) {
        await member.roles.add(desiredRank).catch(() => {});
        console.log(`✅ Synced ${member.user.tag} → rank_id ${pilot.rank_id}`);
      }

      // Ensure permanent roles are always present
      for (const permRole of permanentRoles) {
        if (!member.roles.cache.has(permRole)) {
          await member.roles.add(permRole).catch(() => {});
        }
      }

    } catch (err) {
      console.error(`❌ Error syncing pilot ${pilot.pilot_id}:`, err.message);
    }
  }
}

module.exports = syncRanks;
