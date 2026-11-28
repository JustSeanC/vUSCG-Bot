#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Dedicated local test service. Production DB_* variables are ignored by the test.
fixture_id=$(docker run --rm -d   -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=vuscg_training_test   -e MYSQL_USER=training_test -e MYSQL_PASSWORD=training_test_local_only   -p 127.0.0.1::3306 mysql:8.4)
trap 'docker stop "$fixture_id" >/dev/null' EXIT

for attempt in {1..45}; do
  if docker exec "$fixture_id" mysqladmin --protocol TCP -h 127.0.0.1 ping --silent >/dev/null 2>&1; then
    break
  fi
  if [[ $attempt == 45 ]]; then
    echo 'Disposable MySQL did not become ready' >&2
    exit 1
  fi
  sleep 1
done

port=$(docker port "$fixture_id" 3306 | sed -n 's/^127\.0\.0\.1:\([0-9]\+\)$/\1/p')
test -n "$port"
node --version
docker exec "$fixture_id" mysql --batch --skip-column-names -e 'SELECT VERSION()'
npm run check
TRAINING_TEST_MYSQL_PORT="$port" npm test

docker run --rm -v "$PWD:/repo:ro" -w /repo php:8.1-cli sh -ec '
  php --version
  find integrations/phpvms7 -name "*.php" -print0 | xargs -0 -n1 php -l
  php integrations/phpvms7/tests/PirepDecisionGateTest.php
  php integrations/phpvms7/tests/QualificationNativePlanTest.php
  php integrations/phpvms7/tests/TraineeRatingPlanTest.php
'
