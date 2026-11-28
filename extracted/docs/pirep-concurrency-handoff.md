# PIREP concurrency repair and staging handoff

**Production remains blocked.** This candidate was built against the two supplied partial site audits, at the bot baseline `201ef10f38975d1efffdba4fd54c9eb8fa3b7c60`. The live site, database, bot, secrets, configuration and Discord commands were left untouched. The earlier concurrency draft was reviewed as a reference. The installation patch is local and intended for an isolated copy of the installed Laravel application.

## Exact files and installation order

1. Use an authorized staging copy with a separate MySQL database, website, test guild and mail/Discord/webhook/queue sinks. Pause review, filing and other writers on that copy. Export the staged schema and data, record the current application and worker builds, and prove the backup can be restored to another disposable schema. Confirm MySQL 5.7.44, InnoDB, the selected schema, the primary connection and enabled foreign-key checks. Follow the P07 session instructions if phpMyAdmin or the server defaults to an empty SQL mode. [P07 session instructions](training-p07-phpmyadmin-installation.md)
2. From the **staged phpVMS root**, use the source hashes and `git apply --check /path/to/installed-source.patch`. If a file differs from the supplied installed snapshot, review and merge the diff before proceeding. The included DDL adds two columns to `pireps`. Apply it once on staging, with writers drained. Review metadata lock time, record the exact command, and verify both columns with `SHOW CREATE TABLE pireps` before installing PHP. [Baseline hashes](../integrations/phpvms7/pirep-concurrency/installed-source.sha256) · [Staging schema](../integrations/phpvms7/pirep-concurrency/schema.sql)
3. Apply the checked source patch in the staged tree. With no Git repository at the web root, apply it to an isolated local copy of the site source and upload only the changed files to **staging**, preserving existing permissions. The candidate hashes apply to the exact supplied baseline. [Source patch](../integrations/phpvms7/pirep-concurrency/installed-source.patch) · [Candidate hashes](../integrations/phpvms7/pirep-concurrency/candidate-source.sha256)

   | Site-relative path | Change |
   | --- | --- |
   | `app/Services/PirepService.php` | Shared row locks, filing boundary, revision-based review, edit/cancel/delete protection |
   | `app/Services/UserService.php` | Locked counters and pilot recount |
   | `app/Services/AircraftService.php` | Locked aircraft recount |
   | `app/Http/Controllers/Admin/PirepController.php` | Delegate review; protect create, edit and delete; return the revision and conflict state |
   | `app/Http/Controllers/Api/PirepController.php` | Atomic ACARS filing and submit, locked writes and finance recalculation |
   | `app/Cron/Hourly/DeletePireps.php` | Recheck eligibility after locking |
   | `app/Events/PirepFiled.php` | Mark the synchronous locked filing dispatch |
   | `app/Listeners/DiversionHandler.php` | Use the existing filing lock for diversion |
   | `app/Notifications/NotificationEventsHandler.php` | Defer reviewed notifications until commit |
   | `app/Services/PirepAfterCommit.php` | New helper that isolates post-commit delivery failures |
   | `modules/DisposableBasic/Listeners/Gen_AutoReject.php` | Reject only during synchronous locked filing and write comments on the same connection |

4. Copy the included Blade partial to `resources/views/admin/pireps/vuscg_review_revision.blade.php`. Merge its include into the installed **`admin.pireps.actions` view or theme override** for each PIREP’s action group, including the initial list/detail and the returned AJAX fragment. Give that group `data-vuscg-pirep-review`. Change the installed action JavaScript to include the clicked group’s current field alongside the existing `new_status`, ID and CSRF values:

   ~~~js
   const review = clickedButton.closest('[data-vuscg-pirep-review]');
   payload.review_revision = review.querySelector('[name="review_revision"]').value;
   ~~~

   Replace the action fragment after each response and confirm each submission uses that fragment’s value. On a conflict, display the returned current actions and require a deliberate new click. The controller accepts tokenless pending decisions for compatibility, and reversals require the current revision. The installed view and JavaScript were absent from the handoff, so the theme-specific merge and browser test remain required. [Blade partial](../integrations/phpvms7/pirep-concurrency/admin-review-revision.blade.php)
5. Copy exactly these two files from `integrations/phpvms7` into the matching VuscgCustom paths on staging. Keep the existing module provider/routes, registration email/webhook files, Laravel `.env`, HMAC configuration and nonce schema. No configuration file is part of this patch. [Bridge controller](../integrations/phpvms7/modules/VuscgCustom/Http/Controllers/Api/PirepReviewController.php) · [Decision gate](../integrations/phpvms7/modules/VuscgCustom/Services/PirepDecisionGate.php)

   - `modules/VuscgCustom/Http/Controllers/Api/PirepReviewController.php`
   - `modules/VuscgCustom/Services/PirepDecisionGate.php`

   The optional **staging bot** changes are `utils/pirepBridge.js` and `utils/pendingPireps.js`. They recognize a busy review response and send no automatic second decision. PHP and Node test files stay in test workspaces. Leave all P05–P07 flags disabled for installation. Refresh staging caches and restart only isolated staging processes after the files have been verified. [Branch deployment checklist](training-deployment-runbook.md)

