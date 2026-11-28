<?php

namespace Modules\VuscgCustom\Console;

use App\Models\Award;
use App\Models\Typerating;
use App\Models\User;
use App\Models\UserAward;
use DomainException;
use Illuminate\Console\Command;
use Illuminate\Database\Eloquent\Relations\MorphToMany;
use Illuminate\Support\Facades\DB;
use Modules\VuscgCustom\Services\QualificationNativePlan as Plan;
use Modules\VuscgCustom\Services\TraineeRatingPlan;
use Throwable;

final class SyncQualifications extends Command
{
    protected $signature = 'vuscg:sync-qualifications {--event= : Process only this qualification event ID}';
    protected $description = 'Deliver audited vUSCG qualification changes to verified native associations';

    public function handle(): int
    {
        $settings = config('vuscg_qualifications', []);
        $qualifications = ($settings['enabled'] ?? false) === true;
        $trainees = TraineeRatingPlan::enabled($settings);
        if (!$qualifications && !$trainees) {
            $this->line('Native qualification synchronization is disabled.');
            return self::SUCCESS;
        }

        $eventId = $this->option('event');
        if ($eventId !== null && !preg_match('/\A[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\z/', $eventId)) {
            $this->error('Use a qualification event UUID.');
            return self::FAILURE;
        }
        $jobs = !$qualifications ? [] : DB::table('vuscg_training_qualification_sync')->whereIn('state', ['pending', 'retry'])
            ->whereIn('target', ['award', 'ip_role', 'type_rating'])
            ->when($eventId, fn ($query) => $query->where('event_id', $eventId))
            ->where('next_attempt_at', '<=', DB::raw('UTC_TIMESTAMP()'))
            ->orderBy('next_attempt_at')->orderBy('event_id')->orderBy('target')->limit(50)->get();
        foreach ($jobs as $job) {
            $nativeId = null;
            try {
                $roleCache = DB::transaction(function () use ($job, $settings, &$nativeId): ?array {
                    $queue = $this->queue($job)->lockForUpdate()->first();
                    if (!$this->due($queue)) {
                        return null;
                    }
                    $event = DB::table('vuscg_training_qualification_events')->where('event_id', $job->event_id)->first();
                    if ($event->candidate_id !== null) {
                        $this->record($queue, 'historical_audit_only', null, false);
                        return null;
                    }
                    $mapping = Plan::target($event, $job->target, $settings);
                    $nativeId = $mapping['id'] ?? null;
                    $user = User::query()->whereKey($event->user_id)->lockForUpdate()->first();
                    if (!$user || $user->getConnection() !== DB::connection() || (string) $user->pilot_id !== (string) $event->public_pilot_id) {
                        throw new DomainException('pilot_mapping_changed');
                    }
                    $scopes = DB::table('vuscg_training_qualification_status as s')
                        ->join('vuscg_training_qualification_events as e', 'e.event_id', '=', 's.last_event_id')
                        ->where('s.user_id', $event->user_id)->where('s.qualification_id', $event->qualification_id)
                        ->select('s.*', 'e.candidate_id')->sharedLock()->get();
                    $scope = $scopes->firstWhere('program_id', $event->program_id);
                    if (!$scope || $scope->last_event_id !== $event->event_id) {
                        $this->record($queue, 'superseded', $nativeId, false);
                        return null;
                    }
                    $desired = $scopes->contains(fn ($scope) => (bool) $scope->active && $scope->candidate_id === null);
                    $marker = Plan::marker($event, $job->target);
                    if ($job->target === 'type_rating') {
                        $desired = (bool) $scope->active;
                        if ($desired && !DB::table('vuscg_training_qualification_sync')->where([
                            'event_id' => $job->event_id, 'target' => 'award', 'state' => 'complete',
                        ])->exists()) {
                            throw new DomainException('awaiting_native_award');
                        }
                        [$result, $nativeId] = $this->syncRating($user, $mapping, $marker, $desired, $settings);
                    } elseif ($job->target === 'award') {
                        $result = $this->syncAward($user, $mapping, $marker, $desired);
                    } else {
                        $result = $this->syncRole($user, $mapping, $marker, $desired);
                        // Leave the job due until cache invalidation succeeds after the native commit.
                        $this->appendAttempt($queue, $result, $nativeId);
                        return [$user, $result];
                    }
                    $this->record($queue, $result, $nativeId, false);
                    return null;
                });
                if ($roleCache !== null) {
                    [$user, $result] = $roleCache;
                    $user->flushLaratrustCache();
                    DB::transaction(function () use ($job, $result, $nativeId): void {
                        $queue = $this->queue($job)->lockForUpdate()->first();
                        if ($this->due($queue)) {
                            $this->record($queue, $result, $nativeId, false);
                        }
                    });
                }
            } catch (Throwable $error) {
                $code = $error instanceof DomainException && preg_match('/\A[a-z_]{1,60}\z/', $error->getMessage())
                    ? $error->getMessage() : 'native_database_or_model_error';
                DB::transaction(function () use ($job, $code, $nativeId): void {
                    $queue = $this->queue($job)->lockForUpdate()->first();
                    if ($this->due($queue)) {
                        $this->record($queue, $code, $nativeId, true);
                    }
                });
                $this->warn('A qualification sync will retry: '.$code);
            }
        }

        if ($trainees) {
            $this->syncTraineeJobs($settings, $eventId);
        }

        return self::SUCCESS;
    }

