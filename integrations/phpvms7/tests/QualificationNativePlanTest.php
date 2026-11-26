<?php

use Modules\VuscgCustom\Services\QualificationNativePlan as Plan;

require dirname(__DIR__).'/modules/VuscgCustom/Services/QualificationNativePlan.php';

function same(mixed $actual, mixed $expected): void
{
    if ($actual !== $expected) {
        throw new RuntimeException('Unexpected native qualification plan.');
    }
}

function rejects(callable $call, string $reason): void
{
    try {
        $call();
    } catch (DomainException $error) {
        same($error->getMessage(), $reason);
        return;
    }
    throw new RuntimeException('Expected a rejected native qualification plan.');
}

$event = (object) ['action' => 'grant', 'qualification_id' => 'mr', 'reviewer_role' => 'instructor_pilot',
    'reviewer_discord_id' => '123456789012345678', 'user_id' => '16'];
$settings = ['awards' => '{"mr":{"id":11,"name":"Configured MR"},"ip":{"id":12,"name":"Configured IP"}}',
    'ip_role_id' => '15', 'ip_role_name' => 'Configured role', 'ip_enabled' => false];
same(Plan::target($event, 'award', $settings), ['id' => '11', 'name' => 'Configured MR']);
rejects(fn () => Plan::target($event, 'ip_role', $settings), 'unauthorized_ip_role');
$event->qualification_id = 'ip';
rejects(fn () => Plan::target($event, 'award', $settings), 'unauthorized_event');
$event->reviewer_role = 'command_staff';
rejects(fn () => Plan::target($event, 'ip_role', $settings), 'ip_role_disabled');
$settings['ip_enabled'] = true;
same(Plan::target($event, 'ip_role', $settings), ['id' => '15', 'name' => 'Configured role']);
$event->action = 'revoke';
same(Plan::target($event, 'ip_role', $settings), ['id' => '15', 'name' => 'Configured role']);
$event->reviewer_role = 'instructor_pilot';
rejects(fn () => Plan::target($event, 'ip_role', $settings), 'unauthorized_event');
same(Plan::operation(true, false, false), 'inserted');
same(Plan::operation(true, true, false), 'preserved_existing');
same(Plan::operation(true, true, true), 'already_managed');
same(Plan::operation(false, true, false), 'preserved_existing');
same(Plan::operation(false, true, true), 'removed_managed');
same(Plan::operation(false, false, false), 'already_absent');
same(strlen(Plan::marker($event, 'ip_role')), 64);
if (Plan::marker($event, 'ip_role') === Plan::marker($event, 'award')) {
    throw new RuntimeException('Distinct synchronization targets must have distinct ownership markers.');
}

$event->reviewer_role = 'instructor_pilot';
$event->action = 'grant';
$event->qualification_id = 'mr';
$event->program_id = 'rw';
rejects(fn () => Plan::target($event, 'type_rating', $settings), 'type_rating_disabled');
$settings['rating_enabled'] = true;
same(Plan::target($event, 'type_rating', $settings), ['qualified' => 'HELI_USCG', 'trainee' => 'TRNHELI']);
$rwMarker = Plan::marker($event, 'type_rating');
$awardMarker = Plan::marker($event, 'award');
$event->program_id = 'fw';
same(Plan::target($event, 'type_rating', $settings), ['qualified' => 'FW_CG', 'trainee' => 'FWTRN']);
same(Plan::marker($event, 'award'), $awardMarker);
same(Plan::marker($event, 'type_rating') === $rwMarker, false);
$event->program_id = 'unknown';
rejects(fn () => Plan::target($event, 'type_rating', $settings), 'invalid_mr_scope');
$event->program_id = '';
$event->qualification_id = 'blackjack';
same(Plan::target($event, 'type_rating', $settings), ['qualified' => 'INTAPP', 'trainee' => null]);
$settings['awards'] = '{"blackjack":{"id":9,"name":"Wrong configured award"},"hitron":{"id":7,"name":"Native HITRON"}}';
rejects(fn () => Plan::target($event, 'award', $settings), 'verified_award_id_mismatch');
$event->qualification_id = 'hitron';
same(Plan::target($event, 'award', $settings), ['id' => '7', 'name' => 'Native HITRON']);
rejects(fn () => Plan::target($event, 'type_rating', $settings), 'unmapped_type_rating');
$event->qualification_id = 'mq9';
same(Plan::target($event, 'type_rating', $settings), ['qualified' => 'UAV', 'trainee' => null]);

echo "Native qualification mapping, ownership, and IP restrictions passed.\n";
