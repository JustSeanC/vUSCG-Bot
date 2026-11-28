#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Only fresh loopback fixtures are used. The tests ignore the bot's DB_* settings.
fixture_id=
upgrade_dump=
cleanup() {
  if [[ -n $fixture_id ]]; then
    docker stop "$fixture_id" >/dev/null
    fixture_id=
  fi
}
trap 'cleanup; if [[ -n $upgrade_dump ]]; then rm -f "$upgrade_dump"; fi' EXIT

node --version
npm run check

versions=(5.7.44 8.4)
history_counts='SELECT COUNT(*) FROM vuscg_training_records; SELECT COUNT(*) FROM vuscg_training_qualification_events;'
if [[ $# -eq 0 ]]; then
  upgrade_dump=$(mktemp)
fi
if [[ $# -gt 0 ]]; then
  versions=("$@")
fi
for version in "${versions[@]}"; do
  case "$version" in
    5.7.44|8.4) ;;
    *) echo "Unsupported test version $version" >&2; exit 1 ;;
  esac
  fixture_id=$(docker run --rm -d \
    -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=vuscg_training_test \
    -e MYSQL_USER=training_test -e MYSQL_PASSWORD=training_test_local_only \
    -p 127.0.0.1::3306 "mysql:$version")
  for attempt in {1..60}; do
    if docker exec "$fixture_id" mysqladmin --protocol TCP -h 127.0.0.1 ping --silent >/dev/null 2>&1; then
      break
    fi
    if [[ $attempt == 60 ]]; then
      echo "Disposable MySQL $version did not become ready" >&2
      exit 1
    fi
    sleep 1
  done
  port=$(docker port "$fixture_id" 3306 | sed -n 's/^127\.0\.0\.1:\([0-9]\+\)$/\1/p')
  test -n "$port"
  docker exec "$fixture_id" mysql --batch --skip-column-names -e 'SELECT VERSION()'
  TRAINING_TEST_MYSQL_PORT="$port" TRAINING_TEST_MYSQL_VERSION="$version" npm test
  if [[ -n $upgrade_dump && $version == 5.7.44 ]]; then
    original_counts=$(docker exec "$fixture_id" mysql -Ns -D vuscg_training_test -e "$history_counts")
    docker exec "$fixture_id" mysqldump --single-transaction --set-gtid-purged=OFF --no-tablespaces \
      vuscg_training_test > "$upgrade_dump"
  elif [[ -n $upgrade_dump && $version == 8.4 ]]; then
    docker exec "$fixture_id" mysql -e 'CREATE DATABASE vuscg_training_upgrade_rehearsal'
    docker exec -i "$fixture_id" mysql vuscg_training_upgrade_rehearsal < "$upgrade_dump"
    restored_counts=$(docker exec "$fixture_id" mysql -Ns -D vuscg_training_upgrade_rehearsal -e "$history_counts")
    if [[ $restored_counts != "$original_counts" ]]; then
      echo 'Logical restore changed training or qualification history counts' >&2
      exit 1
    fi
    invalid_source="UPDATE vuscg_training_records SET source='import', instructor_discord_id='123456789012345678' LIMIT 1"
    if docker exec "$fixture_id" mysql -D vuscg_training_upgrade_rehearsal -e "$invalid_source" > "$upgrade_dump" 2>&1; then
      echo 'Logical restore left record integrity unenforced' >&2
      exit 1
    fi
    if ! grep -q 'ERROR 1452 .*fk_training_source_guard' "$upgrade_dump"; then
      cat "$upgrade_dump" >&2
      exit 1
    fi
    echo 'Populated 5.7.44 logical dump restored on MySQL 8.4 and rejected an invalid source write'
  fi
  cleanup
done

docker run --rm -v "$PWD:/repo:ro" -w /repo php:8.1-cli sh -ec '
  php --version
  find integrations/phpvms7 -name "*.php" -print0 | xargs -0 -n1 php -l
  php integrations/phpvms7/tests/PirepDecisionGateTest.php
  php integrations/phpvms7/tests/QualificationNativePlanTest.php
  php integrations/phpvms7/tests/TraineeRatingPlanTest.php
'
