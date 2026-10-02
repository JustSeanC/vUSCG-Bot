# vUSCG Discord Bot (phpVMS v7)

Discord bot that integrates with a phpVMS v7 database for onboarding, operations, and basic admin tooling.

This README focuses on:
- **Commands**
- **Who can use them**
- **What they do**
- **How Pilot IDs are resolved (nickname + linking)**
- **Background syncing behavior**

---

## Roles & Permissions

The bot uses role IDs (configured in `.env`) to determine who can run restricted commands:

- **Command Staff** (`COMMAND_STAFF_ROLE_ID`)
  - Full admin permissions for protected commands.
- **Instructor Pilots** (`INSTRUCTOR_PILOT_ROLE_ID`)
  - Used for training workflows and certain staff commands.

Some commands also check for operational roles on the member:
- **Pilot Role:** `ROLEID`
- **Trainee Role:** `ROLEID`

---

## Pilot ID Resolution (How the bot knows who you are)

Many commands need to map a Discord user → phpVMS `pilot_id`.

### 1) Database link (authoritative)
The bot first looks up the Discord ID in `discord_links`. A nickname can never override an existing link. The linked public `pilot_id` is then resolved separately to `users.id`, which is the value stored by `pireps.user_id`.

### 2) Nickname parsing (unlinked accounts only)
For older, unlinked members, the bot can fall back to a `C####` pattern in the member’s nickname/display name.

Examples:
- `C3015 John D` → Pilot ID `3015`
- `C1201 Jane S` → Pilot ID `1201`

If the bot can’t find `C####`, it will refuse commands that require a pilot identity.

### Database linking (created during `/activate`)
During onboarding, `/activate` upserts a record in `discord_links`:

- `discord_id` → `pilot_id`

This makes identity resolution more reliable for new activations.

> Note: Existing members who were never activated via `/activate` may not be present in `discord_links`. For those members, nickname parsing still works.

Database lookup failures are reported as command failures; they are not treated as an unlinked account.

---

## Commands

### `/help` — Anyone
Shows an ephemeral, role-aware command reference. Regular members do not see staff tools; Instructor Pilots and Command Staff see the tools their actual command permissions allow.

### `/myactivity` — Anyone
Shows an ephemeral personal activity summary and lifetime statistics. Example: `/myactivity`.

Command Staff and Instructor Pilots may perform a read-only lookup with either `user` or `pilot_id` (never both), for example `/myactivity user:@Pilot`. Ordinary members are restricted to themselves even if they manually submit target options.

#### Staff pilot lookups

The staff lookup is not a background checker: it is the same `/myactivity`, `/myairports`, or `/mycgas` command with an optional target. At execution time the bot checks the requester's Discord roles against `COMMAND_STAFF_ROLE_ID` and `INSTRUCTOR_PILOT_ROLE_ID`; having either role permits a lookup. Examples:

- `/myactivity user:@Pilot` resolves the selected member only through `discord_links`.
- `/myairports pilot_id:3015` resolves public Pilot ID `3015` through `users.pilot_id`.
- `/mycgas user:@Pilot` shows that pilot's progress against the current tour version.

Use exactly one target option. With no target the commands retain their normal self-service behavior. Responses are ephemeral, read-only, prominently identify the selected pilot, and pagination buttons belong to the staff requester. The `user` form requires the selected member to be linked; use `pilot_id` for an unlinked member. Ordinary members cannot bypass the role check by manually supplying an option. Set both staff role IDs in `.env` and run `node deploy-commands.js` after installing or changing the slash-command definitions.