## What the source audit established

| Observed path | Candidate behavior and limits |
| --- | --- |
| Admin status, legacy direct service calls and Discord | Shared native `PirepService::review()` rereads the row from the primary under `FOR UPDATE`. Same-state and stale revision requests return the current record with zero accounting writes. New terminal transitions rotate the receipt. Discord passes no revision and can only review a submitted pending report. TLS, request/signature validation, clock window and nonce handling are unchanged. |
| ACARS file, manual submit and auto-reject | The audited API keeps filing attributes, custom fields, fares, route fallback, SimBrief attachment and the synchronous `PirepFiled` event in one transaction. The temporary filing marker distinguishes an unfinished split filing from a previously submitted pending report. DisposableBasic runs before rank auto-approval. A direct rejection by its synchronous listener records one native rejection event, with no acceptance credit. Other callers of `file`, `submit` and `PirepFiled` need inventory. |
| Divert, bid, leave status and native lifecycle events | The observed subscribers remain synchronous and run under the filing lock. Reviewed broadcasts use an after-commit callback. The actual SimBrief, diversion, fleet/vmsACARS and status-model event implementations need verification. Existing diversion and rejection location policies are retained. Rejecting an accepted report subtracts counts/minutes and reruns native rank policy. It does not automatically rewind position, fuel or a previously awarded credential. |
| Admin CRUD, ACARS field/route writes and cron | Accounting inputs on accepted records require a rejection before editing or deletion. Admin creation cannot enter ACCEPTED directly. Edits rotate the revision. Cron rechecks age, status, state and revision before deleting. ACARS filing and edits recheck write conditions under the row lock. The audited positional/log endpoints primarily append telemetry and do not set PIREP state. Independently installed telemetry subscribers remain in scope for the staging audit. |
| Pilot and aircraft recount | Both installed recount services write accounting counters. They lock the affected participant and establish a new consistent read after locking, with no earlier transaction snapshot. Concurrent review uses PIREP → pilot → aircraft. Recount locks only its target participant and uses ordinary aggregate reads of committed PIREPs, avoiding a reverse PIREP row lock. `FlightService`’s inspected ACCEPTED reference is a read. |
| Finance and awards | Installed subscribers execute synchronously. The candidate retains that order and transaction. The audited explicit API finance recalculation now locks the accepted PIREP. Installed finance service, journal repositories, award plug-ins and their connections/queues were not supplied, so rollback and idempotency of installed ledger and award writes are still unproven. |
| Emails and broadcast | Defer only the reviewed filed, accepted, rejected, status, state, award, rank and diversion notification sends. Event-time attributes are captured before deferring. Existing registration verification and registration webhook handling are preserved. The callback logs a failed delivery without retrying accounting. It is best-effort across process crashes. A durable delivery outbox and per-channel idempotency policy require actual notification classes, queue configuration and provider capabilities. |

No service automatically reruns a native transaction after a deadlock or lock timeout. The bridge reports busy on a direct MySQL lock conflict. The existing Discord transport reconciles uncertain responses with a newly signed status request. A nested caller must unwind the enclosing transaction if a nested state operation throws. The fixture includes MySQL’s nested lock-timeout exception behavior and outer transaction rollback. Site-defined exception handling is still a staging check.

## Results and evidence

The supplied source archives are partial. The test fixture loads the patched installed PirepService, UserService, AircraftService, FinanceEventHandler, AwardHandler, selected notifications, events and DisposableBasic subscriber. It uses real InnoDB transactions, savepoints and concurrent PHP processes. Its models, ledger/award implementation and external delivery sink are minimal adapters. The final fixture passed on MySQL 5.7.44 and 8.4.13 with PHP 8.1.34 and Illuminate Database 10.48.25. The installed website, its hosting-specific MySQL build and real provider deliveries remain untested.

