// rankSync.js
// Keeps Discord roles in sync with phpVMS rank_id values (O-3 → O-6 only).

// Map phpVMS rank_id → Discord role ID
const rankRoles = {
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
    "SELECT pilot_id, rank_id, state FROM users WHERE state IN (1,3) AND pilot_id >= 2000"
  );

  for (const pilot of rows) {
    try {
      const expectedNickname = `C${pilot.pilot_id} `;
      const member = guild.members.cache.find(
        (m) => m.nickname && m.nickname.startsWith(expectedNickname)
      );

      if (!member) {
        console.warn(
          `⚠️ Skipping pilot ${pilot.pilot_id} — no Discord member with nickname "${expectedNickname}…"`
        );
        continue;
      }

      console.log(
        `🔍 Sync check → Pilot C${pilot.pilot_id} | DB rank_id=${pilot.rank_id} | state=${pilot.state}`
      );

      // Only enforce roles for O-3 → O-6
      if (pilot.rank_id >= 14 && pilot.rank_id <= 17) {
        const desiredRole = rankRoles[pilot.rank_id];

        // Remove all other O-3 → O-6 roles
        const rolesToRemove = Object.values(rankRoles).filter(
          (r) => r !== desiredRole
        );
        for (const roleId of rolesToRemove) {
          if (member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId).catch(() => {});
          }
        }

        // Add the correct rank role if missing
        if (desiredRole && !member.roles.cache.has(desiredRole)) {
          await member.roles.add(desiredRole).catch(() => {});
          console.log(
            `✅ Synced ${member.user.tag} → rank_id ${pilot.rank_id}`
          );
        }
      } else {
        // If O-1 (12) or O-2 (13), make sure they don’t have O-3+ roles
        const cleanupRoles = Object.values(rankRoles);
        for (const roleId of cleanupRoles) {
          if (member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId).catch(() => {});
            console.log(
              `🧹 Removed higher role from ${member.user.tag} (rank_id=${pilot.rank_id})`
            );
          }
        }
      }
    } catch (err) {
      console.error(`❌ Error syncing pilot ${pilot.pilot_id}:`, err.message);
    }
  }

  console.log(`[⏰ Rank Sync] Completed at ${new Date().toLocaleTimeString()}`);
}

module.exports = syncRanks;
