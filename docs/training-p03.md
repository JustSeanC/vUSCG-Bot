# P03 PIREP-linked training evaluations

> **Production blocker for bridge approval**
>
> The supplied phpVMS admin controller loads PIREPs outside the bridge's locking transaction. Concurrent native and bridge approvals can still credit the same flight twice. Keep `PIREP_BRIDGE_DECISIONS_ENABLED=false` in production. P03 training can use reports accepted independently through native phpVMS.

## Instructor workflow

A pending review retains Approve, Deny, and View. Approve and Deny still use the P01 bridge. Once acceptance is persisted, the message shows **Record Training** and **View**. The watcher also reconciles reports accepted in phpVMS directly. Rejected or deleted reports have no training action. Approval completes before any training interaction, and instructors may leave without recording training.

Record Training opens an ephemeral chooser for the authenticated Instructor Pilot or Command Staff member. It identifies the trainee from the accepted report, shows active programs and eligible lessons (including lessons with previous attempts), then offers the outcome and an optional date and comments modal. Selects show up to 25 entries per page. Each step waits up to a minute and the chooser has a four-minute overall window, followed by the one-minute final confirmation. Restarting the bot expires any in-memory chooser. A new form can be opened from the accepted review message any time the report is eligible.

`/training record pilot_id:3250 track:rw lesson:flight-4 result:passed pirep_id:<ID>` uses the same confirmation and record service. This works for accepted reports without a review message. Omit `pirep_id` for a standalone evaluation, including the P02 manual repeat option. Approval state never determines the training outcome. A linked evaluation can be `passed`, `needs_training`, or `in_progress`.

Staff must be in the configured guild with the required role and a verified `discord_links` entry. Confirmation re-fetches guild roles and the instructor's link. The training transaction checks an exact case-preserved PIREP ID, accepted state, soft-deletion status, internal owner and public number, active enrollment and active lesson. Use the same database primary as the bot's training tables so the shared report lock and training write occur on one connection.

## Storage, views, and recovery

Apply `migrations/005_training_pirep_link.sql` once after `004_training_records.sql`. It adds the `pirep` record source and an indexed uniqueness constraint for active evaluations on the same PIREP, pilot, program, lesson and outcome. This preserves existing `manual` and `import` rows. Different lessons or outcomes can reference the same report. Command Staff can void a linked attempt and then record a replacement. Non-voided passes still count once per lesson.

The original Discord interaction identifies a durable submission. If a write returns an uncertain database result, the service looks up that submission before reporting failure. A replay returns the existing record ID and does not announce it again. If the response is lost and a fresh interaction is opened, check training history first. An identical active linked outcome is blocked even if the new request has different comments or a different date.

Progress and staff lookup show the latest effective signoff and its report link when linked. History retains all attempts and voids, identifies standalone, linked and imported entries, and displays the associated report ID and link. Imported instructor C-numbers remain unverified. Displaying a historical report link does not certify that the report is still accepted. Existing role and self-access rules apply.

## Trainee threads and reconciliation

The watcher and announcements share the same lookup. It searches active private threads and paginates archived private threads joined by the bot under the expected parent. It verifies the name and that the uniquely linked trainee belongs to the thread. Missing links, ambiguous matches, inaccessible threads and locked threads are skipped. An eligible archived thread is reopened without changing its permissions or unlocking it. Keep thread creation restricted to authorized staff. For pending reviews only, configure the existing fallback channel if needed and keep it private to appropriate staff. Announcements include a report link where applicable, omit comments and disable mentions.

Keep the existing `pending_pireps_cache.json` on persistent storage and run a single watcher instance for the guild. The bot saves the cached message reference after posting, and resumes reconciliation after restart. A transient edit failure retains the entry. Discord nonces reduce duplicate pending posts during its deduplication window. Losing the cache or crashing between a Discord post and saving its reference can still leave a message untracked. Previously resolved messages from releases before P03 may require the slash command for later training. Best-effort announcements are only sent on a newly acknowledged commit. A Discord error or crash after a commit can leave the announcement absent while history remains authoritative.

