# P07 installation rehearsal with cPanel phpMyAdmin

This procedure is for an explicitly authorized, isolated staging copy. Use a sanitized schema, staging phpVMS installation and Discord application/guild, and test-only credentials and delivery sinks. The supplied production identifiers are `vuscgco1_finalphp` and `/home/vuscgco1/crew.vuscg.com/`. Use these to recognize the live installation and stop if phpMyAdmin or the web configuration points there. Confirm the staging website path with its operator. [Release gates](training-p07-mysql57-compatibility.md) · [Operational runbook](training-deployment-runbook.md)

## Before importing

1. Verify the checkout is the reviewed P07 commit on `develop/training-system`. Record the commit, SQL filenames and checksums, the approved staging schema, and its server version. Review and stop the affected staging bot, scheduled native worker, and any phpVMS writers that can touch tables being altered. Disable the applicable feature flags before rehearsing DDL.
2. In cPanel, confirm the database account has `SELECT` for the inventory and authorized export. For the selected schema the migration account also needs `CREATE`, `ALTER`, `INDEX`, `REFERENCES`, and the `INSERT`/`UPDATE` required by seeds and ALTER operations. Check hosting grants and phpMyAdmin upload/time limits first. Running as a database server administrator or installing routines/triggers is unnecessary. Keep DDL privileges out of bot/web runtime credentials. The runtime account needs visibility of the training tables and access to its own schema metadata.
3. Select the approved **staging** database in the left tree. Open **SQL** and run the read-only preflight file. Check the schema in the first output row, the expected version, and `foreign_key_checks = 1`. The read-only preflight can run with the server’s default SQL mode, including an empty value. Establish strict mode in each migration session before any writes. The preflight reports the version-specific migration path and existing table/column/index/constraint inventory. The native pivots must be InnoDB. Stop on an unexpected version, engine, schema or partial state. [Read-only preflight SQL](../integrations/phpvms7/training-schema-preflight.sql)
4. From the selected staging database use **Export → Custom → SQL**. Include structure and data, preserving keys and all relevant objects the account can back up. Ask the operator/provider to include any required views, triggers, routines, events, code and configuration that your export cannot capture. Store the backup and checksum in approved restricted storage. Restore it to a *second* disposable schema using authorized backup tooling. Compare critical row counts and `SHOW CREATE TABLE` for table definitions, pivots and existing training tables. Verify keys, seed customizations and permissions; record the restore result before running DDL.
5. Review the native inventory and exact definitions of `users`, `pireps`, `discord_links`, `awards`, `roles`, `typeratings` and all three pivots. For the installed role confirm teams, morph type, native permissions, and cache behavior in Laravel. For awards inventory missing or ambiguous mappings. Check `SELECT user_id, award_id, COUNT(*) FROM user_awards GROUP BY user_id, award_id HAVING COUNT(*) > 1` and inspect any returned rows without deleting or merging them. [Native inventory SQL](../integrations/phpvms7/qualification-inventory.sql)

## Import order and checkpoints

phpMyAdmin may open a new database session for every SQL request or import. A successful `SET SESSION` in an earlier tab submission does not carry over. For **each** migration file or individual ALTER, place the following at the start of the **same** SQL submission as the migration statements. For **Import → Choose File → SQL → Import**, add the prefix to a temporary copy of that one file and leave the tracked migration unchanged.

~~~sql
SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION';
SELECT DATABASE(), VERSION(), @@SESSION.sql_mode, @@SESSION.foreign_key_checks;
-- Append the exact migration file or the individually reviewed 007 ALTER below.
~~~

Before submitting any DDL, run a separate read-only preflight to verify the database, version and FK setting. Submit the migration with the prefix in a stop-on-error import or session. Expect both SQL modes shown above and `foreign_key_checks = 1` in the result. If stop-on-error or single-session execution is uncertain, use a verified MySQL client session instead. Disable automatic continuation, resume, and any option that disables foreign-key checks. If you split a migration across SQL submissions, repeat the prefix in every one. Keep the 5.7 files' SET/PREPARE/EXECUTE/DEALLOCATE guard block together and run it before the file's DDL. Stop on any error and verify each checkpoint before proceeding. Keep the 8.4 files out of the 5.7 import list.

