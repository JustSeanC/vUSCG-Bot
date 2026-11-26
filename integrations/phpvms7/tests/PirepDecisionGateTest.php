<?php

use Modules\VuscgCustom\Services\PirepDecisionGate as Gate;

require dirname(__DIR__).'/modules/VuscgCustom/Services/PirepDecisionGate.php';

foreach ([
    [true, 'production', false],
    [true, 'local', false],
    [true, 'staging', true],
    [true, 'testing', true],
    ['true', 'staging', false],
    [false, 'staging', false],
    [null, 'testing', false],
] as [$flag, $environment, $expected]) {
    if (Gate::allows($environment, $flag) !== $expected) {
        throw new RuntimeException('PIREP decision gate regression.');
    }
}

echo "PIREP decisions remain blocked in production, with explicit activation in staging/testing only.\n";
