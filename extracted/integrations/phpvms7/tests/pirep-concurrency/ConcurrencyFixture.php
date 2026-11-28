<?php
// Runs the patched installed sources with real Illuminate transactions and independent MySQL sessions.
require getenv('PIREP_FIXTURE_AUTOLOAD');
require __DIR__.'/FixtureModels.php';

use App\Events\PirepAccepted;
use App\Events\PirepFiled;
use App\Events\PirepRejected;
use App\Events\ProcessAward;
use App\Listeners\AwardHandler;
use App\Listeners\FinanceEventHandler;
use App\Models\Aircraft;
use App\Models\Pirep;
use App\Models\User;
use App\Notifications\NotificationEventsHandler;
use App\Repositories\{AircraftRepository, AirportRepository, FlightRepository, PirepRepository};
use App\Services\Finance\PirepFinanceService;
use App\Services\{AirportService, FareService, GeoService, PirepAfterCommit, PirepService, SimBriefService, UserService};
use Illuminate\Config\Repository;
use Illuminate\Container\Container;
use Illuminate\Database\Connectors\ConnectionFactory;
use Illuminate\Database\DatabaseManager;
use Illuminate\Database\DatabaseTransactionsManager;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\QueryException;
use Illuminate\Events\Dispatcher;
use Illuminate\Support\Facades\{DB, Facade};
use Modules\DisposableBasic\Listeners\Gen_AutoReject;

$site = getenv('PIREP_FIXTURE_SITE');
foreach (['PirepAccepted', 'PirepRejected', 'PirepFiled', 'PirepCancelled', 'UserStatsChanged', 'ProcessAward'] as $event) {
    require $site.'/app/Events/'.$event.'.php';
}
foreach (['app/Services/PirepAfterCommit.php', 'app/Services/UserService.php', 'app/Services/PirepService.php',
    'app/Services/AircraftService.php', 'app/Listeners/FinanceEventHandler.php', 'app/Listeners/AwardHandler.php',
    'app/Notifications/NotificationEventsHandler.php', 'modules/DisposableBasic/Listeners/Gen_AutoReject.php'] as $source) {
    require $site.'/'.$source;
}

$app = new Container();
$app->instance('config', new Repository(['database' => ['default' => 'mysql', 'connections' => ['mysql' => [
    'driver' => 'mysql', 'host' => 'pirep-mysql', 'database' => 'vuscg_pirep_fixture',
    'username' => 'fixture', 'password' => 'local_fixture_only', 'strict' => true,
]]]]));
$events = new Dispatcher($app);
$app->instance('events', $events);
$app->instance('db.transactions', new DatabaseTransactionsManager());
$app->instance('log', new class {
    public function __call(string $name, array $arguments) { return null; }
});
$db = new DatabaseManager($app, new ConnectionFactory($app));
$app->instance('db', $db);
Facade::setFacadeApplication($app);
Model::setConnectionResolver($db);
Model::setEventDispatcher($events);

function app(string $class) { global $app; return $app->make($class); }
function config(string $key, mixed $default = null) { return app('config')->get($key, $default); }
function event(object $event): void { app('events')->dispatch($event); }
function setting(string $name, mixed $default = null): mixed {
    return in_array($name, ['notifications.mail_pirep_user_ack', 'notifications.mail_pirep_user_rej'], true);
}
function DB_Setting(string $name, mixed $default): mixed {
    return match ($name) {
        'dbasic.autoreject' => getenv('PIREP_FIXTURE_AUTOREJECT') === '1',
        'dbasic.ar_marginscore' => 50,
        default => $default,
    };
}
function expectSame($actual, $expected, string $label): void {
    if ($actual !== $expected) {
        throw new RuntimeException($label.' expected '.json_encode($expected).', got '.json_encode($actual));
    }
}

$userSvc = (new ReflectionClass(UserService::class))->newInstanceWithoutConstructor();
$service = new PirepService(new AirportRepository(), new AirportService(), new AircraftRepository(), new FareService(),
    new FlightRepository(), new GeoService(), new PirepRepository(), new SimBriefService(), $userSvc);
