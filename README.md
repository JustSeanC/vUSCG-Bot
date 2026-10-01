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

- **90-day activity** uses the latest submitted PIREP in any state, exactly like the existing activity report. It does not use `updated_at` and does not invent an enrollment grace period when there is no history.
- Times and boundaries are calculated in UTC. The command turns yellow with 10 calendar days or less remaining and red at the precise 90-day instant.
- The scheduled report's SQL uses an inclusive `submitted_at >= UTC_TIMESTAMP() - INTERVAL 90 DAY` boundary. Therefore a PIREP exactly on that report cutoff remains in its result, while the personal countdown describes the cutoff as reached at that exact instant.
- **Lifetime statistics** use accepted PIREPs (`state = 2`) only: count, distinct aircraft IDs, flight time (phpVMS minutes, displayed as hours/minutes), distance in nautical miles, and distinct arrival airports.
- Aircraft registrations are displayed when the current aircraft row still exists. Historic registrations cannot be recovered when that metadata has been deleted, but those PIREPs still count by aircraft ID.
- Jumpseat changes and administrative aircraft moves do not create PIREPs, so they do not count as flights or visits.

### `/myairports` — Anyone
Shows a private, paginated list of airports visited through **arrivals on accepted PIREPs**, including arrival count and first/latest recorded visit. Example: `/myairports`. A departure alone is not a visit, and an airport whose metadata was removed is retained under its recorded code.

### `/mycgas` — Anyone
Shows private CGAS completion progress. An arrival on an accepted PIREP earns credit; departures do not, and aliases for one station never award duplicate station credit. Returning to an airport on another accepted flight remains a valid arrival and updates the latest visit.

#### Configure the CGAS roster

No authoritative station roster was found in this repository, so `config/cgasStations.js` is intentionally empty rather than treating every phpVMS hub as a station. Copy entries from `config/cgasStations.example.js` and replace them with the organization's authoritative list:

```js
module.exports = [
  { id: 'stable-station-id', name: 'Air Station Name', airportCodes: ['KABC', 'ABC'] },
];
```

Keep each `id` stable through display-name changes. Put all accepted ICAO/code aliases in `airportCodes`; matching is case-insensitive. With an empty array, `/mycgas` and `/myactivity` clearly say that the station list is not configured.

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

---

## Background Processes

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
node deploy-commands.js
pm2 restart discordbot
```

`node deploy-commands.js` registers the new slash commands in the configured guild. The existing production helper performs the same command registration and then uses the existing PM2 process name with `pm2 restart discordbot`. Database migrations are not required. Do not run the deploy script from a development checkout unless it is intended to update the configured Discord guild.
