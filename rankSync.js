// rankSync.js
// Keeps Discord roles and nicknames in sync with phpVMS rank_id values.

// Map phpVMS rank_id → Discord role ID
const rankRoles = {
  14: "1412809022523834449", // O-3 LT
  15: "1412809241634410566", // O-4 LCDR
  16: "1412809285360029706", // O-5 CDR
  17: "1412809322357850255", // O-6 CAPT
};

// Map phpVMS rank_id → short title for nickname/logging
const rankTitles = {
  12: "ENS",   // O-1 Ensign
  13: "LTJG",  // O-2 LTJG
  14: "LT",    // O-3 LT
  15: "LCDR",  // O-4 LCDR
  16: "CDR",   // O-5 CDR
  17: "CAPT",  // O-6 CAPT
};

async function syncRanks(client, db, guildId) {
  const guild = await client.guilds.fetch(guildId);
  await guild.members.fetch(); // populate cache

  // Pull active (state=1) and on-leave (state=3) pilots
  const [rows] = await db.query(
    "SELECT pilot_id, rank_id, state, name, flight_time FROM users WHERE state IN (1,3) AND pilot_id >= 2000"
  );

  for (const pilot of rows) {
    try {
      const expectedNicknamePrefix = `C${pilot.pilot_id} `;
      const member = guild.members.cache.find(
        (m) => m.nickname && m.nickname.startsWith(expectedNicknamePrefix)
      );

      if (!member) {
        console.warn(
          `⚠️ Skipping pilot ${pilot.pilot_id} — no Discord member with nickname prefix "${expectedNicknamePrefix}…"`
        );
        continue;
      }

      const hours = pilot.flight_time ? (pilot.flight_time / 60).toFixed(1) : 0;
      const rankTitle = rankTitles[pilot.rank_id] || `Unknown(${pilot.rank_id})`;

      console.log(
        `🔍 Sync check → Pilot C${pilot.pilot_id} | Rank=${rankTitle} | flight_time=${pilot.flight_time || 0} mins (~${hours} hrs)`
      );

      // ------------------------
      // ROLE SYNC (O-3 to O-6)
      // ------------------------
      if (pilot.rank_id >= 14 && pilot.rank_id <= 17) {
        const desiredRole = rankRoles[pilot.rank_id];

        // Remove other O-3 → O-6 roles
        for (const roleId of Object.values(rankRoles)) {
          if (roleId !== desiredRole && member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId).catch(() => {});
          }
        }

        // Add the correct rank role
        if (desiredRole && !member.roles.cache.has(desiredRole)) {
          await member.roles.add(desiredRole).catch(() => {});
          console.log(`✅ Synced ${member.user.tag} → Discord role for ${rankTitle}`);
        }
      } else {
        // If O-1 (12) or O-2 (13), ensure no O-3+ roles
        for (const roleId of Object.values(rankRoles)) {
          if (member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId).catch(() => {});
            console.log(
              `🧹 Removed higher role(s) from ${member.user.tag} (rank=${rankTitle})`
            );
          }
        }
      }

      // ------------------------
      // NICKNAME SYNC
      // ------------------------
      let newNickname = `C${pilot.pilot_id}`;
      if (rankTitle && !rankTitle.startsWith("Unknown")) {
        newNickname += ` ${rankTitle}`;
      }

      if (pilot.name) {
        const [firstName, ...lastParts] = pilot.name.trim().split(" ");
        const lastInitial = lastParts.length ? lastParts[0][0].toUpperCase() : "";
        newNickname += ` ${firstName} ${lastInitial}`;
      }

      if (member.nickname !== newNickname) {
        await member.setNickname(newNickname).catch(() => {});
        console.log(`✏️ Updated nickname for ${member.user.tag} → ${newNickname}`);
      }

    } catch (err) {
      console.error(`❌ Error syncing pilot ${pilot.pilot_id}:`, err.message);
    }
  }

  console.log(`[⏰ Rank Sync] Completed at ${new Date().toLocaleTimeString()}`);
}

module.exports = syncRanks;