$notifications = new NotificationEventsHandler();
$finance = new FinanceEventHandler(new PirepFinanceService());
$award = new AwardHandler();
$autoReject = new Gen_AutoReject();
$failureStage = null;
$events->listen("eloquent.updated: ".User::class, static function () use (&$failureStage): void {
    if ($failureStage === 'pilot') throw new LogicException('fixture pilot');
});
$events->listen("eloquent.updated: ".Aircraft::class, static function () use (&$failureStage): void {
    if ($failureStage === 'aircraft') throw new LogicException('fixture aircraft');
});
$events->listen(PirepFiled::class, function ($e) use ($autoReject) {
    DB::table('fixture_events')->insert(['kind' => 'filed', 'pirep_id' => $e->pirep->id]);
    $autoReject->handle($e);
});
$events->listen(PirepAccepted::class, function ($e) use ($finance, $notifications, &$failureStage) {
    DB::table('fixture_events')->insert(['kind' => 'accepted', 'pirep_id' => $e->pirep->id]);
    $notifications->onPirepAccepted($e);
    $finance->onPirepAccept($e);
    if ($failureStage === 'finance') throw new LogicException('fixture finance');
});
$events->listen(PirepRejected::class, function ($e) use ($finance, $notifications) {
    DB::table('fixture_events')->insert(['kind' => 'rejected', 'pirep_id' => $e->pirep->id]);
    $finance->onPirepReject($e);
    $notifications->onPirepRejected($e);
});
$events->listen(ProcessAward::class, function ($e) use ($award, &$failureStage) {
    DB::table('fixture_events')->insert(['kind' => 'award', 'pirep_id' => $e->user->last_pirep_id]);
    $award->processAward($e);
    if ($failureStage === 'award') throw new LogicException('fixture award');
});
DB::statement('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');

function perform(PirepService $service, string $operation, string $id) {
    return match ($operation) {
        'native-approve', 'native-reject', 'timeout' => $service->review($id, $operation === 'native-reject' ? 6 : 2, 'legacy'),
        'bridge-approve', 'bridge-reject' => $service->review($id, $operation === 'bridge-reject' ? 6 : 2),
        'file' => [$service->fileAndSubmit($id, ['flight_time' => 45, 'source' => 1], [], [], static function (): void {}), true],
    };
}
if (($argv[1] ?? null) === 'worker') {
    [$script, $action, $operation, $id, $signal] = $argv;
    DB::statement('SET SESSION innodb_lock_wait_timeout = '.($operation === 'timeout' ? '1' : '8'));
    try {
        $result = DB::transaction(function () use ($service, $operation, $id, $signal) {
            // Establish an older read view before attempting the lock, as a native caller can.
            Pirep::query()->findOrFail($id);
            echo "ready\n";
            [$report, $changed] = perform($service, $operation, $id);
            if ($signal !== '-') {
                expectSame(DB::table('fixture_external')->count(), 0, 'No delivery while the enclosing transaction is open');
                echo "holding\n";
                $deadline = microtime(true) + 8;
                do {
                    clearstatcache(true, $signal);
                    if (is_file($signal)) {
                        break;
                    }
                    usleep(10_000);
                } while (microtime(true) < $deadline);
                if (!is_file($signal)) {
                    throw new RuntimeException('No release signal for writer');
                }
            }
            return [$report?->state, $changed];
        });
        echo json_encode($result)."\n";
    } catch (Throwable $error) {
        $cause = $error instanceof QueryException ? $error : $error->getPrevious();
        if ($operation !== 'timeout' || !$cause instanceof QueryException || (int) ($cause->errorInfo[1] ?? 0) !== 1205) {
            throw $error;
        }
        echo "timeout\n";
    }
    exit;
}