- **90-day activity** uses the latest submitted PIREP in any state, exactly like the existing activity report. It does not use `updated_at` and does not invent an enrollment grace period when there is no history.
- Times and boundaries are calculated in UTC. The command turns yellow with 10 calendar days or less remaining and red at the precise 90-day instant.
- The scheduled report's SQL uses an inclusive `submitted_at >= UTC_TIMESTAMP() - INTERVAL 90 DAY` boundary. Therefore a PIREP exactly on that report cutoff remains in its result, while the personal countdown describes the cutoff as reached at that exact instant.
- **Lifetime statistics** use accepted PIREPs (`state = 2`) only: count, distinct aircraft IDs, flight time (phpVMS minutes, displayed as hours/minutes), distance in nautical miles, and distinct arrival airports.
- Aircraft registrations are displayed when the current aircraft row still exists. Historic registrations cannot be recovered when that metadata has been deleted, but those PIREPs still count by aircraft ID.
- Jumpseat changes and administrative aircraft moves do not create PIREPs, so they do not count as flights or visits.

### `/myairports` — Anyone
Shows a private, paginated list of airports visited through **arrivals on accepted PIREPs**, including arrival count and first/latest recorded visit. Example: `/myairports`. A departure alone is not a visit, and an airport whose metadata was removed is retained under its recorded code.

Command Staff and Instructor Pilots may use `/myairports user:@Pilot` or `/myairports pilot_id:3015`. A Discord target must have a `discord_links` row; nicknames are never used to infer someone else's identity. Pagination remains controlled by the staff requester.

### `/mycgas` — Anyone
Shows private CGAS completion progress. An arrival on an accepted PIREP earns credit; departures do not, and aliases for one station never award duplicate station credit. Returning to an airport on another accepted flight remains a valid arrival and updates the latest visit.

The command displays progress against the current version. Command Staff and Instructor Pilots may use `/mycgas user:@Pilot` or `/mycgas pilot_id:3015`; these lookups only read the shared progress calculation and cannot award or announce completion.

#### Configure the CGAS roster

The authoritative, versioned roster is `config/cgasStations.js`:

```js
module.exports = {
  version: '2026.1',
  stations: [
    { id: 'stable-station-id', name: 'Air Station Name', airportCodes: ['KABC', 'ABC'] },
  ],
};
```

Keep each `id` stable through display-name changes. Put all accepted ICAO/code aliases in `airportCodes`; matching is case-insensitive. An empty roster, missing version, duplicate/missing station ID, or station without aliases is invalid and can never award completion.

Station IDs and airport aliases form the requirements snapshot. **Increment `version` deliberately whenever either changes.** The checker stores and compares a SHA-256 hash, and refuses to run with an actionable error if requirements change under the same version. Display-name corrections do not alter the hash or reset progress. Old version records and earned achievements are retained.

Roster maintenance rules:

- **Correct only a displayed station name:** edit `name` and keep both `id` and `version` unchanged.
- **Correct/add/remove an ICAO or other qualifying alias:** edit `airportCodes` and increment `version` (for example, `2026.1` to `2026.2`).
- **Add or delete a station:** edit the `stations` array and increment `version`.
- Keep an existing station's `id` stable unless it is truly a different requirement. IDs must be unique and aliases should be uppercase for readability (matching itself is case-insensitive).

A new version gets its own silent baseline on the first successful scan; achievements from older versions remain stored. Commit and deploy the configuration change, restart the bot, and confirm the new row in `bot_cgas_tour_versions` reaches `baseline_status='complete'`. Never edit the saved `roster_json` or requirement hash to bypass a mismatch.

#### Optional one-time announcement of baseline completers

The normal first scan intentionally records historical completers silently. To announce that already-baselined group exactly once for the current version:

1. Apply `migrations/002_cgas_historical_announcements.sql` to the same database as migration 001.
2. Confirm `CGAS_TOUR_CHANNEL_ID`, allow the bot to finish the baseline, and note the current version in `config/cgasStations.js`.
3. From the deployed bot directory, run the explicit, version-pinned command (replace the example version if needed):

   ```bash
   npm run check
   npm run cgas:announce-baseline -- 2026.1 --confirm
   ```

   Do not copy only the migration or CLI script onto an older checkout: the command also requires the matching `queueHistoricalAnnouncements` export in `utils/cgasTourChecker.js`. `npm run check` must succeed first. A syntax error here means the deployed JavaScript is incomplete or was edited during deployment; replace it from the same commit rather than trying to repair the production file by hand.

