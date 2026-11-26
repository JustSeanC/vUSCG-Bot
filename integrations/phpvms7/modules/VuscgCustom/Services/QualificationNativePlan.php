<?php

namespace Modules\VuscgCustom\Services;

use DomainException;
use JsonException;
use stdClass;

final class QualificationNativePlan
{
    public static function target(stdClass $event, string $target, array $settings): array
    {
        $validAction = in_array($event->action, ['grant', 'revoke'], true);
        $allowed = $event->reviewer_role === 'command_staff' ||
            ($event->reviewer_role === 'instructor_pilot' && $event->action === 'grant'
                && in_array($event->qualification_id, ['mr', 'dlq', 'hitron', 'blackjack', 'mq9'], true));
        if (!$validAction || !$allowed || !$event->reviewer_discord_id) {
            throw new DomainException('unauthorized_event');
        }

        if ($target === 'ip_role') {
            if ($event->qualification_id !== 'ip' || $event->reviewer_role !== 'command_staff') {
                throw new DomainException('unauthorized_ip_role');
            }
            if (($settings['ip_enabled'] ?? false) !== true) {
                throw new DomainException('ip_role_disabled');
            }

            return self::mapping([
                'id' => $settings['ip_role_id'] ?? null,
                'name' => $settings['ip_role_name'] ?? null,
            ]);
        }
        if ($target === 'type_rating') {
            if (($settings['rating_enabled'] ?? false) !== true) {
                throw new DomainException('type_rating_disabled');
            }
            return self::ratings($event);
        }
        if ($target !== 'award') {
            throw new DomainException('invalid_target');
        }

        try {
            $awards = json_decode($settings['awards'] ?? '{}', true, 8, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new DomainException('invalid_award_config');
        }
        if (!is_array($awards)) {
            throw new DomainException('invalid_award_config');
        }
        $nativeIds = [];
        foreach ($awards as $spec) {
            $map = self::mapping($spec);
            if (isset($nativeIds[$map['id']])) {
                throw new DomainException('nonunique_award_mapping');
            }
            $nativeIds[$map['id']] = true;
        }
        $mapped = self::mapping($awards[$event->qualification_id] ?? null);
        $fixed = ['hitron' => '7', 'blackjack' => '8'];
        if (isset($fixed[$event->qualification_id]) && $mapped['id'] !== $fixed[$event->qualification_id]) {
            throw new DomainException('verified_award_id_mismatch');
        }
        return $mapped;
    }

    public static function ratings(stdClass $event): array
    {
        return match ($event->qualification_id) {
            'mr' => match ($event->program_id) {
                'rw' => ['qualified' => 'HELI_USCG', 'trainee' => 'TRNHELI'],
                'fw' => ['qualified' => 'FW_CG', 'trainee' => 'FWTRN'],
                default => throw new DomainException('invalid_mr_scope'),
            },
            'blackjack' => ['qualified' => 'INTAPP', 'trainee' => null],
            'mq9' => ['qualified' => 'UAV', 'trainee' => null],
            default => throw new DomainException('unmapped_type_rating'),
        };
    }

    private static function mapping(mixed $spec): array
    {
        $id = is_array($spec) ? ($spec['id'] ?? null) : null;
        $name = is_array($spec) ? ($spec['name'] ?? null) : null;
        if ((!is_int($id) && !is_string($id)) || !preg_match('/\A[1-9][0-9]{0,14}\z/', (string) $id)
            || !is_string($name) || trim($name) === '') {
            throw new DomainException('missing_or_invalid_mapping');
        }
        return ['id' => (string) $id, 'name' => $name];
    }

    public static function marker(stdClass $event, string $target): string
    {
        $scope = $target === 'type_rating' ? ':'.$event->program_id : '';
        return hash('sha256', 'vuscg-qualification-v1:'.$event->user_id.':'.$event->qualification_id.':'.$target.$scope);
    }

    public static function operation(bool $active, bool $associationExists, bool $owned): string
    {
        if ($active) {
            return $owned ? 'already_managed' : ($associationExists ? 'preserved_existing' : 'inserted');
        }
        return $owned ? 'removed_managed' : ($associationExists ? 'preserved_existing' : 'already_absent');
    }
}