| Order | File | Checkpoint |
| --- | --- | --- |
| 1–3 | [001](../migrations/001_cgas_tour.sql), [002](../migrations/002_cgas_historical_announcements.sql), [003](../migrations/003_cgas_phpvms_awards.sql) | On a fresh CGAS fixture, apply in order. On an already installed clone inventory and preserve CGAS. 001 yields `bot_cgas_tour_versions` and `bot_cgas_completions`. 002 adds the two `historical_announcement_*` fields. 003 adds the four `award_*` fields and `ix_bot_cgas_award_work`. 002 and 003 each apply once. Keep the CGAS workers paused through any changes. |
| Separate P01 prerequisite | [bridge-nonces.sql](../integrations/phpvms7/bridge-nonces.sql) | `SHOW CREATE TABLE vuscg_pirep_review_nonces` shows InnoDB, the nonce primary key and expiry index. Bridge decisions stay disabled outside the approved isolated tests. |
| 004 | [5.7.44](../migrations/mysql57/004_training_records.sql) · [8.4](../migrations/004_training_records.sql) | Programs, lessons, enrollments and records exist. For a fresh fixture RW and FW each have nine lessons and Stage Zero is disabled. 5.7 also has the one-valued integrity table plus source and void FKs. 8.4 has the original source and void CHECKs. |
| 005 | [5.7.44](../migrations/mysql57/005_training_pirep_link.sql) · [8.4](../migrations/005_training_pirep_link.sql) | `SHOW CREATE TABLE vuscg_training_records` shows the `pirep` source, stored `active_pirep_evaluation` column and six-column `uq_training_pirep_evaluation` unique index. Existing manual and imported rows and their IDs are retained. Apply once. |
| 006 | [5.7.44](../migrations/mysql57/006_training_qualifications.sql) · [8.4](../migrations/006_training_qualifications.sql) | The six qualification tables and six seeded qualification codes exist. Verify event guard FKs on 5.7 or enforced qualification CHECKs on 8.4; verify the status, delivery and attempt keys. |
| 007, optional per native target | [007](../migrations/007_training_native_ownership.sql) | Execute each opted-in ALTER as its own SQL submission after native adapter review. Verify the new nullable ASCII binary owner column and its single-column unique index immediately on that table. Existing assignments must stay unmarked on first installation. Keep each native target off until its own verification. Qualifying and enrollment rating workers both need the rating pivot marker. |
| 008 | [008](../migrations/008_training_materials_and_delivery.sql) | Check the six resource/instruction tables, composite FK to enrollments, and eight initial categories. In MySQL 5.7, verify the `event_seq` unique auto-increment ordering column. Existing resource snapshots and audit rows are retained. |

Read-only checks can run in a later phpMyAdmin session. Its SQL mode can be empty even after a successful strict migration, so use migration-session output to verify the write settings. Use `SHOW CREATE TABLE` to verify each checkpoint. For example, after the relevant files:

```sql
SELECT DATABASE(), VERSION(), @@session.sql_mode, @@session.foreign_key_checks;
SHOW CREATE TABLE vuscg_training_records;
SHOW CREATE TABLE vuscg_training_qualification_events;
SHOW CREATE TABLE vuscg_training_instruction_events;
SELECT program_id, COUNT(*) AS lessons FROM vuscg_training_lessons GROUP BY program_id;
SELECT qualification_id, scope FROM vuscg_training_qualifications ORDER BY qualification_id;
SELECT category_id FROM vuscg_training_resource_categories ORDER BY category_id;
SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, NON_UNIQUE, COLUMN_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN
  ('uq_training_pirep_evaluation','uq_user_awards_vuscg_owner','uq_role_user_vuscg_owner','uq_type_rating_vuscg_owner')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
```

On 5.7, run this additionally after 006. Expect exactly four relationships, with the corresponding stored generated columns defined in `SHOW CREATE TABLE`. The parent query returns one row with `allowed = 1`.

```sql
SHOW CREATE TABLE vuscg_training_integrity_guard;
SELECT id, allowed FROM vuscg_training_integrity_guard;
SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_SCHEMA = DATABASE()
  AND REFERENCED_TABLE_NAME = 'vuscg_training_integrity_guard'
ORDER BY TABLE_NAME, CONSTRAINT_NAME;
```

Verify each opted-in 007 statement with `SHOW CREATE TABLE user_awards`, `SHOW CREATE TABLE role_user`, or `SHOW CREATE TABLE typerating_user`. Compare existing keys and association counts against the backup. For each newly marked table, `SELECT COUNT(vuscg_qualification_owner) FROM <confirmed_pivot>` returns zero before any worker runs. Use a staging test pilot to prove that unauthorized qualification actions fail and an invalid source, incomplete void or duplicate active evaluation cannot be committed. Run the repository test matrix before the rehearsal.

## Maintenance window, failures and recovery

