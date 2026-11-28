<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\TestCase;

final class TraineeRatingSyncFeatureTest extends TestCase
{
    public function test_tracks_and_stale_jobs_on_a_dedicated_native_fixture(): void
    {
        $publicId = getenv('VUSCG_TRAINEE_TEST_PILOT_PUBLIC_ID');
        if (!app()->environment('testing') || !$publicId) {
            $this->markTestSkipped('Requires an isolated phpVMS pilot and verified native type ratings.');
        }
        $pilot = User::query()->where('pilot_id', $publicId)->firstOrFail();
        $discord = DB::table('discord_links')->where('pilot_id', $publicId)->pluck('discord_id')->sole();
        $column = config('vuscg_qualifications.rating_code_column');
        $this->assertContains($column, ['name', 'type', 'code']);
        $ids = DB::table('typeratings')->whereIn($column, ['FWTRN', 'FW_CG', 'TRNHELI', 'HELI_USCG'])->pluck('id', $column);
        $this->assertCount(4, $ids);

        DB::beginTransaction();
        try {
            $this->assertFalse(DB::table('typerating_user')->where('user_id', $pilot->id)->whereIn('typerating_id', $ids->values())->exists());
            $this->assertFalse(DB::table('vuscg_training_enrollments')->where('user_id', $pilot->id)->exists());
            config(['vuscg_qualifications.enabled' => false, 'vuscg_qualifications.trainee_rating_enabled' => false]);

            $fw = $this->queue($pilot, $discord, 'fw');
            $this->sync($fw);
            $this->assertDatabaseHas('vuscg_training_instruction_delivery', ['event_id' => $fw, 'state' => 'pending']);
            $this->assertDatabaseMissing('typerating_user', ['user_id' => $pilot->id, 'typerating_id' => $ids['FWTRN']]);

            config(['vuscg_qualifications.trainee_rating_enabled' => true]);
            $this->sync($fw);
            $this->sync($fw);
            $rw = $this->queue($pilot, $discord, 'rw');
            $this->sync($rw);
            foreach (['FWTRN', 'TRNHELI'] as $code) {
                $this->assertSame(1, DB::table('typerating_user')->where(['user_id' => $pilot->id, 'typerating_id' => $ids[$code]])->count());
            }

            // Simulate an existing manually assigned qualification as found by the native worker.
            DB::table('typerating_user')->insert(['user_id' => $pilot->id, 'typerating_id' => $ids['HELI_USCG']]);
            DB::table('typerating_user')->where(['user_id' => $pilot->id, 'typerating_id' => $ids['TRNHELI']])->delete();
            $native = $this->queue($pilot, $discord, 'rw', 'resume');
            $this->sync($native);
            $this->assertDatabaseHas('vuscg_training_instruction_delivery', [
                'event_id' => $native, 'state' => 'superseded', 'result' => 'native_already_qualified',
            ]);

            // The ledger can lead native delivery. A pending MR state supersedes the trainee job.
            $pending = $this->queue($pilot, $discord, 'fw', 'resume');
            DB::table('typerating_user')->where(['user_id' => $pilot->id, 'typerating_id' => $ids['FWTRN']])->delete();
            $this->grantMr($pilot, $discord, 'fw');
            $this->sync($pending);
            $this->assertDatabaseHas('vuscg_training_instruction_delivery', [
                'event_id' => $pending, 'state' => 'superseded', 'result' => 'authoritative_mission_rated',
            ]);
            $this->assertDatabaseMissing('typerating_user', ['user_id' => $pilot->id, 'typerating_id' => $ids['FWTRN']]);

            // Remove only the test fixture association and make the corresponding trainee code unavailable.
            DB::table('typerating_user')->where(['user_id' => $pilot->id, 'typerating_id' => $ids['HELI_USCG']])->delete();
            DB::table('typeratings')->where('id', $ids['TRNHELI'])->update([$column => 'P06_MISSING']);
            $retry = $this->queue($pilot, $discord, 'rw', 'resume');
            $this->sync($retry);
            $this->assertDatabaseHas('vuscg_training_instruction_delivery', [
                'event_id' => $retry, 'state' => 'retry', 'result' => 'rating_code_missing_or_ambiguous',
            ]);
            DB::table('typeratings')->where('id', $ids['TRNHELI'])->update([$column => 'TRNHELI']);
            DB::table('vuscg_training_instruction_delivery')->where('event_id', $retry)->update(['next_attempt_at' => DB::raw('UTC_TIMESTAMP(6)')]);
            $this->sync($retry);
            $this->assertDatabaseHas('typerating_user', ['user_id' => $pilot->id, 'typerating_id' => $ids['TRNHELI']]);
        } finally {
            DB::rollBack();
        }
    }

    private function sync(string $id): void
    {
        $this->artisan('vuscg:sync-qualifications', ['--event' => $id])->assertExitCode(0);
    }

    private function queue(User $pilot, string $discord, string $track, string $kind = 'start'): string
    {
        $identity = ['user_id' => $pilot->id, 'program_id' => $track];
        DB::table('vuscg_training_enrollments')->updateOrInsert($identity, [
            'active' => true, 'created_at' => DB::raw('UTC_TIMESTAMP(6)'), 'updated_at' => DB::raw('UTC_TIMESTAMP(6)'),
            'created_by_discord_id' => $discord, 'updated_by_discord_id' => $discord,
            'created_by_pilot_id' => $pilot->pilot_id, 'updated_by_pilot_id' => $pilot->pilot_id,
        ]);
        $id = (string) Str::uuid();
        DB::table('vuscg_training_instruction_events')->insert($identity + [
            'event_id' => $id, 'interaction_id' => (string) random_int(100000000000000000, 999999999999999999),
            'kind' => $kind, 'public_pilot_id' => $pilot->pilot_id, 'guild_id' => '123456789012345678',
            'trainee_discord_id' => $discord, 'actor_discord_id' => $discord, 'actor_pilot_id' => $pilot->pilot_id,
            'label' => $track, 'note' => '', 'resources' => '[]', 'intent_hash' => str_repeat('a', 64),
            'created_at' => DB::raw('UTC_TIMESTAMP(6)'),
        ]);
        DB::table('vuscg_training_instruction_delivery')->insert([
            'event_id' => $id, 'target' => 'trainee_rating', 'next_attempt_at' => DB::raw('UTC_TIMESTAMP(6)'),
        ]);
        return $id;
    }

    private function grantMr(User $pilot, string $discord, string $track): void
    {
        $id = (string) Str::uuid();
        $identity = ['user_id' => $pilot->id, 'program_id' => $track, 'qualification_id' => 'mr'];
        DB::table('vuscg_training_qualification_events')->insert($identity + [
            'event_id' => $id, 'public_pilot_id' => $pilot->pilot_id, 'action' => 'grant', 'effective_date' => DB::raw('UTC_DATE()'),
            'reviewer_user_id' => $pilot->id, 'reviewer_pilot_id' => $pilot->pilot_id,
            'reviewer_discord_id' => $discord, 'reviewer_role' => 'command_staff',
            'reason' => 'Isolated native fixture', 'created_at' => DB::raw('UTC_TIMESTAMP(6)'),
            'interaction_id' => (string) random_int(100000000000000000, 999999999999999999),
        ]);
        DB::table('vuscg_training_qualification_status')->insert($identity + ['active' => true, 'last_event_id' => $id]);
    }
}
