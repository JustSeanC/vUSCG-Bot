#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/../../../.." && pwd)
site=$(realpath "${1:?Provide the disposable PHP source tree with installed-source.patch applied}")
vendor=$(realpath "${2:?Provide an isolated Composer vendor directory with Illuminate Database, Config and Events 10.48}")
image=${3:-vuscg-php-mysql:local}
version=${4:-5.7.44}
case "$version" in 5.7.44|8.4) ;; *) exit 1 ;; esac

network=$(docker network create --internal "vuscg-pirep-fixture-$$")
server=
cleanup() {
  if [[ -n $server ]]; then docker stop "$server" >/dev/null; fi
  docker network rm "$network" >/dev/null
}
trap cleanup EXIT
server=$(docker run --network "$network" --network-alias pirep-mysql --rm -d \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=vuscg_pirep_fixture \
  -e MYSQL_USER=fixture -e MYSQL_PASSWORD=local_fixture_only "mysql:$version")
for try in {1..60}; do
  if docker exec "$server" mysqladmin --protocol TCP -h 127.0.0.1 ping --silent >/dev/null 2>&1; then
    break
  fi
  if [[ $try == 60 ]]; then
    echo 'Disposable MySQL timed out' >&2
    exit 1
  fi
  sleep 1
done

docker run --rm --network "$network" -v "$repo:/repo:ro" -v "$site:/candidate:ro" -v "$vendor:/vendor:ro" \
  -e PIREP_FIXTURE_AUTOLOAD=/vendor/autoload.php -e PIREP_FIXTURE_SITE=/candidate \
  "$image" php /repo/integrations/phpvms7/tests/pirep-concurrency/ConcurrencyFixture.php
