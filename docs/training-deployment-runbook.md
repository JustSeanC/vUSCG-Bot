# Training system staging and deployment runbook

Use the [P05 release verdict](training-p05-readiness.md) as the production gate. Rehearse the procedure on isolated infrastructure first. P05 denies bridge decisions outside Laravel staging and testing even when the flag is set. Keep the actual production environment and the bridge decision flag unchanged.

## 1. Preflight and backups

1. Record the exact commit, branch, lockfile and previous bot release. From the reviewed checkout run `git status --short --branch`, `git rev-parse HEAD`, `npm ci`, and `bash scripts/test-training-release.sh` on Node 24. Keep the evidence. The legacy deploy helper checks out main and assumes a particular filesystem and PM2 process. Use the verified release and supervisor.
2. Obtain the exact installed phpVMS build, dependency lockfile, route list, VuscgCustom files, other installed modules, listeners and authorization configuration. Audit the configured DB connections, cache namespace, queue settings, HTTPS ingress, and every report writer. Compare to the reviewed Laravel 10 reference. Identify downtime and maintenance windows.
3. Provision a separate sanitized database, website, HTTPS host, Discord application and staging guild. Use separate credentials, a bot absent from the production guild, and test-only test pilot accounts, staff links, aircraft, ranks, permissions, training channels and private threads. Route mail, broadcasts, webhooks and queues to test sinks. Verify the Members intent, Manage Roles and hierarchy, and thread access. Use staging mapping overrides for the training features. Review legacy commands and startup tasks with hard-coded role/channel IDs before exercising them in the test guild.
4. Select distinct, authorized read-only, migration, and runtime database accounts. Use verified login-path aliases and schema/destination variables. Confirm the selected schema first.

   ~~~bash
   mysql --login-path="$READ_LOGIN_PATH" "$APP_DB" < integrations/phpvms7/training-schema-preflight.sql
   mysql --login-path="$READ_LOGIN_PATH" "$APP_DB" < integrations/phpvms7/qualification-inventory.sql
   ~~~

   Verify ID plus name for each award and role. Verify IP permissions, Laratrust guard, pivot morph mapping, teams setting and cache invalidation. Resolve each exact rating code against the actual column. Verify the configured CGAS tour award ID is distinct from all qualification award IDs. Inspect engine, column types, indexes and keys, including unique Discord-link identities and PIREP state/ID columns.
5. Pause affected writers for DDL, inventory open transactions and free space, and record current flags, schemas and counts. Take an approved backup in a restricted location.

   ~~~bash
   umask 077
   mysqldump --login-path="$BACKUP_LOGIN_PATH" --single-transaction "$APP_DB" > "$BACKUP_FILE"
   ~~~

   Include affected tables and the routines, triggers, events, code and configuration required by the installation’s backup plan. Verify restoration into a separate disposable schema. Protect all backups and test evidence. Confirm ownership-marker rollbacks and partial delivery review before advancing.

## 2. Database migration ledger

MySQL 8.4 and InnoDB are the tested baseline. Record the commit, checksum and exact statements applied. MySQL DDL can lock tables and statements can commit independently. Budget index builds and table alteration time on representative staging data. Inspect the schema after partial failures before retrying. Keep DDL privileges out of runtime accounts.

