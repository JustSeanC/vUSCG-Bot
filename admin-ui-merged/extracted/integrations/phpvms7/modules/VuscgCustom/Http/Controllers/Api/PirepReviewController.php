<?php

namespace Modules\VuscgCustom\Http\Controllers\Api;

use App\Models\Enums\PirepState;
use App\Models\Pirep;
use App\Services\PirepService;
use Illuminate\Database\QueryException;
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

        // A separate reviewed release is required before production may ever write.
        $protocol = PirepService::class.'::VUSCG_REVIEW_PROTOCOL';
        if (!PirepDecisionGate::allows(app()->environment(), config('vuscg_pirep_review.decisions_enabled'),
            defined($protocol) ? constant($protocol) : null)) {
            return $this->result('disabled', $id, null, 503);
        }

        $target = $action === 'approve' ? PirepState::ACCEPTED : PirepState::REJECTED;
        try {
            // No revision means pending-only. The native service owns all accounting locks.
            [$pirep, $changed] = app(PirepService::class)->review($id, $target);
        } catch (QueryException $error) {
            if (!in_array((int) ($error->errorInfo[1] ?? 0), [1205, 1213], true)) {
                throw $error;
            }
            return $this->result('busy', $id, null, 503);
        }
        if (!$pirep) {
            return $this->result('not_found', $id, null, 404);
        }
        $state = $pirep->state;
        if (!$changed && $state === PirepState::PENDING) {
            return $this->result('busy', $id, null, 503);
        }
        if ($changed && $state !== $target) {
            throw new \RuntimeException('Native PIREP service returned an unexpected state.');
        }
        [$code, $status] = $changed ? ['changed', 200] : ['not_pending', 409];

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