The command does not send directly. In one database transaction it changes only that version's `baselined=1`/`announcement_status='none'` records into durable pending jobs and records a permanent timestamp and count on the version row. The running five-minute checker then sends them using the normal delivery safeguards. Re-running the command, running it concurrently, or restarting after it succeeds cannot queue that historical group again. A failed transaction leaves the one-time marker unset so it can be safely retried. Empty historical groups are also marked as successfully queued once. This campaign does not mass-award the optional role.

### `/activate` — Command Staff only
**Purpose:** Onboard a new member and start their training case.

**What it does:**
- Validates the pilot exists in phpVMS (`users` table).
- Updates phpVMS:
  - sets `users.state = 1` (active)
  - sets onboarding `rank_id` (as configured in code)
- Updates Discord:
  - sets nickname to `C#### First L`
  - assigns/removes onboarding roles (Cadet, Guest, etc.)
- Creates a **private training thread** in the training channel.
- Adds:
  - the target user
  - the command runner
  - **all members** with the Instructor Pilot role (auto-invite)
- Posts a kickoff message in the thread (optionally includes notes).
- Upserts `discord_links` (Discord user → pilot_id).

**Options:**
- `pilot_id` (int)
- `user` (Discord user)
- `notes` (optional string)

---

### `/promote` — Instructor Pilots OR Command Staff
**Purpose:** Promote a trainee who completed training.

**What it does:**
- Updates phpVMS: sets `users.rank_id` to the new rank (as configured in code).
- Updates Discord:
  - removes trainee/cadet role(s)
  - adds Pilot identity role
  - adds specialization role (Fixed or Rotary)
  - applies rank role(s) as configured

**Options:**
- `pilot_id` (int)
- `user` (Discord user)
- `track` (`fixed` or `rotary`)

---

### `/forceranksync` — Command Staff only
**Purpose:** Force a full rank update pass using phpVMS flight time.

**What it does:**
- Reads `users.flight_time` (minutes) → converts to hours.
- Uses rank thresholds (from phpVMS `ranks` table and/or configured IDs).
- Updates `users.rank_id` where needed.

> Use carefully: this can update many pilots at once.

---

### `/location` — Anyone
**Purpose:** Search and display aircraft by:
- registration (e.g., `C6052`)
- aircraft type/ICAO (e.g., `H60`)
- current airport (e.g., `KPIE`)

**Data sources:**
- Current location: `aircraft.airport_id`
- Home location: `aircraft.hub_id`
- Status: `aircraft.status`

**Status codes:**
- `A` = Active
- `M` = Maintenance
- `S` = Stored
- `R` = Retired
- `C` = Scrapped

**Sorting rules for list views (type/airport):**
1) Active (`A`)
2) Maintenance (`M`)
3) Stored (`S`)
4) Retired/Scrapped (`R`/`C`) — moved to the end

**Display rules:**
- Retired/Scrapped aircraft omit “Home” location in list outputs.

---

### `/mission` — Anyone
**Purpose:** Generate a mission assignment and select an available aircraft.

**What it does:**
- Selects an aircraft matching the requested type (optionally restricted to a base).
- Generates a point of interest (POI) within allowed bounds:
  - Uses GeoJSON polygons in `geo_bounds/` when available.
  - Uses IsItWater checks for water-only point validation (rate limited).
- Builds a Mapbox static map showing base and POI pins.
- Uses mission “flavor text” to generate the scenario.

**Options:**
- `type` (mission category)
- `aircraft` (aircraft type/ICAO)
- `base` (optional base ICAO)
- `duration` (`short`, `medium`, `long`)

---

### `/moveaircraft` — Command Staff OR Instructor Pilots
**Purpose:** Move an aircraft’s **current** location in phpVMS and log it.

**What it does:**
- Validates the aircraft exists (`aircraft.registration`).
- Validates the destination airport exists (`airports.icao`).
- Updates phpVMS:
  - `aircraft.airport_id` → new airport
- Logs to ferry list channel:
  - `USER moved REG from OLD to NEW for REASON`