| File | Dependencies and privileges | Changes and repeat behavior |
| --- | --- | --- |
| 001 CGAS | Existing CGAS deployment, CREATE and indexes | Creates two InnoDB CGAS tables using JSON and unique keys. Repeat preserves rows. No native foreign keys. |
| 002 CGAS historical | 001 and ALTER | Adds optional historical campaign fields. Apply once if used. Does not itself queue the campaign. |
| 003 CGAS native award | 001 and ALTER/INDEX | Adds native CGAS delivery columns. Apply once if used. Previously detected completions can queue after enabling CGAS delivery. Pause the worker before separately scheduling a rollout. |
| [Bridge nonces](../integrations/phpvms7/bridge-nonces.sql) | CREATE and indexes | Creates the durable HMAC nonce table. Repeat preserves rows. Bridge runtime needs INSERT and approved expiry cleanup needs DELETE. Use the retention window in the P01 guide. |
| [004](../migrations/004_training_records.sql) | CREATE, indexes, REFERENCES, seed INSERT/UPDATE | Creates programs, lessons, enrollments, and records. FKs stay within training. Checks, JSON, identical key definitions and UTC timestamps are required. Rerunning preserves edited rows and seeds. |
| [005](../migrations/005_training_pirep_link.sql) | 004 and ALTER/INDEX | Extends the training source enum, replaces the source CHECK and creates a generated-column uniqueness index. One-time, with potential rebuild and metadata locks. |
| [006](../migrations/006_training_qualifications.sql) | 004–005, CREATE, indexes, REFERENCES, seed INSERT/UPDATE | Adds catalog, immutable events, status projection, import staging and delivery audit/outbox. FKs stay within training. Repeat preserves rows and scopes. |
| [007](../migrations/007_training_native_ownership.sql) | 006 and positively verified native pivots, ALTER/INDEX | Adds a nullable unique ownership marker to each opted-in pivot. Existing assignments remain unmarked. Apply each statement once, individually. Review storage, metadata locks and whether native models can safely preserve the marker. |

Apply only verified, unapplied statements. For a fresh training schema run from the reviewed bot checkout:

~~~bash
mysql --login-path="$MIGRATION_LOGIN_PATH" "$APP_DB" < migrations/004_training_records.sql
mysql --login-path="$MIGRATION_LOGIN_PATH" "$APP_DB" < migrations/005_training_pirep_link.sql
mysql --login-path="$MIGRATION_LOGIN_PATH" "$APP_DB" < migrations/006_training_qualifications.sql
~~~

Apply the bridge nonce schema separately before authenticated staging calls. Apply each verified 007 ALTER from the committed file separately, with the targets disabled. Record partial completion and compare the preflight and SHOW CREATE TABLE after each statement. A different pivot or Laravel authorization model blocks that target. Existing deployments should inventory 001–003 and preserve CGAS data.

The website models and queue must share the same primary. Runtime users need scoped read and write access for the features they run. Native permissions are limited to verified assignments and ownership-filtered deletion. Rank graduation needs the reviewed rank-update permission. Validate counts, scopes, replay keys, checks, and markers against the baseline. Example post-migration read-only queries:

~~~sql
SELECT program_id, COUNT(*) AS lessons FROM vuscg_training_lessons GROUP BY program_id;
SELECT source, COUNT(*) AS records FROM vuscg_training_records GROUP BY source;
SELECT target, state, COUNT(*) AS jobs FROM vuscg_training_qualification_sync GROUP BY target, state;
SELECT s.user_id, s.qualification_id, s.program_id
FROM vuscg_training_qualification_status s
LEFT JOIN vuscg_training_qualification_events e ON e.event_id = s.last_event_id
WHERE e.event_id IS NULL OR e.user_id <> s.user_id
   OR e.qualification_id <> s.qualification_id OR e.program_id <> s.program_id
   OR s.active <> (e.action = 'grant');
SELECT pilot_id, COUNT(*) AS links FROM discord_links GROUP BY pilot_id HAVING COUNT(*) > 1;
~~~

The state/event mismatch result must be empty. Review duplicate or missing links before role synchronization. For P04 upgrades, inspect historical jobs and any already delivered historical side effects. P05 retires previously queued historical jobs without external effects. An earlier delivery needs separate supervised reconciliation with the existing audit.

## 3. Website preparation