## Controlled staging

1. Use isolated phpVMS, MySQL 5.7.44 or 8.4, and a staging Discord guild. Apply matching 004 and 005 files from the [P07 staging procedure](training-p07-phpmyadmin-installation.md). Confirm the MySQL user can read the original `users`, `pireps` and `discord_links` tables, acquire shared locks through the primary, and write training rows.
2. Configure the guild, staff roles, links, and training thread parent using the [P02 guide](training-p02.md). Set `PIREP_BASE_URL` to the staging HTTPS report link prefix. Re-register commands in the staging guild to expose `pirep_id`, then start the bot.
3. While the bridge is gated off, accept a disposable report directly in staging phpVMS. Verify the watcher, later button access, slash path, archived-thread reopening, and histories. Reject another report and confirm there is no signoff action. Verify separate RW/FW progress, duplicate refusal, void/replacement, and a standalone attempt. Confirm that the training workflows leave the report and aviation counters unchanged.
4. To test native bridge-only approval, follow the [P01 installation guide](../integrations/phpvms7/README.md) on isolated fixtures. Start with other writers inactive and use dedicated non-production credentials and non-delivering event or queue services. In the staging application copy `integrations/phpvms7/tests/PirepReviewBridgeTest.php` into `tests/Feature` and run `php artisan test --filter=PirepReviewBridgeTest`. Set `PIREP_BRIDGE_TEST_PENDING_ID` for the mocked delegation test and `PIREP_BRIDGE_TEST_NATIVE_PENDING_ID` for a disposable, fully populated pending report with positive duration. The native test calls the actual service twice through the bridge and checks one pilot and aircraft time increment and one dispatch each for acceptance and award processing. It fakes selected events, so listener side effects require separate staging verification.

### P01 cross-writer acceptance check

On a dedicated staging installation, verify the exact deployed native and bridge source and list every writer that can accept a pending report. Use a fresh pending fixture with known flight minutes, pilot and aircraft, snapshot their counters, and exercise the native admin path and bridge approval concurrently in a controlled test. Compare both responses, persisted state, counter deltas and event observations. Repeat the test with separate fixtures, and compare with parallel requests through the bridge only. Any second increment or second acceptance event is a failure. Passing runs alone do not establish concurrency safety.

Before enabling production bridge decisions, enforce exclusive processing for eligible reports or make **every** accepting writer follow a shared transaction and row-lock protocol. Each writer must lock the same primary PIREP row before deciding, re-read the state under that lock, and commit native accounting once. Verify compatible locking order for pilot and aircraft updates. Audit listeners for side effects that should run after commit and confirm delivery and rollback behavior. Then rerun isolated tests for each writer pairing. P03 includes no phpVMS core deployment change.

## Automated checks and rollback

Run `npm run check` and `npm test`. Use the disposable MySQL setup in the [P02 guide](training-p02.md) and run `TRAINING_TEST_MYSQL_PORT=<port> TRAINING_TEST_MYSQL_VERSION=<fixture-version> npm test` to include the database suite. It tests upgrading with populated P02 records, linked uniqueness and void replacement, stale evidence, unchanged flight counters during signoffs and import compatibility. Node tests mock Discord and the bridge HTTP contract. The real Laravel accounting test requires the complete staging phpVMS runtime and a fixture.

GitHub Actions on pushes to `develop/training-system` runs Node 24 syntax checks and the entire test suite against both isolated MySQL 5.7.44 and 8.4 services. It needs no Discord token or production database. Check that the run completes and the MySQL suite executes with zero skips.

For rollback, stop the P03 bot, revert the bot release and re-register the earlier commands in the affected staging guild. Leave migration 005 and data in place. Existing P03 Training buttons become unavailable on earlier releases. A P02 client may not identify the linked source or display its report link, but retains effective pass counts. Any downgrade of the database schema needs a separate retention plan for linked evaluations.

P04 can read the training record ID, source and associated PIREP through the training service. Add verified curricular rules, prerequisites and qualification workflows independently of PIREP approval and preserve the evaluation and void audit.