**Options:**
- `registration` (string)
- `airport` (string ICAO)
- `reason` (optional string)
- `status` (optional) *(if enabled in your code)*

---

### `/jumpseat` — Anyone
**Purpose:** Let a member change their phpVMS “current airport.”

**What it does:**
- Resolves pilot ID from nickname (`C####`) (or `discord_links` if enabled).
- Validates destination airport exists (`airports.icao`).
- Updates phpVMS:
  - `users.curr_airport_id` → destination

**Options:**
- `airport` (string ICAO)

---

### `/manualpirep` — Anyone (approval based on role)
**Purpose:** Create a PIREP directly in phpVMS from Discord.

**Approval rules:**
- If member has **Pilot role** (`ROLEID`) → **auto-approved**
- If member has **Trainee role** (`ROLEID`) → **pending approval**

**What it does:**
- Validates:
  - aircraft exists
  - departure/arrival airports exist
- Flight time input supports multiple formats *(if enabled in your code)*:
  - `1.25` hours → 75 minutes
  - `1:30` → 90 minutes
  - `90` → 90 minutes
- Distance:
  - can be auto-calculated from airport lat/lon when available
  - can be overridden by user input
- Inserts into phpVMS `pireps` with UTC timestamps.
- Optionally relocates:
  - `users.curr_airport_id` → arrival
  - `aircraft.airport_id` → arrival *(usually skipped for retired/scrapped)*
- Sends:
  - an ephemeral confirmation to the user
  - a flight summary post to a log channel

The old manual-report destination was a hard-coded channel (`1219417084652556348`) and the repository does not establish that channel's human-readable identity. Set `MANUAL_PIREP_CHANNEL_ID` to the confirmed destination. Set `CGAS_TOUR_CHANNEL_ID` separately to the confirmed **Mission Notices** channel; the values may be the same after staff confirms that identity.

---

## Background Processes

### CGAS tour completion checker

The checker runs at startup and every `CGAS_TOUR_CHECK_INTERVAL_SECONDS` (default 300 seconds). An in-process guard and a MySQL named lock prevent overlapping runs. It scans every active phpVMS user (`users.state = 1`) in bounded batches and aggregates qualifying arrivals in SQL rather than loading individual PIREPs.

A visit uses the same rule as `/mycgas`: the PIREP belongs to `users.id`, has accepted state `2`, has not been soft-deleted, and arrives at a configured alias. Pending, rejected, and deleted reports do not count. Jumpseats and administrative relocations create no PIREP and therefore do not count. Website, ACARS, and Discord manual PIREPs all qualify once accepted because detection reads phpVMS rather than the submission path.

For every station the checker records the earliest qualifying `submitted_at`, with PIREP ID as a deterministic tie-breaker. Completion is dated at the latest of those first visits and stores that final station and PIREP. If staff approves an old pending report later, detection happens after approval but the completion date remains the historical flight/submission timestamp—not `updated_at` or approval time.

#### Durable state and first-run baseline

Apply `migrations/001_cgas_tour.sql` before starting this feature. Apply `migrations/002_cgas_historical_announcements.sql` before using the optional one-time historical announcer. The bot-owned tables persist:

- version, immutable station-ID/alias snapshot, requirements hash, and baseline marker;
- one completion per phpVMS `users.id` and tour version;
- historical completion/final-stop details and detection time;
- baseline/announcement state, retry details, and Discord channel/message IDs;
- optional role state and retries independently of announcement delivery.

On the first **successful** scan of a new version, existing completers are inserted as baselined and are not announced or mass-awarded roles. The marker is committed only after the entire scan succeeds; zero completers is a successful baseline. A scan failure rolls the transaction back. Missing tables fail closed rather than announcing. Do not delete or partially edit these tables: restore durable state from backup if it is corrupt.

After baseline, newly discovered completions get a durable pending job before Discord delivery. Database uniqueness plus atomic claims prevents normal duplicate sends. Definite Discord failures retry with bounded exponential backoff. Before sending, state changes to `sending`; after restart, the checker searches the latest 100 destination messages for the persisted pilot ID, final stop, and completion date. If a network failure or send/ack crash leaves the result ambiguous and reconciliation cannot prove delivery, it records `uncertain` for manual review instead of blindly reposting. Discord and MySQL cannot provide a shared exactly-once transaction, so this deliberately favors avoiding duplicates over claiming perfect exactly-once delivery.

