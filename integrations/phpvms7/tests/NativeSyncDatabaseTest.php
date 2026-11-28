<?php

namespace Illuminate\Support\Facades {
    final class DB
    {
        public static string $default = 'website';
        public static array $connections = [];
        public static bool $fail = false;

        public static function getDefaultConnection(): string { return self::$default; }
        public static function getConnections(): array { return self::$connections; }
        public static function setDefaultConnection(string $name): void { self::$default = $name; }
        public static function purge(string $name): void { unset(self::$connections[$name]); }

        public static function connection(string $name): object
        {
            return self::$connections[$name] ??= new class ($name) {
                public function __construct(private string $name) {}

                public function getConfig(): array
                {
                    return \config('database.connections.'.$this->name);
                }

                public function getPdo(): void
                {
                    if (DB::$fail) {
                        throw new \RuntimeException('fixture connection denied');
                    }
                    \expect(DB::$default === 'website', 'Resolve the database session before changing the default');
                    \expect($this->getConfig()['modes'] === ['ONLY_FULL_GROUP_BY', 'STRICT_TRANS_TABLES', 'NO_ENGINE_SUBSTITUTION'], 'Keep explicit modes and require strict mode');
                }
            };
        }
    }
}

namespace {
    use Illuminate\Support\Facades\DB;
    use Modules\VuscgCustom\Services\NativeSyncDatabase;

    require __DIR__.'/../modules/VuscgCustom/Services/NativeSyncDatabase.php';

    $website = [
        'name' => 'website',
        'driver' => 'mysql',
        'host' => 'primary',
        'strict' => false,
        'modes' => ['ONLY_FULL_GROUP_BY'],
        'options' => [PDO::ATTR_PERSISTENT => true],
    ];
    $connections = ['website' => $website];

    function config(string|array $config): mixed
    {
        global $connections;
        if (is_array($config)) {
            foreach ($config as $key => $value) {
                if ($key === 'database.connections') {
                    $connections = $value;
                } else {
                    $connections[substr($key, strlen('database.connections.'))] = $value;
                }
            }
            return null;
        }
        return $config === 'database.connections'
            ? $connections : ($connections[substr($config, strlen('database.connections.'))] ?? null);
    }

    function expect(bool $condition, string $message): void
    {
        if (!$condition) {
            throw new RuntimeException($message);
        }
    }

    $site = DB::connection('website');
    $status = NativeSyncDatabase::run(function () use ($site): int {
        $name = DB::getDefaultConnection();
        $sync = DB::connection($name);
        expect($site !== $sync, 'Use a separate database connection');
        expect($sync->getConfig()['host'] === 'primary', 'Keep the resolved writer host');
        expect($sync->getConfig()['options'][PDO::ATTR_PERSISTENT] === false, 'Isolate physical sessions');
        expect($sync->getConfig()['options'][PDO::ATTR_ERRMODE] === PDO::ERRMODE_EXCEPTION, 'Surface connector and SQL errors');
        return NativeSyncDatabase::run(fn () => 17);
    });
    expect($status === 17, 'Preserve the worker result');
    expect(DB::getDefaultConnection() === 'website' && DB::getConnections() === ['website' => $site], 'Restore the original connection and purge the worker');
    expect($connections === ['website' => $website], 'Restore the website configuration');

    foreach ([true, false] as $simulateInitializationFailure) {
        DB::$fail = $simulateInitializationFailure;
        $ran = false;
        try {
            NativeSyncDatabase::run(function () use (&$ran): void {
                $ran = true;
                throw new RuntimeException('fixture worker failed');
            });
            throw new LogicException('Expected the failure to propagate');
        } catch (RuntimeException $error) {
            expect($error->getMessage() === ($simulateInitializationFailure ? 'fixture connection denied' : 'fixture worker failed'), 'Expose the initialization or worker failure');
        }
        expect($ran !== $simulateInitializationFailure, 'Skip protected work after failed initialization');
        expect(DB::getDefaultConnection() === 'website' && DB::getConnections() === ['website' => $site], 'Restore the website connection on failure');
        expect($connections === ['website' => $website], 'Remove the worker configuration on failure');
    }

    echo "Native sync isolates the writer and restores the website connection on failure.\n";
}
