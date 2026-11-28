# P02 manual training records

The [P03 guide](training-p03.md) covers linked evaluations and the current active and archived thread lookup.

P02 stores instructor evaluations independently of PIREPs. Pilots can be enrolled in both Rotary Wing (`rw`) and Fixed Wing (`fw`) and progress through each on its own. The initial curriculum has nine configurable slots per program (`flight-1` to `flight-9`). Those slots mirror the tracker; they do not establish prerequisites, qualifications, Mission Rated status, or graduation. Stage Zero (`stage-zero`) is a separate disabled program with no seeded lessons.

## Deploy to a test installation

1. Use a staging phpVMS database and Discord guild. Confirm the staging phpVMS `users.id`, `users.pilot_id`, and `discord_links` mapping. The database account needs to read those tables and read/write the four training tables. Use a migration account for schema changes. Run the database-version-specific 004 file from the [P07 staging procedure](training-p07-phpmyadmin-installation.md) against the authorized staging database the bot uses. Both supported InnoDB paths require a verified backup. The seed statements preserve existing program and lesson settings on rerun.
2. Deploy the P02 bot code, including `commands/training.js` and `utils/training/`, and install from the existing npm lockfile. Reuse `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `GUILD_ID`, `CLIENT_ID`, `DISCORD_TOKEN`, `COMMAND_STAFF_ROLE_ID`, and `INSTRUCTOR_PILOT_ROLE_ID`. Set `TRAINING_CHANNEL_ID` to the parent of the existing private trainee threads if it differs from the bot’s built-in vUSCG training channel. Configure the staging value explicitly.
3. From the bot checkout run `node deploy-commands.js` for the intended guild, then start the staged bot with `node index.js`. Command registration replaces that guild's bot command list with the definitions in the repository. Check that all existing commands and the six `/training` subcommands are present. The bot needs the Members intent to recheck roles at confirmation and verify thread membership for notifications.
4. Verify an ordinary pilot can see only their own progress and history. With test staff accounts, enroll a test pilot in both tracks, save distinct attempts, confirm a void, and check history, effective progress, and thread privacy. Try cancellation, an expired button, and an identical attempt. Approve a live rollout only after staging validation.

No phpVMS module deployment is needed for P02.

## Discord workflows

| Command | Access | Behavior |
| --- | --- | --- |
| `/training enroll pilot_id:3250 track:rw` | Command Staff | Explicitly starts or resumes one program enrollment. Set `active:false` to pause that program without losing history. |
| `/training record pilot_id:3250 track:rw lesson:flight-4 result:passed` | Instructor Pilot or Command Staff | Records an attempt after confirmation. Optional `date` is an ISO calendar date, defaulting to today in UTC. Optional `comments` accepts up to 400 characters. |
| `/training progress` | Linked member | Shows their own progress. Use `page` for additional programs or lesson rows. |
| `/training pilot pilot_id:3250` | Instructor Pilot or Command Staff | Shows one pilot's progress in the same format. |
| `/training history` | Linked member for self. Instructor Pilot or Command Staff with `pilot_id` for another pilot. | Lists attempts, outcomes, comments, record IDs, and void audit details. `page` browses older attempts, sorted by training date, entry time, then ID. |
| `/training void record_id:<UUID> reason:<reason>` | Command Staff | Confirms a void, retains the original attempt and audit details, and recalculates effective progress. Use `record` to create a replacement attempt. |

Readers acting on their own record and all users making changes need a valid `discord_links` mapping. A nickname or a C-number typed into Discord cannot authenticate an instructor or grant access to training records. If the lookup fails, Command Staff should verify the member’s Discord ID and existing phpVMS account using the established linking procedure. Verify the link directly before rerunning the command. Avoid rerunning activation solely to repair a link, since activation has other effects.

Confirmation is private to the requester, expires after 60 seconds, and rechecks the live guild role and the linked identity before writing. Progress and history are ephemeral, including instructor comments, which are visible to the pilot and authorized staff in history. Exactly matching attempts in the same pilot/program/lesson are flagged based on training date, outcome, instructor C-number, normalized comments, and associated PIREP ID if present. Inspect history first, then use `repeat:true` only for an intentional identical manual attempt. Duplicate delivery of a single Discord interaction returns the existing record.

A successful manual signoff can post a concise update in the existing active private thread `Training Case for C####` under the configured parent. The bot requires one matching thread and verifies the uniquely linked trainee belongs to it. Keep thread creation in that parent restricted to authorized staff and the bot. Notifications omit comments and mentions. In P02, missing, archived, locked, or ambiguous threads and Discord errors leave the stored result intact. Notifications are best effort and have no background retry.

## Storage and program configuration