function resetFixture(int $state = 1, int $score = 100): void {
    foreach (['fixture_events', 'fixture_external', 'fixture_awards', 'fixture_journal',
        'pirep_comments', 'pirep_field_values', 'pireps', 'users', 'aircraft'] as $table) {
        DB::table($table)->delete();
    }
    DB::table('users')->insert(['id' => 1, 'rank_id' => 1, 'flights' => 3, 'flight_time' => 100, 'curr_airport_id' => 'KAAA']);
    DB::table('aircraft')->insert(['id' => 1, 'flight_time' => 200, 'airport_id' => 'KAAA', 'fuel_onboard' => 200,
        'mtow' => 15000, 'icao' => 'H60', 'status' => 'A']);
    foreach (['report1', 'report2'] as $id) {
        DB::table('pireps')->insert(['id' => $id, 'user_id' => 1, 'aircraft_id' => 1, 'state' => $state, 'source' => 1,
            'flight_time' => 45, 'block_fuel' => 500, 'fuel_used' => 350, 'score' => $score, 'arr_airport_id' => 'KBBB']);
    }
}
function counterEvidence(): array {
    $pilot = DB::table('users')->first();
    $aircraft = DB::table('aircraft')->first();
    return [(int) $pilot->flight_time, (int) $pilot->flights, (int) $aircraft->flight_time, (int) $pilot->rank_id,
        $pilot->curr_airport_id, $aircraft->airport_id, (int) $aircraft->fuel_onboard];
}
function checkEffects(int $state, array $counters, array $events, array $external): void {
    expectSame(Pirep::findOrFail('report1')->state, $state, 'Final report state');
    expectSame(counterEvidence(), $counters, 'Pilot minutes, flights, aircraft minutes, rank, locations and fuel');
    expectSame(DB::table('fixture_events')->orderBy('id')->pluck('kind')->all(), $events, 'Synchronous events');
    expectSame(DB::table('fixture_external')->orderBy('id')->pluck('kind')->all(), $external, 'Post-commit notifications');
}
function child(string $operation, string $id, string $signal = '-'): array {
    $proc = proc_open([PHP_BINARY, __FILE__, 'worker', $operation, $id, $signal],
        [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => STDERR], $pipes);
    stream_set_timeout($pipes[1], 10);
    return [$proc, $pipes[1]];
}
function line(array $child): string {
    $line = fgets($child[1]);
    if ($line === false) {
        throw new RuntimeException('Writer failed to report its result');
    }
    return trim($line);
}
function finishChild(array $child): void {
    fclose($child[1]);
    expectSame(proc_close($child[0]), 0, 'Writer exit');
}
function race(string $first, string $second, array $winner, array|string $loser, string $secondId = 'report1'): void {
    $release = tempnam(sys_get_temp_dir(), 'pirep-');
    unlink($release);
    $holder = child($first, 'report1', $release);
    expectSame(line($holder), 'ready', 'First writer ready');
    expectSame(line($holder), 'holding', 'First writer owns the transaction');
    $follower = child($second, $secondId);
    try {
        expectSame(line($follower), 'ready', 'Second writer opened competing transaction');
        if ($second === 'timeout') {
            expectSame(line($follower), $loser, 'Second writer timed out without replay');
        } else {
            $read = [$follower[1]];
            $write = $except = null;
            expectSame(stream_select($read, $write, $except, 0, 200_000), 0, 'Second writer is blocked on a shared lock');
        }
    } finally {
        touch($release);
    }
    expectSame(json_decode(line($holder), true), $winner, 'First outcome');
    if ($second !== 'timeout') {
        expectSame(json_decode(line($follower), true), $loser, 'Second outcome');
    }
    finishChild($holder);
    finishChild($follower);
    unlink($release);
}

$server = DB::selectOne('SELECT VERSION() AS version, DATABASE() AS fixture');
expectSame($server->fixture, 'vuscg_pirep_fixture', 'Disposable fixture schema');
expectSame(DB::table('information_schema.tables')->where('TABLE_SCHEMA', $server->fixture)->count(), 0, 'Empty fixture schema');
foreach (explode(';', file_get_contents(__DIR__.'/FixtureSchema.sql')) as $statement) {
    if (trim($statement) !== '') {
        DB::unprepared($statement);
    }
}
DB::unprepared(file_get_contents(__DIR__.'/../../pirep-concurrency/schema.sql'));
DB::table('ranks')->insert([
    ['id' => 1, 'name' => 'Initial', 'hours' => 0, 'auto_promote' => 1, 'auto_approve_acars' => 1, 'auto_approve_manual' => 1],
    ['id' => 2, 'name' => 'Rated', 'hours' => 2, 'auto_promote' => 1, 'auto_approve_acars' => 1, 'auto_approve_manual' => 1],
]);
DB::table('awards')->insert(['id' => 1, 'active' => 1]);
DB::table('roles')->insert(['id' => 1, 'name' => 'admin']);
DB::table('role_user')->insert(['role_id' => 1, 'user_id' => 1]);

$before = [100, 3, 200, 1, 'KAAA', 'KAAA', 200];
$accepted = [145, 4, 245, 2, 'KBBB', 'KBBB', 150];
foreach ([['native-approve', 'native-approve'], ['native-approve', 'bridge-approve'],
    ['bridge-approve', 'native-reject'], ['native-approve', 'bridge-reject']] as [$first, $second]) {
    resetFixture();
    race($first, $second, [2, true], [2, false]);
    checkEffects(2, $accepted, ['accepted', 'award'], ['accepted']);
    expectSame(DB::table('fixture_journal')->count(), 1, 'Finance row');
    expectSame(DB::table('fixture_awards')->count(), 1, 'Award row');
}
resetFixture();
race('native-reject', 'bridge-approve', [6, true], [6, false]);
checkEffects(6, $before, ['rejected'], ['rejected']);

resetFixture(0);
race('file', 'native-approve', [2, true], [2, false]);
checkEffects(2, $accepted, ['filed', 'accepted', 'award'], ['accepted']);
resetFixture(0, 10);
putenv('PIREP_FIXTURE_AUTOREJECT=1');
race('file', 'bridge-approve', [6, true], [6, false]);
putenv('PIREP_FIXTURE_AUTOREJECT');
checkEffects(6, $before, ['filed', 'rejected'], ['rejected']);
expectSame(DB::table('pirep_comments')->count(), 1, 'Native DisposableBasic wrote the reason once');
$service->submit(Pirep::findOrFail('report1'));
expectSame(DB::table('pirep_comments')->count(), 1, 'Replayed filing kept one reason');

