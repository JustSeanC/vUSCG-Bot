<?php

use Modules\VuscgCustom\Services\TraineeRatingPlan as Plan;

require dirname(__DIR__).'/modules/VuscgCustom/Services/QualificationNativePlan.php';
require dirname(__DIR__).'/modules/VuscgCustom/Services/TraineeRatingPlan.php';

function expectSame(mixed $expected, mixed $actual): void
{
    if ($expected !== $actual) {
        throw new RuntimeException('Trainee rating policy changed unexpectedly.');
    }
}

expectSame(false, Plan::enabled([]));
expectSame(false, Plan::enabled(['trainee_rating_enabled' => 'true']));
expectSame(true, Plan::enabled(['trainee_rating_enabled' => true]));
expectSame(['qualified' => 'HELI_USCG', 'trainee' => 'TRNHELI'], Plan::mapping('rw'));
expectSame(['qualified' => 'FW_CG', 'trainee' => 'FWTRN'], Plan::mapping('fw'));
expectSame(null, Plan::hold(true, true, false));
expectSame('authoritative_mission_rated', Plan::hold(true, true, true));
expectSame('enrollment_changed', Plan::hold(false, true, false));
expectSame('enrollment_changed', Plan::hold(true, false, false));

try {
    Plan::mapping('mq9');
    throw new RuntimeException('Specialized enrollment must not assign a trainee rating.');
} catch (DomainException $error) {
    expectSame('unsupported_trainee_program', $error->getMessage());
}

echo "Trainee rating codes, disabled default and stale-state policy passed.\n";
