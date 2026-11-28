# P04 qualifications and staff training dashboard

## Qualification decisions

In the configured guild, use `/qualification grant`, `revoke`, `list`, `history`, or `import`. Responses and confirmations are ephemeral.

| Action | Instructor Pilot | Command Staff |
| --- | --- | --- |
| View another pilot’s qualifications or audit history | Yes | Yes |
| Grant MR, DLQ, HITRON, BLACKJACK, MQ9 | Yes | Yes |
| Grant IP or a new catalog type |  | Yes |
| Revoke any qualification |  | Yes |

Grants and revocations require confirmation. The bot refreshes guild roles and resolves the reviewer through `discord_links` and phpVMS before saving. Revocations require a reason. Date-only effective dates use UTC, cannot be in the future, and cannot precede the latest decision for that pilot and qualification scope. Qualifications stay separate from configured lesson counts. No rule grants a qualification from PIREP state, hours, or training progress.

Migration 006 for the selected [P07 schema profile](training-p07-phpmyadmin-installation.md) adds the catalog, immutable event history, active-state projection, reviewed import candidates, native/Discord delivery outbox, and append-only delivery attempts. The event includes internal and public pilot identities, verified reviewer identity and role, scope, date, reason, UTC creation time, and durable interaction ID. Status rows serialize concurrent changes. A grant or revocation and its delivery jobs commit together. DB checks restrict Instructor Pilot events to the approved grant list. Catalog identifiers and scope should remain stable once used. Configure new types explicitly; only Command Staff grants new types until the policy is extended.

## MR graduation replaces the legacy command

Use `/qualification grant pilot_id:3250 qualification:mr program:rw` or `program:fw`. The bot verifies one existing Discord link for the trainee and displays the planned graduation before confirmation. RW and FW are separate MR scopes. For qualification types other than MR, the bot queues only the applicable native award, IP role, or type-rating operation.

Once the native award and track rating succeed, the independently gated Discord worker can advance the verified ENS rank 12 to LTJG rank 13, add Pilot and the selected track role, add O-2 when the current rank is 13, then remove Cadet. It uses the rank synchronizer’s nickname formatter and sends an announcement in the trainee’s existing private thread. Existing senior ranks and other-track designations are preserved. A second track follows the same queue without repeating the rank advance. Revocation stops a pending graduation where possible and queues native qualification association review or removal. Rank and Discord designations already delivered require Command Staff review. Discord and MySQL cannot undo an in-flight external operation atomically.

Stop the old bot process before replacing and re-registering commands in staging. This prevents legacy `/promote` writes overlapping with the new path. Verify rank 13 name and every mapped Discord role and hierarchy. The legacy configuration used Pilot `1174513368992862218`, Cadet `1174513529253007370`, O-2 `1412811531925717245`, RW `1210792334749601862`, and FW `1210792296199749672` in its guild. Use verified IDs from the **staging guild** in `TRAINING_GRADUATION_PILOT_ROLE_ID`, `TRAINING_GRADUATION_CADET_ROLE_ID`, `TRAINING_GRADUATION_O2_ROLE_ID`, `TRAINING_GRADUATION_RW_ROLE_ID`, and `TRAINING_GRADUATION_FW_ROLE_ID`. Set `TRAINING_GRADUATION_RANK_NAME` to the exact installed name for rank 13. Leave `TRAINING_GRADUATION_ENABLED=false` until integration validation.

## Native inventory and synchronization

1. Use the [read-only inventory](../integrations/phpvms7/qualification-inventory.sql) on the staging schema. Verify the exact award and IP role IDs, names, role permissions, pivot layouts, model connections, and unique type codes. The supplied phpVMS materials did not include this installation’s award, role, or type-rating inventory. Validate the Laravel 10 model and relation APIs against the installed build. The adapter uses `user_awards`, Laratrust’s `role_user` morph relation with teams disabled, and `typerating_user`. A different layout needs a compatible adapter.
2. Use [007](../migrations/007_training_native_ownership.sql) on isolated staging only. Apply the individual statements for the targets being enabled. Each adds a nullable unique ownership marker to an existing native pivot. A null marker preserves preexisting assignments. Use a privileged migration account, review native-table compatibility and backups, and keep 006 and 007 separate. Disabled sync requires only 006.
3. Copy `integrations/phpvms7/config/vuscg_qualifications.php` and the VuscgCustom `Console/SyncQualifications.php` and `Services/QualificationNativePlan.php` files into their matching locations. In the existing VuscgCustom provider, register `$this->commands([\Modules\VuscgCustom\Console\SyncQualifications::class]);` for console use. Confirm `php artisan list` shows `vuscg:sync-qualifications`. Refresh config cache after setting environment variables. Schedule the command periodically on the website host after staging validation. There is no new HTTP endpoint. Both processes need the same database primary.
4. Keep `VUSCG_QUALIFICATION_SYNC_ENABLED`, `VUSCG_IP_ROLE_SYNC_ENABLED`, and `VUSCG_TYPE_RATING_SYNC_ENABLED` false until each path is validated. Configure `VUSCG_QUALIFICATION_AWARDS` as a JSON object keyed by qualification code, each with a verified numeric `id` and the exact installed `name`. HITRON must map to ID 7 and BLACKJACK to ID 8. The MR, IP, DLQ, and MQ9 award IDs still require inventory verification. The same native MR award represents either active MR scope. Do not share one native award ID across different qualifications. For IP role delivery additionally configure `VUSCG_IP_ROLE_ID` and `VUSCG_IP_ROLE_NAME` using the verified existing role. Check its permissions and test authorization in a fresh web session after syncing.
5. Set `VUSCG_TYPE_RATING_CODE_COLUMN` to the verified native column containing exact codes (`name`, `type`, or `code`). The supplied vUSCG snapshot uses `type`; confirm on staging and resolve each ID at runtime. RW MR attaches `HELI_USCG`, verifies it, then removes `TRNHELI` in the same transaction. FW MR does the same for `FW_CG` and `FWTRN`. BLACKJACK attaches `INTAPP`; MQ9 attaches `UAV`. HITRON and DLQ have no rating mapping in P04. The MR grant explicitly authorizes removing only its own trainee rating. A revocation removes only the matching integration-owned qualified rating and does not recreate a trainee rating.

