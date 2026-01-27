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

### 1) Nickname parsing (primary)
The bot looks for a `C####` pattern in the member’s nickname/display name.

Examples:
- `C3015 John D` → Pilot ID `3015`
- `C1201 Jane S` → Pilot ID `1201`

If the bot can’t find `C####`, it will refuse commands that require a pilot identity.

### 2) Database linking (created during `/activate`)
During onboarding, `/activate` upserts a record in `discord_links`:

- `discord_id` → `pilot_id`

This makes identity resolution more reliable for new activations.

> Note: Existing members who were never activated via `/activate` may not be present in `discord_links`. For those members, nickname parsing still works.

---

## Commands

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
