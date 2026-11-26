<?php

namespace Modules\VuscgCustom\Http\Controllers\Api;

use App\Models\Enums\PirepState;
use App\Models\Pirep;
use App\Services\PirepService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use JsonException;
use Modules\VuscgCustom\Services\PirepDecisionGate;

class PirepReviewController
{
    private const CLOCK_WINDOW = 60;

    public function status(Request $request): JsonResponse
    {
        return $this->handle($request, false);
    }

    public function decision(Request $request): JsonResponse
    {
        return $this->handle($request, true);
    }

    private function handle(Request $request, bool $decision): JsonResponse
    {
        if (!$request->isSecure() || $request->getQueryString() !== null) {
            return response()->json(['code' => 'unauthorized'], 401);
        }
        $body = $request->getContent();
        if (strlen($body) > 1024) {
            return response()->json(['code' => 'too_large'], 413);
        }

        $timestamp = $request->header('X-VUSCG-Timestamp', '');
        $nonce = $request->header('X-VUSCG-Nonce', '');
        $signature = $request->header('X-VUSCG-Signature', '');
        $secret = config('vuscg_pirep_review.secret');
        $now = time();
        if (!is_string($secret) || !preg_match('/\A[a-f0-9]{64}\z/', $secret)
            || !preg_match('/\A[0-9]{10}\z/', $timestamp)
            || abs($now - (int) $timestamp) > self::CLOCK_WINDOW
            || !preg_match('/\A[a-f0-9]{32}\z/', $nonce)
            || !preg_match('/\A[a-f0-9]{64}\z/', $signature)) {
            return response()->json(['code' => 'unauthorized'], 401);
        }

        $signed = implode("\n", [$request->method(), $request->getBaseUrl().$request->getPathInfo(),
            $timestamp, $nonce, $body]);
        if (!hash_equals(hash_hmac('sha256', $signed, $secret), $signature)) {
            return response()->json(['code' => 'unauthorized'], 401);
        }

        $connection = (new Pirep())->getConnection();
        $reserved = $connection->table('vuscg_pirep_review_nonces')->insertOrIgnore([
            'nonce' => $nonce,
            'expires_at' => (int) $timestamp + self::CLOCK_WINDOW,
        ]);
        if ($reserved !== 1) {
            return response()->json(['code' => 'replay'], 401);
        }

        try {
            $payload = json_decode($body, true, 8, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            return response()->json(['code' => 'invalid'], 422);
        }

        $id = $payload['pirep_id'] ?? null;
        if (!is_string($id) || !preg_match('/\A[A-Za-z0-9_-]{1,64}\z/', $id)) {
            return response()->json(['code' => 'invalid'], 422);
        }

        if (!$decision) {
            if (count($payload) !== 1) {
                return $this->result('invalid', $id, null, 422);
            }
            $pirep = Pirep::query()->useWritePdo()->whereKey($id)->first();
            if (!$pirep || $pirep->getKey() !== $id) {
                return $this->result('not_found', $id, null, 404);
            }
            return is_int($pirep->state)
                ? $this->result('status', $id, $pirep->state)
                : $this->result('disabled', $id, null, 503);
        }

        $action = $payload['action'] ?? null;
        $reviewer = $payload['reviewer'] ?? null;
        $discordId = $reviewer['discord_id'] ?? null;
        $pilotNumber = $reviewer['pilot_number'] ?? null;
        if (count($payload) !== 3 || !in_array($action, ['approve', 'reject'], true)
            || !is_array($reviewer) || count($reviewer) !== 2 || !array_key_exists('pilot_number', $reviewer)
            || !is_string($discordId) || !preg_match('/\A[0-9]{17,20}\z/', $discordId)
            || ($pilotNumber !== null && (!is_string($pilotNumber) || !preg_match('/\AC[0-9]{1,15}\z/', $pilotNumber)))) {
            return $this->result('invalid', $id, null, 422);
        }

        // The deployed native writers have not been verified to share the bridge lock.
        // Production writes require a future reviewed change after the writer audit.
        if (!PirepDecisionGate::allows(app()->environment(), config('vuscg_pirep_review.decisions_enabled'))) {
            return $this->result('disabled', $id, null, 503);
        }

        if (!is_int(PirepState::PENDING)) {
            return $this->result('disabled', $id, null, 503);
        }
        $target = $action === 'approve' ? PirepState::ACCEPTED : PirepState::REJECTED;
        [$code, $state, $status] = $connection->transaction(function () use ($id, $target) {
            $pirep = Pirep::query()->whereKey($id)->lockForUpdate()->first();
            if (!$pirep || $pirep->getKey() !== $id) {
                return ['not_found', null, 404];
            }

            if ($pirep->state !== PirepState::PENDING) {
                return ['not_pending', (int) $pirep->state, 409];
            }

            // Serialize bridge updates that share a pilot or aircraft as well.
            $pilot = $pirep->user();
            $aircraft = $pirep->aircraft();
            if ($pilot->getRelated()->getConnection() !== $pirep->getConnection()
                || $aircraft->getRelated()->getConnection() !== $pirep->getConnection()) {
                throw new \RuntimeException('Native PIREP accounting models must share the primary connection.');
            }
            $pilot->lockForUpdate()->firstOrFail();
            $aircraft->lockForUpdate()->firstOrFail();

            app(PirepService::class)->changeState($pirep, $target);
            $actual = $pirep->refresh()->state;
            if ($actual !== $target) {
                throw new \RuntimeException('Native PIREP processing did not persist the requested state.');
            }

            return ['changed', $actual, 200];
        });

        if ($code === 'changed') {
            Log::info('vUSCG PIREP review committed', [
                'pirep_id' => $id, 'state' => $state, 'discord_id' => $discordId, 'pilot_number' => $pilotNumber,
            ]);
        }
        return $this->result($code, $id, $state, $status);
    }

    private function result(string $code, string $id, ?int $state, int $status = 200): JsonResponse
    {
        return response()->json(['code' => $code, 'pirep_id' => $id, 'state' => $state], $status);
    }
}
