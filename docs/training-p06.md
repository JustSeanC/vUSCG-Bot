# P06 training enrollment and resources

P06 extends the existing training enrollment and adds a database-backed catalog. Resource categories do not establish lesson programs, mission ratings or qualifications. Stage Zero is optional. Existing PIREP and signoff workflows continue independently. The [P05 release gate](training-p05-readiness.md) still applies.

## Commands and permissions

| Command | Permission and behavior |
| --- | --- |
| `/training-config add-link category:rw title:"Rotary Wing Guide" url:"https://…"` | Command Staff. Adds one HTTPS resource. Optional description and display order. |
| `/training-config edit-link resource_id:<UUID> order:10` | Command Staff. Edits only supplied fields. Use `active:true` to restore a deactivated link. |
| `/training-config remove-link resource_id:<UUID>` | Command Staff. Deactivates while retaining configuration history and prior delivery snapshots. |
| `/training-config add-category category:reference title:"Reference Material"` | Command Staff. Adds a category with a stable code. It does not create an enrollment program. |
| `/training-config links category:rw` | Instructor Pilots and Command Staff. Lists links privately, using numbered pages. Command Staff can also see inactive entries. |
| `/training enroll pilot_id:3250 track:rw note:"Start from Stage 1."` | Instructor Pilots and Command Staff can start or resume RW/FW. Command Staff retain authorization over other enabled programs. |
| `/training enroll pilot_id:3250 track:rw active:false` | Command Staff only. Pauses an enrollment without removing trainee ratings. |
| `/training enroll pilot_id:3250 track:rw repeat:true note:"Correction: start from Flight 2."` | Instructor Pilots and Command Staff. Explicitly sends updated instructions for an active track; the original note stays in history. |
| `/training materials pilot_id:3250 category:hitron note:"Review before we meet."` | Instructor Pilots and Command Staff. Shares configured material independently of enrollment, ratings, rank and awards. |
| `/training delivery event_id:<UUID>` | Staff. Shows private delivery and native job state, without exposing the saved text. |
| `/training delivery event_id:<UUID> retry:true` | Command Staff with confirmation. Reconciles or retries after checking the original private thread. |

Stage Zero (`stage0`), Fixed Wing (`fw`), Rotary Wing (`rw`), MQ9 (`mq9`), HITRON (`hitron`), BLACKJACK (`blackjack`), DLQ (`dlq`), and Instructor Pilot (`ip`) are seeded. Material URLs are parsed locally and never fetched. HTTPS Google Drive documents and folders are supported. URLs with embedded credentials are refused. The bot stores creator/editor IDs, display order, status, UTC timestamps and before/after snapshots. Resource providers still control access to their own documents.

Mutations use ephemeral confirmation and re-fetch roles and the linked phpVMS instructor before writing. One unambiguous target link in the configured server is required for enrollment and sharing. Actor identity and separate instructional notes up to 400 characters are stored on immutable event rows. Enrollment edits, notes, and the associated delivery jobs commit together. Previous private evaluation comments remain separate. Automatic enrollment messages are queued on a real start or resume. Active duplicates create no additional enrollment or automatic notice. Use explicit repeat or material sharing for a new message.

## Message and Stage Zero behavior

An enrollment message contains the pilot's C-number and name, program, active status, documents in configured order, the optional instructional note and the instructor's C-number. For example:

> **vUSCG Training Enrollment**
> C3250 — Example Pilot · Rotary Wing
> Training materials · Rotary Wing Guide, Rotary Wing Checklist
> Instructor note · Start from Stage 1. Record your last flight and ask questions.
> Instructor C55 · Active

Only configured links are included. Long catalogs keep the full ordered list in an attachment on the same message. Content and mentions are sanitized. A missing catalog produces a clear warning while retaining the enrollment. A share request with no active links fails without a data change.

The delivery worker only sends to an existing matching private training thread under the configured parent, with the linked trainee verified as a member. It reopens a verified archived thread if allowed. Missing, conflicting, locked or inaccessible threads leave the event available for recovery. No enrollment or share command creates threads.

The existing Command Staff `/activate` option for the Stage Zero hours band queues Stage Zero instructions using `stage0`. The normal welcome message is preserved for new activation threads. Activation retries reuse a verified existing thread and a single durable Stage Zero event per pilot, including when no links were configured. With no links the trainee still receives the Stage Zero instructions and staff get a warning. To send newly configured links, use `/training materials category:stage0`. Ordinary sharing of Stage Zero links does not designate Stage Zero as required or assign either training track. Specialized resource shares similarly have no relation to P04 qualification decisions.

## Enrollment ratings

| Active enrollment | Trainee code | Native rating that prevents a trainee assignment |
| --- | --- | --- |
| Fixed Wing | FWTRN | FW_CG |
| Rotary Wing | TRNHELI | HELI_USCG |