1. Back up VuscgCustom and its configuration. For bridge testing, copy the approved bridge controller, Services/PirepDecisionGate.php and config/vuscg_pirep_review.php to their matching paths. Merge the bridge route group into the installed API file and preserve unrelated module routes. Verify HTTPS trusted proxies, path prefix, body limits, UTC clocks, nonce expiry and rate limits. Supply a dedicated secret through environment settings.
2. Copy the approved Console/SyncQualifications.php, Services/QualificationNativePlan.php and config/vuscg_qualifications.php to their matching paths. Merge console registration in the installed provider as described in the [P04 guide](training-p04.md). Use the verified existing native model/event APIs and retain all other module functionality.
3. Keep PIREP_BRIDGE_DECISIONS_ENABLED, VUSCG_QUALIFICATION_SYNC_ENABLED, VUSCG_TYPE_RATING_SYNC_ENABLED, and VUSCG_IP_ROLE_SYNC_ENABLED false. Keep schedules stopped. In the verified phpVMS installation directory run:

   ~~~bash
   php artisan config:clear
   php artisan route:clear
   php artisan route:list --path=api/vuscgcustom/pirep-review
   php artisan list vuscg
   php artisan vuscg:sync-qualifications
   ~~~

   Verify the last command reports disabled and changes no jobs or native rows. Rebuild configuration and route caches if the app normally uses them. Safeguard cached configuration and reload the verified long-running processes. Enable staging bridge decisions only while executing isolated tests with APP_ENV=staging or testing and return the flag to false afterward.

## 4. Discord installation and staged enablement

1. Verify the test token, application, guild, database, staff roles, training thread and private fallback parent, and HTTPS PIREP link/bridge hosts. Use the role variables and exact rank name from the [P04 guide](training-p04.md). Leave TRAINING_GRADUATION_ENABLED=false.
2. Stop the old bot before registering or starting its replacement. In the approved checkout run `node deploy-commands.js`, which exits nonzero if Discord rejects registration. Verify the intended guild has the complete registration set, including training and qualification and the legacy command retirement. Start with `node index.js` or the verified supervisor configuration. Rehearse this handover on staging. Never overlap a legacy promotion writer and the graduation worker.
3. Enable one lane at a time after verifying its configuration. First deliver awards and observe the audit. Use `php artisan vuscg:sync-qualifications --event=<event-uuid>` for individual fixture events. Then enable type ratings and verify both training tracks. Separately enable IP role sync and verify permissions in a fresh Laravel session. Enable Discord graduation only after native MR dependencies, account linkage, ranks and Discord role mappings are proven. Refresh configuration and reload workers between stages.

## 5. Staging acceptance matrix

Capture the exact build, schema, fixture IDs, role used, before/after counters, event IDs, message IDs, pass/fail and hold-point decision. Use restricted test data and redact secrets.

| Scenario | Required evidence |
| --- | --- |
| Registration and standalone signoffs | Exercise staging commands and ordinary versus staff access. Enroll RW and save standalone training once. Verify ephemeral comments and failure on stale/unauthorized confirmation. |
| Native PIREP and linked training | File and accept a disposable report. Validate accounting separately. Record linked training, reject wrong-owner evidence, simulate stale PIREP state, try a duplicate and void an attempt. Acceptance alone earns no training credit. Verify reopening the existing private thread and notification failure recovery. |
| Explicit Rotary MR | Complete configured RW slots and confirm no grant or rank write. Instructor Pilot grants RW MR. Observe verified award, HELI_USCG persistence before TRNHELI removal, unchanged FW trainee rating, ENS 12 to LTJG 13 once, Pilot/RW/O-2 designations where appropriate, nickname and a single private announcement. |
| Fixed Wing and senior rank | Grant FW MR to the same pilot and a separate senior pilot. Verify FW_CG before FWTRN removal, existing RW designations, unchanged LTJG and senior ranks, and no duplicate announcement. |
| Specialty and IP | BLACKJACK award 8 plus INTAPP, MQ9 inventory-verified award plus UAV, HITRON award 7 and unchanged ratings, DLQ unchanged ratings. Refuse an Instructor Pilot's IP grant and every instructor revocation. Command Staff grants IP and verifies the existing native role and permissions. |
| Revocation and recovery | Preserve preexisting native assignments and previously earned rank. Verify a missing mapping, disabled lane, wrong identity, DB or Discord outage and ambiguous send. Confirm visible retry and recovery. Stage reviewed synthetic historical rows and verify no external work. |
| Existing workflows | Verify /activate, /manualpirep, /mission, /jumpseat, /location, /myactivity, /myairports, /mycgas, /cgasleaderboard, /moveaircraft, /activity90, /forceranksync and /help with staging fixtures and settings. Check hourly rank sync and CGAS announcements/awards. |

