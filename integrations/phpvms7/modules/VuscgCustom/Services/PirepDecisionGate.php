<?php

namespace Modules\VuscgCustom\Services;

final class PirepDecisionGate
{
    public static function allows(string $environment, mixed $enabled): bool
    {
        return $enabled === true && in_array($environment, ['testing', 'staging'], true);
    }
}