    private function queue(object $job)
    {
        return DB::table('vuscg_training_qualification_sync')
            ->where('event_id', $job->event_id)->where('target', $job->target);
    }

    private function due(?object $job): bool
    {
        return $job && $job->state !== 'complete' && $job->next_attempt_at <= gmdate('Y-m-d H:i:s');
    }

    private function record(object $job, string $result, ?string $nativeId, bool $retry): void
    {
        $this->queue($job)->update([
            'state' => $retry ? 'retry' : 'complete',
            'attempts' => DB::raw('attempts + 1'),
            'next_attempt_at' => $retry ? DB::raw('DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE)') : DB::raw('UTC_TIMESTAMP()'),
        ]);
        $this->appendAttempt($job, $result, $nativeId);
    }

    private function appendAttempt(object $job, string $result, ?string $nativeId): void
    {
        DB::table('vuscg_training_qualification_sync_attempts')->insert([
            'event_id' => $job->event_id, 'target' => $job->target, 'native_id' => $nativeId,
            'result' => $result, 'created_at' => DB::raw('UTC_TIMESTAMP(6)'),
        ]);
    }

    private function syncAward(User $user, array $mapping, string $marker, bool $active): string
    {
        $award = Award::query()->whereKey($mapping['id'])->sharedLock()->first();
        if (!$award || $award->name !== $mapping['name'] || (new UserAward())->getTable() !== 'user_awards'
            || (new UserAward())->getConnection() !== DB::connection()) {
            throw new DomainException('award_mapping_mismatch');
        }
        $identity = ['user_id' => $user->id, 'award_id' => $award->id];

        return $this->syncAssociation('user_awards', $identity, $marker, $active, function () use ($identity, $marker): void {
            // UserAward dispatches the installation's normal model events, including AwardAwarded where declared.
            $award = (new UserAward())->forceFill($identity + ['vuscg_qualification_owner' => $marker]);
            if (!$award->save()) {
                throw new DomainException('award_model_refused_save');
            }
        });
    }

    private function syncRole(User $user, array $mapping, string $marker, bool $active): string
    {
        $roles = $user->roles();
        if (config('laratrust.teams.enabled', false) || !method_exists($user, 'flushLaratrustCache')
            || !$roles instanceof MorphToMany || $roles->getTable() !== 'role_user'
            || $roles->getRelated()->getTable() !== 'roles' || $roles->getRelated()->getConnection() !== DB::connection()
            || $roles->getForeignPivotKeyName() !== 'user_id' || $roles->getRelatedPivotKeyName() !== 'role_id') {
            throw new DomainException('unsupported_role_relation');
        }
        $role = $roles->getRelated()->newQuery()->whereKey($mapping['id'])->sharedLock()->first();
        if (!$role || $role->name !== $mapping['name']) {
            throw new DomainException('role_mapping_mismatch');
        }
        $identity = ['user_id' => $user->id, 'role_id' => $role->id, $roles->getMorphType() => $roles->getMorphClass()];

        return $this->syncAssociation('role_user', $identity, $marker, $active,
            fn () => $roles->attach($role->id, ['vuscg_qualification_owner' => $marker]));
    }

    private function findRating(string $column, string $code): Typerating
    {
        $rows = Typerating::query()->where($column, $code)->sharedLock()->get()
            ->filter(fn ($row) => $row->getAttribute($column) === $code);
        if ($rows->count() !== 1) {
            throw new DomainException('rating_code_missing_or_ambiguous');
        }
        return $rows->first();
    }

