<?php

namespace Tests\Feature;

use App\Events\AwardAwarded;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;
use Tests\TestCase;

final class QualificationNativeSyncFeatureTest extends TestCase
{
    private User $pilot;

    protected function setUp(): void
    {
        parent::setUp();
        $id = getenv('VUSCG_QUAL_TEST_PILOT_PUBLIC_ID');
        if (!app()->environment('testing') || !$id) {
            $this->markTestSkipped('Requires a dedicated isolated phpVMS qualification fixture.');
        }
        $this->pilot = User::query()->where('pilot_id', $id)->firstOrFail();
        config(['vuscg_qualifications.enabled' => true]);
    }

    public function test_native_award_fires_normal_event_once_and_preserves_manual_replacements(): void
    {
        $mapping = json_decode(config('vuscg_qualifications.awards'), true, 8, JSON_THROW_ON_ERROR);
        $award = $mapping['dlq']['id'];
        $pivot = fn () => DB::table('user_awards')->where(['user_id' => $this->pilot->id, 'award_id' => $award]);
        Event::fake([AwardAwarded::class]);
        DB::beginTransaction();
        try {
            $this->assertFalse($pivot()->exists(), 'Use a new staging pilot without this native award.');
            $grant = $this->event('dlq', 'grant', 'award');
            $this->sync($grant);
            $this->sync($grant);
            $this->assertSame(1, $pivot()->count());
            $this->assertNotEmpty($pivot()->value('vuscg_qualification_owner'));
            Event::assertDispatchedTimes(AwardAwarded::class, 1);
            // Model an explicit external removal followed by a manual replacement.
            $pivot()->delete();
            DB::table('user_awards')->insert(['user_id' => $this->pilot->id, 'award_id' => $award]);
            $this->sync($this->event('dlq', 'revoke', 'award'));
            $this->assertSame(1, $pivot()->count());
            $this->assertNull($pivot()->value('vuscg_qualification_owner'));
        } finally {
            DB::rollBack();
        }
    }

    public function test_ip_role_requires_enabled_mapping_and_removes_only_owned_role(): void
    {
        $roles = $this->pilot->roles();
        $id = config('vuscg_qualifications.ip_role_id');
        $pivot = fn () => DB::table('role_user')->where([
            'user_id' => $this->pilot->id, 'role_id' => $id, $roles->getMorphType() => $roles->getMorphClass(),
        ]);
        DB::beginTransaction();
        try {
            $this->assertFalse($pivot()->exists(), 'Use a new staging pilot without this native role.');
            config(['vuscg_qualifications.ip_enabled' => false]);
            $grant = $this->event('ip', 'grant', 'ip_role');
            $this->sync($grant);
            $this->assertFalse($pivot()->exists());
            config(['vuscg_qualifications.ip_enabled' => true]);
            DB::table('vuscg_training_qualification_sync')->where('event_id', $grant)->update([
                'next_attempt_at' => DB::raw('UTC_TIMESTAMP()'),
            ]);
            $this->sync($grant);
            $this->assertSame(1, $pivot()->count());
            $this->assertNotEmpty($pivot()->value('vuscg_qualification_owner'));
            $this->sync($this->event('ip', 'revoke', 'ip_role'));
            $this->assertFalse($pivot()->exists());
        } finally {
            DB::rollBack();
        }
    }

    private function sync(string $id): void
    {
        $this->artisan('vuscg:sync-qualifications', ['--event' => $id])->assertExitCode(0);
    }

    private function event(string $qualification, string $action, string $target): string
    {
        $id = (string) Str::uuid();
        $identity = ['user_id' => $this->pilot->id, 'qualification_id' => $qualification, 'program_id' => ''];
        DB::table('vuscg_training_qualification_events')->insert($identity + [
            'event_id' => $id, 'public_pilot_id' => $this->pilot->pilot_id, 'action' => $action,
            'effective_date' => DB::raw('UTC_DATE()'), 'reviewer_user_id' => $this->pilot->id,
            'reviewer_pilot_id' => $this->pilot->pilot_id, 'reviewer_discord_id' => '123456789012345678',
            'reviewer_role' => 'command_staff', 'reason' => 'Automated staging fixture',
            'created_at' => DB::raw('UTC_TIMESTAMP()'), 'interaction_id' => (string) random_int(100000000000000000, 999999999999999999),
        ]);
        DB::table('vuscg_training_qualification_status')->updateOrInsert($identity, [
            'active' => $action === 'grant', 'last_event_id' => $id,
        ]);
        DB::table('vuscg_training_qualification_sync')->insert([
            'event_id' => $id, 'target' => $target, 'next_attempt_at' => DB::raw('UTC_TIMESTAMP()'),
        ]);
        return $id;
    }
}