Missing channel access leaves jobs pending and logs an actionable error. `CGAS_TOUR_CHANNEL_ID` is mandatory for delivery. Announcement mentions allow only the linked pilot; unlinked or unavailable members use the sanitized phpVMS display name and public Pilot ID.

Set optional `CGAS_TOUR_ROLE_ID` to award new, linked guild members a completion role. Empty disables it. Role attempts are tracked and retried separately, never block/repost announcements, never remove earned roles, and exclude baseline history. The bot needs **Manage Roles**, and its highest role must be above the completion role.

Set `CGAS_TOUR_AWARD_ID=16` to grant the phpVMS **CGAS Grand Tour** award shown at `/admin/awards/16/`. First apply `migrations/003_cgas_phpvms_awards.sql`. Award delivery is idempotent (`INSERT IGNORE` into the detected phpVMS `user_awards` or `award_user` pivot), retried and tracked separately from Discord delivery. Existing stored completions are intentionally queued by migration 003 so previously earned tours appear on the website too. Confirm that award 16 exists in the same phpVMS database before enabling it; leave the setting empty to disable website grants.

The public completion embed uses the pilot's first name and last initial (plus public Pilot ID), not a Discord mention or full surname. Its footer contains only the `/mycgas` prompt; reconciliation compares the persisted pilot ID, final stop, and completion date instead of displaying an internal identifier.

Command Staff and Instructor Pilots can run the ephemeral `/cgasleaderboard` command. It lists every active pilot, ordered from most current-tour stations visited to least, marks completed tours with 🏆, paginates ten pilots at a time, and restricts buttons to the staff requester. It is read-only and does not grant awards or trigger announcements.

### Hourly rank sync
On startup (and then every hour), the bot runs rank sync:
- Reads pilot hours from phpVMS
- Updates `users.rank_id`
- Updates Discord rank roles using your configured mapping file (if present)

---

## Notes
- This bot assumes phpVMS v7 schema conventions (e.g., `users`, `aircraft`, `airports`, `pireps`).
- Identity resolution depends on consistent `C####` nicknames and/or `discord_links` created during `/activate`.

## Test and deployment workflow

From the bot checkout, review and deploy the feature branch normally (do not commit `.env`):

```bash
npm install
npm test
mysql -h "$DB_HOST" -u "$DB_USER" -p "$DB_NAME" < migrations/001_cgas_tour.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p "$DB_NAME" < migrations/002_cgas_historical_announcements.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p "$DB_NAME" < migrations/003_cgas_phpvms_awards.sql
node deploy-commands.js
pm2 restart discordbot
```

Deployment checklist:

1. Back up the database and apply migrations 001 and 003 once. Apply migration 002 as well if the one-time historical announcer will be used.
2. Confirm `config/cgasStations.js` station IDs, aliases, and version. Change the version if requirements have changed.
3. Set `CGAS_TOUR_CHANNEL_ID` to Mission Notices, optionally set the Discord role, and set `CGAS_TOUR_AWARD_ID=16` after confirming the CGAS Grand Tour award ID.
4. Confirm the bot can view/send/embed in Mission Notices. For role awards, confirm Manage Roles and hierarchy.
5. Run the tests, then re-register commands because the statistics options and `/cgasleaderboard` must be published.
6. Restart the PM2 process once. Review logs for the successful silent baseline before relying on announcements.

Commands for subsequent code-only deployments remain:

```bash
npm install
npm test
node deploy-commands.js
pm2 restart discordbot
```

`node deploy-commands.js` registers the slash commands in the configured guild. The existing production helper performs registration and then uses the existing PM2 process name. Do not run either command from a development checkout unless it is intended to update the configured Discord guild. This change does not run migrations, deploy, restart PM2, or send production announcements automatically.