    private function ratingRelation(User $user, array $settings): array
    {
        $column = $settings['rating_code_column'] ?? null;
        $relation = $user->typeratings();
        if (!in_array($column, ['code', 'name', 'type'], true) || $relation->getTable() !== 'typerating_user' ||
            $relation->getForeignPivotKeyName() !== 'user_id' || $relation->getRelatedPivotKeyName() !== 'typerating_id' ||
            $relation->getRelated()->getConnection() !== DB::connection()) {
            throw new DomainException('rating_schema_not_verified');
        }
        return [$relation, $column];
    }

    private function syncRating(User $user, array $mapping, string $marker, bool $active, array $settings): array
    {
        [$relation, $column] = $this->ratingRelation($user, $settings);
        $rating = $this->findRating($column, $mapping['qualified']);
        if ($active && !$rating->active) {
            throw new DomainException('qualified_rating_disabled');
        }
        $identity = ['user_id' => $user->id, 'typerating_id' => $rating->id];
        $result = $this->syncAssociation('typerating_user', $identity, $marker, $active,
            fn () => $relation->attach($rating->id, ['vuscg_qualification_owner' => $marker]));
        if ($active && !DB::table('typerating_user')->where($identity)->exists()) {
            throw new DomainException('qualified_rating_not_persisted');
        }
        if ($active && $mapping['trainee']) {
            $trainee = $this->findRating($column, $mapping['trainee']);
            if ($trainee->id === $rating->id) {
                throw new DomainException('trainee_rating_equals_qualified');
            }
            // This explicit MR graduation transition is the only removal of a preexisting rating.
            $removed = $relation->detach($trainee->id);
            if ($removed) {
                $result .= ':trainee_removed:'.$trainee->id;
            }
        }

        return [$result, (string) $rating->id];
    }

    private function traineeQueue(string $id)
    {
        return DB::table('vuscg_training_instruction_delivery')->where(['event_id' => $id, 'target' => 'trainee_rating']);
    }

    private function traineeDue(?object $job): bool
    {
        return $job && in_array($job->state, ['pending', 'retry'], true)
            && $job->next_attempt_at <= gmdate('Y-m-d H:i:s').'.999999';
    }

    private function recordTrainee(string $eventId, string $state, string $result, ?string $nativeId = null): void
    {
        $this->traineeQueue($eventId)->update([
            'state' => $state, 'result' => $result,
            'next_attempt_at' => DB::raw('DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 15 MINUTE)'),
        ]);
        DB::table('vuscg_training_instruction_attempts')->insert([
            'event_id' => $eventId, 'target' => 'trainee_rating', 'native_id' => $nativeId,
            'result' => $result, 'created_at' => DB::raw('UTC_TIMESTAMP(6)'),
        ]);
    }

    private function syncTraineeJobs(array $settings, ?string $id): void
    {
        $ids = DB::table('vuscg_training_instruction_delivery')->where('target', 'trainee_rating')
            ->whereIn('state', ['pending', 'retry'])->where('next_attempt_at', '<=', DB::raw('UTC_TIMESTAMP(6)'))
            ->when($id, fn ($query) => $query->where('event_id', $id))
            ->orderBy('next_attempt_at')->limit(50)->pluck('event_id');
        foreach ($ids as $eventId) {
            try {
                DB::transaction(function () use ($eventId, $settings): void {
                    if (!$this->traineeDue($this->traineeQueue($eventId)->lockForUpdate()->first())) {
                        return;
                    }
                    $this->applyTraineeRating($eventId, $settings);
                });
            } catch (Throwable $error) {
                $code = $error instanceof DomainException && preg_match('/\A[a-z_]{1,60}\z/', $error->getMessage())
                    ? $error->getMessage() : 'native_database_or_model_error';
                DB::transaction(function () use ($eventId, $code): void {
                    if ($this->traineeDue($this->traineeQueue($eventId)->lockForUpdate()->first())) {
                        $this->recordTrainee($eventId, 'retry', $code);
                    }
                });
                $this->warn('A trainee rating will retry: '.$code);
            }
        }
    }

