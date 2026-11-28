<?php

namespace Modules\VuscgCustom\Services;

use Illuminate\Support\Facades\DB;
use PDO;
use RuntimeException;

final class NativeSyncDatabase
{
    private const NAME = 'vuscg_native_sync';
    private static bool $active = false;

    public static function run(callable $work): mixed
    {
        $original = DB::getDefaultConnection();
        if (self::$active && $original === self::NAME) {
            return $work();
        }

        $key = 'database.connections.'.self::NAME;
        if (config($key) !== null || isset(DB::getConnections()[self::NAME])) {
            throw new RuntimeException('The native training connection name is already in use.');
        }

        // Laravel exposes the resolved writer config, including any URL or write-host overrides.
        $writer = DB::connection($original)->getConfig();
        if (($writer['driver'] ?? null) !== 'mysql') {
            throw new RuntimeException('Native training synchronization requires a MySQL writer.');
        }
        unset($writer['name'], $writer['url'], $writer['read'], $writer['write']);
        // Explicit modes take precedence over the site's strict=false. The connector applies
        // them before returning every PDO, including replacements opened after disconnects.
        if (isset($writer['modes']) || empty($writer['strict'])) {
            $writer['modes'] = array_values(array_unique(array_merge(
                $writer['modes'] ?? [], ['STRICT_TRANS_TABLES', 'NO_ENGINE_SUBSTITUTION']
            )));
        }
        $writer['options'][PDO::ATTR_PERSISTENT] = false;
        $writer['options'][PDO::ATTR_ERRMODE] = PDO::ERRMODE_EXCEPTION;

        config([$key => $writer]);
        try {
            DB::connection(self::NAME)->getPdo();
            DB::setDefaultConnection(self::NAME);
            self::$active = true;
            return $work();
        } finally {
            self::$active = false;
            DB::setDefaultConnection($original);
            DB::purge(self::NAME);
            $connections = config('database.connections');
            unset($connections[self::NAME]);
            config(['database.connections' => $connections]);
        }
    }
}