- MySQL DDL commits implicitly. 005 can rebuild or lock the training records table. 002/003 can affect the CGAS tables. Each 007 ALTER builds an index on an existing native pivot and can block writers, take disk space or rebuild a table. Measure impact with representative staging data, confirm free space and obtain a maintenance window. Even additive 004/006/008 can wait on metadata locks of referenced tables.
- After failure, leave workers stopped. Save the exact submitted statement/error and inspect the selected schema with the preflight and `SHOW CREATE TABLE`. Check whether a timed-out import is still running with the staging operator. 005 must show both the generated column and the unique index. 007 may have succeeded on only a subset of pivots. Apply only the missing complete statement after verification. If a table has only part of a statement's intended shape, stop and review its definition and data before using any corrective DDL.
- A 5.7 schema that previously used the root 004 or 006 may contain rows with no corresponding guards. The alternate files deliberately stop on those existing tables. Preserve rows, inventory and reconcile invalid records offline, and use a separately reviewed recovery or approved restore before proceeding. Repeatable CREATE/seed statements do not repair an incorrect definition.
- For rollback, restore the previous reviewed bot/module files and configuration only when compatible with the retained schema. Keep queues, history, ownership markers, bridge nonces and backups. Resolve partial native deliveries with the visible audit trail. A database restore requires an approved plan for changes since the snapshot and a proven restore into a separate schema first. This procedure does not drop or replace tables.

## Runtime configuration

The bot and training import scripts initialize strict mode before using each pool checkout. The native qualification and trainee-rating command uses a separate nonpersistent Laravel writer session with strict mode and the same database primary. Copy `Services/NativeSyncDatabase.php` alongside the updated `Console/SyncQualifications.php` in VuscgCustom. Keep the website’s existing `config/database.php` setting and server-wide SQL mode. The native worker requires the installed Laravel MySQL connector and the `vuscg_native_sync` connection name available for its command-local configuration. The guarded 5.7 schema and `foreign_key_checks = 1` are still required. Confirm the native models resolve to the scoped writer on the installed phpVMS build and rehearse any queued award listeners. Runtime initialization does not configure phpMyAdmin sessions.

## Configure and rehearse in stages

1. Start with `PIREP_BRIDGE_DECISIONS_ENABLED=false`, `VUSCG_QUALIFICATION_SYNC_ENABLED=false`, `VUSCG_TYPE_RATING_SYNC_ENABLED=false`, `VUSCG_IP_ROLE_SYNC_ENABLED=false`, `VUSCG_TRAINEE_RATING_SYNC_ENABLED=false`, `TRAINING_GRADUATION_ENABLED=false` and `TRAINING_INSTRUCTION_DELIVERY_ENABLED=false`. Stop the relevant scheduler or bot, refresh Laravel's config and route cache using the staged deployment procedure, and verify the site and bot connections both use the approved writers.
   The supplied values to recheck and then set on staging are `VUSCG_TYPE_RATING_CODE_COLUMN=type`, `VUSCG_IP_ROLE_ID=2`, `VUSCG_IP_ROLE_NAME=instructor-pilot`, and `TRAINING_GRADUATION_RANK_NAME="O-2 Lieutenant (junior grade)"`. Provide `VUSCG_QUALIFICATION_AWARDS` as a reviewed ID-and-exact-name map. Leave MR, MQ9, DLQ and IP unmapped until approved.

2. Validate core training commands, permissions, linked reports already accepted natively, and private threads. In the staging guild enable instructional messages alone and prove delivery, retry, duplicate prevention and Stage Zero. Keep bridge decisions off by default and return them to false after each authorized isolated native test. P05's native accounting concurrency gate remains critical.
3. After native evidence, enable one verified synchronization lane at a time. First exercise awards with verified mappings and nonoverlapping CGAS assignments. Then validate the qualification rating and separate trainee rating lane, exact `typeratings.type` codes, delayed jobs, and two-track safety. Verify the existing IP role independently with Command Staff using its native authorization/cache behavior. Graduation comes last, after scoped native MR award and qualified rating delivery plus Discord link, role and rank verification. Keep any lane with missing mapping, failed staging evidence or an unresolved blocker disabled.
4. To stop effects, disable the flags, stop the bot and qualification scheduler, and refresh/reload the staged PHP and bot configuration. Preserve receipts, outboxes and native state for reconciliation. Review ambiguous/in-flight effects before replaying. [Operational installation and rollback](training-deployment-runbook.md)

For a hosting upgrade, require a provider-supported plan with backups and rehearsed restoration. If using a logical migration to a new 8.4 server, preserve existing 5.7 guards and history. Do not rerun root 004–006 over that restored schema. [Compatibility and hosting options](training-p07-mysql57-compatibility.md)