- `vuscg_training_programs` stores stable program IDs, display names, availability, and an explicit curriculum completeness flag.
- `vuscg_training_lessons` stores a stable identifier within its program, display name, order, and availability. Extend with a versioned migration when stage and prerequisite rules are verified. Preserve the identifiers of existing lessons. Retiring a lesson removes it from the active denominator and preserves its attempts in history.
- `vuscg_training_enrollments` keys membership on the phpVMS internal user ID and program ID. It stores active status, the creation audit, and the latest update audit. Enable or pause through the staff workflow.
- `vuscg_training_records` stores append-only evaluations and a one-time void audit. The internal user ID determines identity. The public pilot ID is a snapshot. Record IDs are UUIDs. Training days are MySQL `DATE` values and entry and correction timestamps use UTC. P02 omits foreign keys into phpVMS core because the deployed core column types and account retention rules can differ. Training tables enforce their own relationships with foreign keys.

Only a non-voided `passed` attempt completes an active lesson. Pending or unsuccessful attempts stay in history, and multiple passes still count as one lesson. Percentages describe program completion only when the relevant curriculum is explicitly marked complete and includes active lessons. Counts still show progress through the configured slots. The next incomplete slot is based on display order and conveys no eligibility rule. Review completion flags with curriculum owners before changing them.

MySQL transactions serialize writes against the same enrollment and enforce a unique source key per submission. P03 can reuse `prepareRecord` and `createRecord` with a validated optional PIREP ID, an authorized actor, and a durable submission key. New sources may require their own schema migration and authorization. P02 does not read, approve, or change PIREPs as part of training workflows.

## Review and import historical attempts

Use an explicitly supplied export from the `LOG` tab of **Training Tracker ACTIVE (2026)**. Prepare a CSV or JSON file with one reviewed row per nonblank attempt. For a wide spreadsheet export, first reshape individual flight date/instructor cells into these attempt rows. No raw-sheet column layout or dates are assumed. Keep the original export securely as a reference and choose a stable dataset name for its series of reviewed files.

Required columns/properties are `source_id`, `pilot_id`, `track`, `lesson`, `instructor`, `date`, and `result`. Optional columns are `mapped_track` and `comments`. Use permanent source IDs such as `log-row-42-flight-4` that remain stable across corrections, ordering, and retries. Pilot and instructor identifiers accept a positive number or a C-number. Instructor C-numbers from the sheet are stored as historical, with no verified Discord identity. Supported dates are `YYYY-MM-DD` and unambiguous year-first `YYYY/M/D`. Ambiguous or invalid dates are rejected. Use `passed`, `needs_training`, or `in_progress` only where verified.

```csv
source_id,pilot_id,track,lesson,instructor,date,result,mapped_track,comments
log-row-42-flight-4,C3250,RW/FW,flight-4,C03,2025-11-05,passed,RW,Reviewed export
```

A row labeled `RW/FW` requires an explicit reviewed `mapped_track` of `RW` or `FW`. The utility never credits both tracks from one row. Blank lessons are skipped. Leave inactive, DOR, or qualification markers out of the attempt file until there is an approved mapping. Pilots must exist and be explicitly enrolled in an active program with an available lesson. The importer does not enroll pilots or send Discord notifications.

```bash
node scripts/import-training.js --dataset training-log-2026 attempts.csv
node scripts/import-training.js --dataset training-log-2026 --apply attempts.csv
```

Dry-run is the default and does not write to MySQL. Each run emits JSON with totals and row-level validation, rejection, duplicate, or import details. Review the report and resolve ambiguous rows before adding `--apply`. Apply commits valid rows individually. Exit code `2` indicates rejected rows, including when some valid rows committed. Exit code `1` means the run could not complete. Correct the input or restore database connectivity and rerun with the same dataset and source IDs. Reusing a source ID with edited data is flagged as a conflict. For an already-imported error, void the original through Command Staff and give any replacement a distinct source ID with traceable provenance. Keep files and reports restricted to staff who need access.

## Test and rollback

Run `npm run check` and `npm test`. The MySQL integration suite is opt-in and requires a fresh local fixture database. It ignores production `DB_*` variables and refuses a nonempty database. For a disposable fixture:

```bash
docker run --rm -d --name vuscg-training-fixture \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=vuscg_training_test \
  -e MYSQL_USER=training_test -e MYSQL_PASSWORD=training_test_local_only \
  -p 127.0.0.1::3306 mysql:8.4
docker logs vuscg-training-fixture
docker port vuscg-training-fixture 3306
# After MySQL is ready, use the loopback port printed above.
TRAINING_TEST_MYSQL_PORT=<port> TRAINING_TEST_MYSQL_VERSION=8.4 npm test
docker stop vuscg-training-fixture
```

For rollback, stop the P02 bot so that open confirmations expire, redeploy the preceding tested bot build, register its guild commands, and restart. Leave the additive training tables and backups in place to preserve history. Any later decision to archive or remove those tables belongs in a separate data-retention operation.