| Test surface | Evidence |
| --- | --- |
| Native-style vs native-style and pending-only bridge calls | A second PHP process opened a competing transaction and blocked on MySQL. Its older REPEATABLE READ snapshot did not overwrite the current state. Each pending outcome applied once. Approve-first and reject-first produced the first transaction’s result. |
| ACARS and DisposableBasic | A filing transaction held the lock through the synchronous subscriber and accounting. Auto-approval credited once, while an enabled score-rule auto-rejection wrote one reason and no flight credit. Repeating submit produced no second filed or rejected event. |
| Pilot/aircraft accounting | Fixture acceptance changed pilot minutes **100 → 145**, flights **3 → 4**, aircraft minutes **200 → 245**, rank **1 → 2**, locations **KAAA → KBBB**, and fuel **200 → 150**. Two reports sharing the same pilot and aircraft reached **190 minutes, 5 flights and 290 aircraft minutes**. |
| Reversal, retry and rollback | An explicit fresh revision permitted accepted → rejected → accepted; an old reversal receipt, stale deletion and repeated decision produced no additional effect. Injected failures after pilot, aircraft, ledger and award writes rolled back the fixture changes and suppressed notifications. An actual lock timeout followed by a new review observed the committed outcome. A post-commit delivery failure did not re-run accounting. |
| Existing bot and policy suite | The full P07 release script passed on disposable MySQL 5.7.44 and 8.4.13 with 95 Node tests on each and zero skips. PHP 8.1 lint and the standalone gate, qualification, trainee and scoped database checks passed. |

Fixture command from the bot checkout. The supplied PHP image must have PHP 8.1, `pdo_mysql` and `proc_open`. In a disposable Composer project, install `illuminate/database:10.48.25 illuminate/events:10.48.25 illuminate/config:10.48.25` with `composer require`. Use that project’s vendor directory. A disposable PHP image can be built from `php:8.1-cli` with `RUN docker-php-ext-install pdo_mysql`. The runner creates an isolated internal network and a fresh MySQL container for each run.

~~~sh
bash integrations/phpvms7/tests/pirep-concurrency/run.sh "$PATCHED_SITE_COPY" "$ILLUMINATE_VENDOR" "$PHP_MYSQL_IMAGE" 5.7.44
bash integrations/phpvms7/tests/pirep-concurrency/run.sh "$PATCHED_SITE_COPY" "$ILLUMINATE_VENDOR" "$PHP_MYSQL_IMAGE" 8.4
bash scripts/test-training-release.sh
~~~

## Required staging evidence and release gate

Supply a sanitized **full installed application copy** or an authorized isolated staging checkout and testing access. The two audits already contain the installed API PIREP controller. The following items remain necessary:

- Installed `resources/views/admin/pireps/actions.blade.php` or active theme overrides and every JS caller of the status route. Include `app/Http/Controllers/Frontend/PirepController.php`, ACARS/admin form requests, route definitions, route inventory with middleware, scheduler and queue-worker inventory. Use these to verify ownership, authorization, native filing and all PIREP decision entry points.
- `app/Contracts/Model.php`, PIREP/User/Aircraft/Rank/Journal/UserAward models and repositories, casts and observers; finance and ledger service/reporting code, SimBrief and bid services, award implementations, migrations and actual `SHOW CREATE TABLE` outputs for every accounting/journal/notification persistence table.
- All installed module providers, listeners and PIREP writers, including DisposableBasic registration, vmsACARS if installed and VuscgCustom routes and registration handlers. Include `php artisan event:list`, the complete installed `composer.lock`, and database, notification, queue and worker configuration with secrets removed.
- Isolated test pilot accounts, aircraft and representative PIREPs, sanitized data, staging credentials shared through an approved secret channel, and mail/webhook/Discord sink access. Include the MySQL exact build, engines, primary/replica routing and transaction isolation settings. Supply sanitized settings or establish them directly in staging. Exclude the live `.env`, API keys and webhook tokens.

Run the repository’s `PirepReviewBridgeTest.php` in the staged Laravel test app with disposable fixtures. Then exercise **real routes** with independent authenticated workers and barriers, fresh PIREPs for each race, and logs correlated to those IDs. Verify duplicate admin clicks, native versus signed Discord, both approve/reject orders, actual ACARS and DisposableBasic, concurrent admin edits and cron cleanup, finance recalculation and native reversals. Capture before/after report, pilot, aircraft, journal and award rows and listener dispatch counts. Inject failures at pilot/aircraft/finance/award stages, observe queue processing and mail/Discord sinks after commit, and test replay after an uncertain result. Verify registration email and webhook delivery on staging. These installed-application tests were unrun.

The PHP gate denies production even if its flag is true. Staging writes additionally require the matching native protocol marker. Any future production enablement needs a separate reviewed patch tying a default-off switch to the installed release identity and approved staging evidence, with independent review of all installed writers and a maintenance-window authorization. Do not use an environment rename or the old direct-SQL bot to bypass the gate. Keep native sync/graduation disabled under their existing release holds.

## Shutdown and rollback

Keep the bridge closed and stop new state decisions, filing and relevant workers before changing code. Drain transactions and record the affected PIREP IDs, receipts, counters, ledger, awards and queued notifications. For an authorized staging rollback, restore the previous exact PHP files and admin assets together; the two additive columns can remain for reconciliation. Disable or isolate still-pending notification jobs before reloading workers. Review already committed effects case by case before correcting the ledger or totals. Restoring a previous code build cannot reverse those effects. Require an approved reconciliation and backup restore plan before any destructive database change or production action.
