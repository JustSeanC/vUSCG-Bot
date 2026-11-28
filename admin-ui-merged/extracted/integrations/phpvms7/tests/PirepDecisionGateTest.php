<?php

use Modules\VuscgCustom\Services\PirepDecisionGate as Gate;

require dirname(__DIR__).'/modules/VuscgCustom/Services/PirepDecisionGate.php';

foreach ([
    [true, 'production', 1, false],
    [true, 'local', 1, false],
    [true, 'staging', 1, true],
    [true, 'testing', 1, true],
    [true, 'staging', null, false],
    [true, 'staging', 2, false],
    ['true', 'staging', 1, false],
    [false, 'staging', 1, false],
    [null, 'testing', 1, false],
] as [$flag, $environment, $protocol, $expected]) {
    if (Gate::allows($environment, $flag, $protocol) !== $expected) {
        throw new RuntimeException('PIREP decision gate regression.');
    }
}

echo "PIREP decisions remain blocked in production, with explicit activation in staging/testing only.\n";