The PHP worker processes due award, role, and type-rating jobs, preserves native `UserAward` model events, and uses verified native relations for assignments. A change in a verified mapping, missing row, or absent code fails closed and queues a retry. Already-present native items are preserved and never claimed. Revocations test the exact native identity and ownership marker before deleting. Keep marker columns and report evidence during rollback or reconciliation. Review label or mapping changes before enabling them; the worker will not silently move ownership between native IDs. Validate native award listeners and cache behavior on staging. The adapter does not create awards, roles, ratings, or permissions.

### Recovery

View job state and last result in `/qualification history`. For detailed recovery, inspect `vuscg_training_qualification_sync` and `vuscg_training_qualification_sync_attempts` by event ID. Clear causes such as bad mappings, missing Discord links, hierarchy, or downtime; failed jobs become due again after 15 minutes. Distinguish native grant results from `preserved_existing` and `superseded`. Review any revoked association that was manual. The Discord worker retries partial role/nickname updates idempotently. If the announcement was interrupted after send started, verify the private thread before resetting that graduation job’s announcement checkpoint and rescheduling it. Never reissue the qualification solely to repair delivery.

## Staff views and imports

`/training roster` shows one row per enrollment, with track/status filters and numbered pages. `/training stats` distinguishes unique pilots from enrollments and groups effective evaluations by outcome. `/training instructors` groups authenticated Discord signoffs by the recorded reviewer C-number, sorted by identifier, with unique trainees, RW/FW breakdown and outcomes. Historical training attempts appear in a separate total and cannot count as verified Discord evaluations. Date filters apply to training dates, both endpoints inclusive in UTC, with a 30-day default. Enrollment, effective lesson progress and current qualification totals are snapshots. Voided attempts are omitted from dashboard calculations. Qualification totals distinguish awards from distinct holders. Personal progress shows recorded qualifications independently of configured lesson completion.

Set `TRAINING_FOLLOWUP_DAYS` to 1–365, default 30. At or above the threshold a recorded active enrollment is flagged for follow-up. Missing records, recent activity and paused enrollments have separate states. The all-slots-passed and MR-unawarded flag requires at least one configured lesson and conveys no graduation eligibility.

Use a reviewed JSON array with one row per historical candidate, containing `source_id`, `pilot_id`, `qualification_id`, `tracker_label`, `flag`, `date` and `review`. Supply `program` for MR or another program-scoped qualification. The stable row ID and `--dataset` are used for idempotency. A reviewed `YES` can be staged; `NO` is ignored, and unclear mappings are reported. The uploader cannot award anything through the importer. A verified Discord reviewer uses `/qualification import candidate_id:… reason:…`. P05 records the import as historical, applying the same reviewer permissions. It creates no native delivery or graduation job. Any operational designation requires its own separately authorized decision and reconciliation.

```sh
node scripts/import-qualifications.js --dataset log-2026 reviewed.json
node scripts/import-qualifications.js --dataset log-2026 --stage reviewed.json
```

## Staging verification and rollback

Run `bash scripts/test-training-release.sh` for the disposable database matrix and PHP policy checks. Follow the version-specific schema and native mapping checks in the [P07 staging procedure](training-p07-phpmyadmin-installation.md). On staging, exercise the native worker with disposable pilots. Verify first grant, repeated delivery, preexisting and removed-then-recreated rows, dual-track MR, rating code mismatch, IP-disabled and IP-enabled cases, revocation ownership, and a split Discord failure followed by retry. Verify the real Laravel events and compare rank and permissions before and after. The staging-only `QualificationNativeSyncFeatureTest.php` can be copied to `tests/Feature` and run with `php artisan test --filter=QualificationNativeSyncFeatureTest` after setting `VUSCG_QUAL_TEST_PILOT_PUBLIC_ID` to a disposable pilot without the configured DLQ award or IP role. Production data and registration are outside this validation.

To roll back, disable both worker schedules and stop the P04 bot before changing registration. Preserve training events, queue state and native markers. Review any partially delivered graduations and native writes with Command Staff. Do not reactivate the legacy promotion path over a running P04 worker.

**P01 production blocker**

Bridge and native admin acceptance still do not share a consistent transaction and row-lock protocol. Keep production bridge approval disabled. See [P03 staging tests](training-p03.md).