### Native accounting tests

Copy PirepReviewBridgeTest.php and QualificationNativeSyncFeatureTest.php from integrations/phpvms7/tests into the approved isolated phpVMS tests/Feature directory. Use the runtime’s testing bootstrap. Set PIREP_BRIDGE_TEST_PENDING_ID for the delegation fixture and PIREP_BRIDGE_TEST_NATIVE_PENDING_ID for a dedicated pending flight with a pilot, aircraft, valid fuel, positive duration and destination. Set VUSCG_QUAL_TEST_PILOT_PUBLIC_ID for an isolated pilot without the configured DLQ award or IP role. Confirm the connection is isolated before running:

~~~bash
php artisan test --filter=PirepReviewBridgeTest
php artisan test --filter=QualificationNativeSyncFeatureTest
~~~

Capture the exact test outcomes, including skips. The rollback test injects an isolated synchronous failure during acceptance and checks real pilot, PIREP and aircraft rows. Run deployed listeners separately with safe test sinks. Verify their registration, queue after-commit settings and side effects independently of dispatch counts.

For concurrency, use separate workers/sessions and a fresh disposable PIREP per case. Exercise the actual staging surfaces and capture overlapping timestamps or database lock traces. Repeat each direction/order:

| Pair or fault | Pass criterion |
| --- | --- |
| Two Discord approves and a sequential repeat | One transition and one award-processing/acceptance dispatch. Pilot minutes + flight duration, flights +1 and aircraft minutes + duration. Subsequent requests observe existing state. |
| Discord approve and reject | Exactly one pending transition. Acceptance-first credits once. Rejection-first adds none. |
| Discord approve and native admin approve | Exactly one native accounting result, with unchanged pilot/aircraft counters on any replay. Test every relevant accepting writer and intentional native reversal behavior separately. Passing some schedules does not prove shared locking. |
| Timeout and explicit retry | Interrupt or delay a staging response, check status reconciliation, then retry as an operator. No second credit. |
| Previously accepted and injected failure | Previously accepted stays unchanged. Injected failure returns the original PIREP state, counters, rank, fuel, locations and last report. Compare award pivots, listener counts and external traces. |

If any competing writer fails the check, keep the bridge gate closed. An exclusive-writer mitigation requires verified enforcement across admin, API, auto-approval, background work and any direct writers. Operator convention is insufficient.

## 6. Production hold, stop and rollback

1. Require signed staging evidence, verified mappings, a reviewed previous release and resolution of all production holds. Keep bridge decisions disabled in P05. Use the approved backup/DDL window, release commit and supervisor. Apply the measured staging order and stop the old bot before replacing its promotion command. Keep effects separated by flag during cutover.
2. Smoke-test correct registration, audit visibility, account linkage, private access, CGAS and normal rank behavior. Observe native award/rating/permission checks for approved test pilots and reconcile audit evidence. Validate PIREP accounting from authorized observations. Monitor queue backlog, retries, Discord rate limits, unexpected side effects and native logs.
3. For immediate shutdown, stop the bot and qualification scheduler, set graduation and award/rating/IP flags false, and keep bridge decisions false. Refresh Laravel configuration and reload or drain old workers. Disable decision ingress if needed. Verify effects have stopped, retain queues, cached PIREP message references and audit data, and reconcile in-flight jobs.
4. For rollback, restore the reviewed previous bot and module/config files, then register the previous command payload with workers and legacy promotion disabled until the overlap risk is addressed. Preserve schemas, marker columns, qualification history and backups. Fetch native effect evidence for partly delivered jobs and resolve with Command Staff. Preserve replay nonces through their retention window. Require an approved restoration plan before dropping columns, discarding history, restoring an old database snapshot or reactivating the legacy writer.
