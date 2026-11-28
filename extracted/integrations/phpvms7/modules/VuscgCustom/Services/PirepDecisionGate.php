<?php

namespace Modules\VuscgCustom\Services;

final class PirepDecisionGate
{
    public static function allows(string $environment, mixed $enabled, mixed $protocol): bool
    {
        return $protocol === 1 && $enabled === true && in_array($environment, ['testing', 'staging'], true);
    }
}