    private function applyTraineeRating(string $eventId, array $settings): void
    {
        $event = DB::table('vuscg_training_instruction_events')->where('event_id', $eventId)->first();
        if (!in_array($event->kind, ['start', 'resume'], true)) {
            $this->recordTrainee($eventId, 'superseded', 'invalid_enrollment_event');
            return;
        }
        $mapping = TraineeRatingPlan::mapping($event->program_id);
        // The enrollment and MR writers take this same user row before changing current state.
        $user = User::query()->whereKey($event->user_id)->lockForUpdate()->first();
        if (!$user || $user->getConnection() !== DB::connection() || (string) $user->pilot_id !== (string) $event->public_pilot_id) {
            throw new DomainException('pilot_mapping_changed');
        }
        $enrollment = DB::table('vuscg_training_enrollments as e')
            ->join('vuscg_training_programs as p', 'p.program_id', '=', 'e.program_id')
            ->where('e.user_id', $event->user_id)->where('e.program_id', $event->program_id)
            ->select('e.active', 'p.enabled')->sharedLock()->first();
        $latest = DB::table('vuscg_training_instruction_events')->where([
                'user_id' => $event->user_id, 'program_id' => $event->program_id,
            ])->whereIn('kind', ['start', 'resume', 'pause'])->orderByDesc('event_seq')->sharedLock()->value('event_id');
        $missionRated = DB::table('vuscg_training_qualification_status')->where([
            'user_id' => $event->user_id, 'program_id' => $event->program_id, 'qualification_id' => 'mr', 'active' => true,
        ])->sharedLock()->first();
        $newerGrant = DB::table('vuscg_training_qualification_events')->where([
            'user_id' => $event->user_id, 'program_id' => $event->program_id, 'qualification_id' => 'mr', 'action' => 'grant',
        ])->where('created_at', '>=', $event->created_at)->sharedLock()->first() !== null;
        $hold = TraineeRatingPlan::hold(
            (bool) ($enrollment->active ?? false) && (bool) ($enrollment->enabled ?? false),
            $latest === $eventId, $missionRated !== null || $newerGrant,
        );
        if ($hold !== null) {
            $this->recordTrainee($eventId, 'superseded', $hold);
            return;
        }

        $links = DB::table('discord_links')->where('pilot_id', $event->public_pilot_id)->sharedLock()->pluck('discord_id');
        if ($links->count() !== 1 || (string) $links->first() !== (string) $event->trainee_discord_id ||
            DB::table('discord_links')->where('discord_id', $event->trainee_discord_id)
                ->where('pilot_id', '<>', $event->public_pilot_id)->sharedLock()->first()) {
            throw new DomainException('discord_link_changed');
        }

        [$relation, $column] = $this->ratingRelation($user, $settings);
        $qualified = $this->findRating($column, $mapping['qualified']);
        if (DB::table('typerating_user')->where([
            'user_id' => $user->id, 'typerating_id' => $qualified->id,
        ])->lockForUpdate()->first()) {
            $this->recordTrainee($eventId, 'superseded', 'native_already_qualified', (string) $qualified->id);
            return;
        }
        $rating = $this->findRating($column, $mapping['trainee']);
        if (!$rating->active) {
            throw new DomainException('trainee_rating_inactive');
        }
        $identity = ['user_id' => $user->id, 'typerating_id' => $rating->id];
        $marker = hash('sha256', 'vuscg-enrollment-v1:'.$user->id.':'.$event->program_id);
        $result = $this->syncAssociation('typerating_user', $identity, $marker, true,
            fn () => $relation->attach($rating->id, ['vuscg_qualification_owner' => $marker]));
        if (!DB::table('typerating_user')->where($identity)->exists()) {
            throw new DomainException('trainee_rating_not_persisted');
        }
        $this->recordTrainee($eventId, 'complete', $result, (string) $rating->id);
    }

    private function syncAssociation(string $table, array $identity, string $marker, bool $active, callable $insert): string
    {
        $existing = DB::table($table)->where($identity)->lockForUpdate()->get();
        $ownedRow = DB::table($table)->where('vuscg_qualification_owner', $marker)->lockForUpdate()->first();
        $owned = $existing->contains(fn ($row) => $row->vuscg_qualification_owner === $marker);
        if ($ownedRow && !$owned) {
            throw new DomainException('owned_association_mapping_changed');
        }
        $operation = Plan::operation($active, $existing->isNotEmpty(), $owned);
        if ($operation === 'inserted') {
            $insert();
        } elseif ($operation === 'removed_managed') {
            DB::table($table)->where($identity)->where('vuscg_qualification_owner', $marker)->delete();
        }
        return $operation;
    }
}
