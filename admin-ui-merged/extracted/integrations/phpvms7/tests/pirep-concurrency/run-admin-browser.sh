#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/../../../.." && pwd)
site=$(realpath "${1:?Provide the disposable PHP source tree with installed-source.patch applied}")
vendor=$(realpath "${2:?Provide a disposable Composer vendor directory with Illuminate 10.48}")
jquery=$(realpath "${3:?Provide the path to jquery.js}")
image=${4:-vuscg-php-mysql:local}

network=$(docker network create "vuscg-pirep-admin-$$")
database=
server=
cleanup() {
  if [[ -n $server ]]; then docker stop "$server" >/dev/null; fi
  if [[ -n $database ]]; then docker stop "$database" >/dev/null; fi
  docker network rm "$network" >/dev/null
}
trap cleanup EXIT

database=$(docker run --rm -d --network "$network" --network-alias pirep-mysql \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=vuscg_pirep_fixture \
  -e MYSQL_USER=fixture -e MYSQL_PASSWORD=local_fixture_only mysql:5.7.44)
for attempt in {1..60}; do
  if docker exec "$database" mysqladmin --protocol TCP -h 127.0.0.1 ping --silent >/dev/null 2>&1; then
    break
  fi
  if [[ $attempt == 60 ]]; then
    echo 'Disposable MySQL timed out' >&2
    exit 1
  fi
  sleep 1
done

router=/repo/integrations/phpvms7/tests/pirep-concurrency/AdminBrowserFixture.php
options=(--rm --network "$network" -v "$repo:/repo:ro" -v "$site:/candidate:ro" -v "$vendor:/vendor:ro" -v "$jquery:/jquery.js:ro"
  -e PIREP_FIXTURE_AUTOLOAD=/vendor/autoload.php -e PIREP_FIXTURE_SITE=/candidate)
docker run "${options[@]}" "$image" php "$router" seed
server=$(docker run "${options[@]}" -d -p 127.0.0.1::8080 "$image" php -S 0.0.0.0:8080 "$router")
port=$(docker port "$server" 8080 | sed -n 's/^127\.0\.0\.1:\([0-9]\+\)$/\1/p')
origin="http://127.0.0.1:$port"
if ! curl -fsS --retry 10 --retry-connrefused "$origin/fixture/health" >/dev/null; then
  docker logs "$server"
  exit 1
fi
if ! PIREP_FIXTURE_ORIGIN="$origin" node "$repo/integrations/phpvms7/tests/pirep-concurrency/admin-browser.js"; then
  docker logs "$server"
  exit 1
fi
