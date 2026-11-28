<?php

namespace Modules\VuscgCustom\Services;

use DomainException;

final class TraineeRatingPlan
{
    public static function enabled(array $settings): bool
    {
        return ($settings['trainee_rating_enabled'] ?? false) === true;
    }

    public static function mapping(string $program): array
    {
        if (!in_array($program, ['rw', 'fw'], true)) {
            throw new DomainException('unsupported_trainee_program');
        }

        return QualificationNativePlan::ratings((object) ['qualification_id' => 'mr', 'program_id' => $program]);
    }

    public static function hold(bool $active, bool $current, bool $missionRated): ?string
    {
        if (!$active || !$current) {
            return 'enrollment_changed';
        }
        return $missionRated ? 'authoritative_mission_rated' : null;
    }
}
