<?php

namespace Tests\Feature;

use App\Events\PirepAccepted;
use App\Events\ProcessAward;
use App\Events\UserStatsChanged;
use App\Models\Pirep;
use App\Services\PirepService;
use Illuminate\Support\Facades\Event;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class PirepReviewBridgeTest extends TestCase
{
    private string $secret;
    private string $missingId;

    protected function setUp(): void
    {
        parent::setUp();
        if (!app()->environment('testing')) {
            $this->markTestSkipped('Requires an isolated phpVMS testing environment.');
        }
        $this->secret = bin2hex(random_bytes(32));
        $this->missingId = bin2hex(random_bytes(16));
        config(['vuscg_pirep_review.secret' => $this->secret, 'vuscg_pirep_review.decisions_enabled' => false]);
    }

    public function test_rejects_wrong_signature_expired_timestamp_and_replay(): void
    {
        $payload = ['pirep_id' => $this->missingId];
        $this->send('status', $payload, key: bin2hex(random_bytes(32)))->assertUnauthorized();
        $this->send('status', $payload, timestamp: time() - 61)->assertUnauthorized();

        $nonce = bin2hex(random_bytes(16));
        $this->send('status', $payload, nonce: $nonce)->assertNotFound()->assertJsonPath('code', 'not_found');
        $this->send('status', $payload, nonce: $nonce)->assertUnauthorized()->assertJsonPath('code', 'replay');
    }

    public function test_invalid_input_and_disabled_decisions_do_not_call_native_service(): void
    {
        $this->mock(PirepService::class)->shouldNotReceive('changeState');
        $payload = [
            'pirep_id' => $this->missingId,
            'action' => 'approve',
            'reviewer' => ['discord_id' => '123456789012345678', 'pilot_number' => null],
        ];
        $this->send('decision', array_replace($payload, ['action' => 'delete']))->assertUnprocessable();
        $this->send('decision', array_replace($payload, ['pirep_id' => 123]))->assertUnprocessable();
        $this->send('decision', $payload)->assertStatus(503)->assertJsonPath('code', 'disabled');
    }

    public function test_pending_fixtures_call_native_service_once_per_decision(): void
    {
        $id = getenv('PIREP_BRIDGE_TEST_PENDING_ID');
        if (!$id) {
            $this->markTestSkipped('Requires a disposable pending PIREP fixture with a pilot and aircraft.');
        }

        $connection = (new Pirep())->getConnection();
        $connection->beginTransaction();
        try {
            config(['vuscg_pirep_review.decisions_enabled' => true]);
            $pirep = Pirep::query()->findOrFail($id);
            $this->assertSame(1, $pirep->state);
            $service = $this->mock(PirepService::class);
            foreach (['approve' => 2, 'reject' => 6] as $action => $state) {
                $pirep->state = 1;
                $pirep->save();
                $service->shouldReceive('changeState')->once()->withArgs(
                    fn (Pirep $report, int $target) => $report->getKey() === $id && $report->state === 1 && $target === $state
                )->andReturnUsing(function (Pirep $report, int $target) {
                    $report->state = $target;
                    $report->save();
                    return $report;
                });
                $payload = [
                    'pirep_id' => $id,
                    'action' => $action,
                    'reviewer' => ['discord_id' => '123456789012345678', 'pilot_number' => 'C121'],
                ];
                $this->send('decision', $payload)->assertOk()->assertJsonPath('state', $state);
                $this->send('decision', $payload)->assertStatus(409)->assertJsonPath('state', $state);
                $this->send('status', ['pirep_id' => $id])->assertOk()->assertJsonPath('state', $state);
            }
        } finally {
            $connection->rollBack();
        }
    }

    public function test_real_bridge_credits_only_the_first_acceptance(): void
    {
        $id = getenv('PIREP_BRIDGE_TEST_NATIVE_PENDING_ID');
        if (!$id) {
            $this->markTestSkipped('Requires an isolated native-accounting PIREP fixture.');
        }

        Event::fake([PirepAccepted::class, ProcessAward::class, UserStatsChanged::class]);
        $connection = (new Pirep())->getConnection();
        $connection->beginTransaction();
        try {
            config(['vuscg_pirep_review.decisions_enabled' => true]);
            $pirep = Pirep::query()->findOrFail($id);
            $this->assertSame(1, $pirep->state);
            $minutes = (int) $pirep->flight_time;
            $this->assertGreaterThan(0, $minutes);
            $pilot = $pirep->user;
            $aircraft = $pirep->aircraft;
            $pilotMinutes = (int) $pilot->flight_time;
            $aircraftMinutes = (int) $aircraft->flight_time;
            $payload = [
                'pirep_id' => $id,
                'action' => 'approve',
                'reviewer' => ['discord_id' => '123456789012345678', 'pilot_number' => 'C121'],
            ];

            $this->send('decision', $payload)->assertOk()->assertJsonPath('state', 2);
            $this->send('decision', $payload)->assertStatus(409)->assertJsonPath('state', 2);
            $this->send('status', ['pirep_id' => $id])->assertOk()->assertJsonPath('state', 2);

            $this->assertSame($pilotMinutes + $minutes, (int) $pilot->fresh()->flight_time);
            $this->assertSame($aircraftMinutes + $minutes, (int) $aircraft->fresh()->flight_time);
            Event::assertDispatchedTimes(PirepAccepted::class, 1);
            Event::assertDispatchedTimes(ProcessAward::class, 1);
        } finally {
            $connection->rollBack();
        }
    }

    private function send(
        string $operation,
        array $payload,
        ?int $timestamp = null,
        ?string $nonce = null,
        ?string $key = null
    ): TestResponse {
        $path = '/api/vuscgcustom/pirep-review/'.$operation;
        $body = json_encode($payload, JSON_THROW_ON_ERROR);
        $timestamp ??= time();
        $nonce ??= bin2hex(random_bytes(16));
        $signature = hash_hmac('sha256', implode("\n", ['POST', $path, $timestamp, $nonce, $body]), $key ?? $this->secret);

        return $this->call('POST', $path, [], [], [], [
            'HTTPS' => 'on',
            'HTTP_ACCEPT' => 'application/json',
            'CONTENT_TYPE' => 'application/json',
            'HTTP_X_VUSCG_TIMESTAMP' => (string) $timestamp,
            'HTTP_X_VUSCG_NONCE' => $nonce,
            'HTTP_X_VUSCG_SIGNATURE' => $signature,
        ], $body);
    }
}