resetFixture();
race('native-approve', 'timeout', [2, true], 'timeout');
expectSame($service->review('report1', 2)[1], false, 'Retry after committed transition');
checkEffects(2, $accepted, ['accepted', 'award'], ['accepted']);

resetFixture();
race('native-approve', 'native-approve', [2, true], [2, true], 'report2');
checkEffects(2, [190, 5, 290, 2, 'KBBB', 'KBBB', 150], ['accepted', 'award', 'accepted', 'award'], ['accepted', 'accepted']);

resetFixture();
$stale = Pirep::findOrFail('report1');
[$approved] = $service->review('report1', 2, 'legacy');
$oldRevision = PirepService::reviewRevision($approved);
expectSame($service->changeState($stale, 6)->state, 2, 'Stale snapshot must not reverse a new approval');
[$rejected, $reversed] = $service->review('report1', 6, $oldRevision);
expectSame($reversed, true, 'Fresh explicit reversal');
checkEffects(6, [100, 3, 200, 2, 'KBBB', 'KBBB', 150], ['accepted', 'award', 'rejected'], ['accepted', 'rejected']);
expectSame(DB::table('fixture_journal')->count(), 0, 'Finance removed on rejection');
expectSame(DB::table('fixture_awards')->count(), 1, 'Existing native award policy retains the award');
expectSame($service->review('report1', 2, PirepService::reviewRevision($rejected))[1], true, 'Explicit reapproval');
expectSame($service->review('report1', 6, $oldRevision)[1], false, 'Old reversal receipt cannot be replayed');
expectSame($service->deleteIfCurrent($rejected), false, 'Stale delete cannot remove a reapproved report');
try {
    $service->cancel(Pirep::findOrFail('report1'));
    throw new RuntimeException('Expected an accepted report to refuse cancellation');
} catch (\App\Exceptions\PirepCancelNotAllowed) {}
try {
    $service->update('report1', ['flight_time' => 90, 'state' => 0]);
    throw new RuntimeException('Expected an accepted report to refuse edits');
} catch (\App\Exceptions\PirepError) {}
checkEffects(2, $accepted, ['accepted', 'award', 'rejected', 'accepted', 'award'], ['accepted', 'rejected', 'accepted']);

resetFixture(0);
$service->file(Pirep::findOrFail('report1'), ['source' => 1, 'flight_time' => 45]);
expectSame($service->review('report1', 2)[1], false, 'Pending filing must finish before a reviewer can credit it');
$service->submit(Pirep::findOrFail('report1'));
$service->submit(Pirep::findOrFail('report1'));
checkEffects(2, $accepted, ['filed', 'accepted', 'award'], ['accepted']);
[$rejected] = $service->review('report1', 6, PirepService::reviewRevision(Pirep::findOrFail('report1')));
expectSame($service->deleteIfCurrent($rejected), true, 'Authorized deletion of reversed report');
expectSame(Pirep::query()->whereKey('report1')->exists(), false, 'Reversed report was deleted');
expectSame(User::findOrFail(1)->last_pirep_id, null, 'Last report cleared after deletion');

resetFixture();
$service->review('report1', 2);
$userSvc->recalculateStats(User::findOrFail(1));
(new \App\Services\AircraftService())->recalculateStats();
expectSame(array_slice(counterEvidence(), 0, 3), [45, 1, 45], 'Recounts match accepted reports');

foreach (['pilot', 'aircraft', 'finance', 'award'] as $stage) {
    resetFixture();
    $failureStage = $stage;
    try {
        $service->review('report1', 2);
        throw new RuntimeException('Expected injected failure');
    } catch (LogicException $error) {
        expectSame($error->getMessage(), 'fixture '.$stage, 'Failure was injected inside the transaction');
    } finally {
        $failureStage = null;
    }
    checkEffects(1, $before, [], []);
    expectSame(DB::table('fixture_journal')->count(), 0, 'Finance rolled back');
    expectSame(DB::table('fixture_awards')->count(), 0, 'Award rolled back');
}
resetFixture();
$events->listen(PirepAccepted::class, static function ($event): void {
    PirepAfterCommit::notify($event->pirep, 'failure', static function (): void { throw new LogicException('delivery failed'); });
});
expectSame($service->review('report1', 2)[1], true, 'Post-commit failure cannot make accounting fail');
expectSame($service->review('report1', 2)[1], false, 'Retry after notification failure did not repeat accounting');
checkEffects(2, $accepted, ['accepted', 'award'], ['accepted']);
echo "Concurrency, filing/auto-rejection, reversals, replay, timeout, rollback and after-commit fixture passed on {$server->version}.\n";
echo 'Initial and single-acceptance accounting '.json_encode([$before, $accepted])."\n";