The existing `vuscg:sync-qualifications` job processes the separate enrollment target. It locks the primary pilot row shared with enrollment and MR commits, then checks the current enrollment revision/enablement, MR state/history, and verified Discord link using current reads. A paused or superseded enrollment and an MR grant after enqueue suppress stale work. Missing or ambiguous native codes and link changes retry without an assignment. It resolves both codes against the configured native column. A present qualified rating suppresses trainee assignment even when there is no local MR event. The worker uses the existing native relation and migration 007 marker to attach only; an existing manual trainee rating is preserved. Pauses do not detach anything. P04 still owns qualified rating transitions, rank and Discord designations. Both tracks are independent.

## Installation and flags

1. Apply the existing prerequisites in the [deployment runbook](training-deployment-runbook.md). Apply [008](../migrations/008_training_materials_and_delivery.sql) after 004 and the existing P05 schema, before deploying the new bot. Migration 008 is shared by MySQL 5.7.44 and 8.4. Use the corresponding earlier definitions from the [P07 staging procedure](training-p07-phpmyadmin-installation.md). Migration 008 creates six tables and seeds categories. It preserves existing resources on repeat. It references the existing enrollment composite key and does not rewrite 004–007. Verify privileges for inserting/updating and auditing these tables and for named locks. Assess metadata locks and backup scope in staging.
2. Deploy the bot and register commands in the isolated test guild. Confirm `GUILD_ID`, staff roles, the shared `TRAINING_CHANNEL_ID`, and thread permissions. `TRAINING_INSTRUCTION_DELIVERY_ENABLED=false` disables immediate and background Discord delivery; when absent it is enabled. Staff can still queue an event while delivery is off.
3. In the **staging website**, copy the updated config and VuscgCustom `Console/SyncQualifications.php` and `Services/TraineeRatingPlan.php` and `Services/NativeSyncDatabase.php`. Preserve console registration and the existing model/qualification policy files. Verify the exact installed type code column and all four native rating records. Confirm the 007 ownership marker exists on the actual type-rating pivot, that the native (pilot, rating) association is unique, and that PHP and the bot use the same primary.
4. Keep `VUSCG_TRAINEE_RATING_SYNC_ENABLED=false` until verification. This Laravel flag is independent of the P04 native qualification and graduation flags. It reuses `VUSCG_TYPE_RATING_CODE_COLUMN`. Refresh cached Laravel settings and restart the staged scheduler after configuration changes. Keep P05 bridge safety gates. No pre-P06 enrollment backfill runs; schedule any desired transition through an explicitly authorized current workflow.

## Delivery recovery and rollback

Record the event UUID from the private staff response. Query it with `/training delivery`. Discord increments the attempt log and automatically retries definite failures or unavailable threads. A send with an unknown outcome is quarantined. The worker persists a send checkpoint, uses a stable nonce and records the message ID on success. Recovery searches the recent messages of the same verified private thread for the exact bot-authored event marker. An explicit Command Staff retry may send again if the marker cannot be found; check prior messages first, especially after long downtime. No background retry blindly reposts an uncertain send. Account changes and different destination threads require manual verification. A pause or newer transition supersedes instruction delivery from an older enrollment. Discord and SQL are separate services so already delivered messages remain in history.

The native worker retries safe failures with a bounded batch size and logs each result and resolved native ID. Inspect the audited job first. In isolated staging, `php artisan vuscg:sync-qualifications --event=<UUID>` processes a due event. Correct mapping or links, then allow the recorded retry time. Do not directly assign a rating to clear an outbox entry.

For rollback, stop the bot/scheduler or disable their P06 delivery flags and refresh Laravel cache before reverting. Keep migration 008, its events, note and link snapshots, attempts, and native ownership markers. Reconcile in-flight Discord messages and any native effects. Restore the reviewed code and Discord command payload. Avoid destructive database changes or automatic removal of assigned ratings.

## Staging and verification

Run `bash scripts/test-training-release.sh` for the full accumulated local fixture suite. In a verified isolated guild, test instructor authorization, catalog CRUD and ordering, multiple links, RW/FW enroll/pause/resume, explicit repeat, independent specialty sharing, Stage Zero activation and recovery, and archived/missing/locked thread cases. Check that no qualifying, rank or PIREP changes occur.

The native fixture suite can be copied from `integrations/phpvms7/tests/TraineeRatingSyncFeatureTest.php` to the isolated phpVMS `tests/Feature` directory. With the correct rating column and 007/008 applied, set `VUSCG_TRAINEE_TEST_PILOT_PUBLIC_ID` to a disposable uniquely linked pilot with no prior enrollments, scoped MR or tracked ratings. Run `php artisan test --filter=TraineeRatingSyncFeatureTest`. Also rehearse delayed delivery before and after real P04 MR synchronization, and observe retries and the opposite track on the installed build. Disposable MySQL and standalone PHP policy tests do not establish Laravel or live Discord compatibility. P05’s production blockers remain.
