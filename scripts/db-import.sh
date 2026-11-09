#!/usr/bin/env bash
# Imports a TrendPilot database export (database-export/<name>.dump + <name>.manifest) into the
# database of a deployed TrendPilot stack run with docker compose (services db, migrate, web,
# worker, feed, caddy; see docs/STAGING.md). Run it on the server, from the repository checkout.
#
#   scripts/db-import.sh <file.dump> [options]
#
#   --env-file FILE          REQUIRED: the stack's env file (POSTGRES_USER/PASSWORD/DB), e.g. .env.staging
#   --compose-file FILE      compose file (default docker-compose.staging.yml)
#   --project NAME           compose project name (default: the compose file's own name)
#   --replace                allow replacing a target database that already has users
#   --allow-fixture-accounts allow the seeded *@trendpilot.local accounts (rehearsals only:
#                            their password is the public development seed password)
#   --yes                    do not ask for confirmation (non-interactive runs)
#
# What it does, in order (any failure stops before the live database is touched, except where
# noted; the previous database is always kept for rollback):
#   1. Verifies the archive: sha256 from the manifest, readable by pg_restore.
#   2. Restores it into a scratch database <db>_import and checks it there: migration level not
#      newer than the deployed code, row counts equal the manifest, no fixture accounts.
#   3. Stops web, worker and feed; backs up the current database to backups/.
#   4. Swaps databases by rename: <db> -> <db>_pre_import_<stamp>, <db>_import -> <db>.
#   5. Ends every imported session (everyone signs in again) and cancels queued emails from the
#      source environment so stale invite/reset links are not sent.
#   6. Runs migrations, starts the services, waits for /v1/health.
# Rollback: printed at the end (rename the databases back).
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "ERROR: $*" >&2; exit 1; }
usage() { sed -n '2,15p' "$0"; exit 2; }

DUMP=""; ENV_FILE=""; COMPOSE_FILE="docker-compose.staging.yml"; PROJECT=""
REPLACE=0; ALLOW_FIXTURES=0; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?}"; shift 2;;
    --compose-file) COMPOSE_FILE="${2:?}"; shift 2;;
    --project) PROJECT="${2:?}"; shift 2;;
    --replace) REPLACE=1; shift;;
    --allow-fixture-accounts) ALLOW_FIXTURES=1; shift;;
    --yes) YES=1; shift;;
    -h|--help) usage;;
    -*) die "unknown option $1";;
    *) [ -z "$DUMP" ] || die "only one dump file"; DUMP="$1"; shift;;
  esac
done
[ -n "$DUMP" ] || usage
[ -f "$DUMP" ] || die "dump not found: $DUMP"
[ -n "$ENV_FILE" ] || die "pass --env-file (the deployed stack's env file)"
[ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE"
[ -f "$COMPOSE_FILE" ] || die "compose file not found: $COMPOSE_FILE"

C="docker compose ${PROJECT:+-p $PROJECT} -f $COMPOSE_FILE --env-file $ENV_FILE"
envval() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
PGUSER_=$(envval POSTGRES_USER); PGUSER_=${PGUSER_:-trendpilot}
DB=$(envval POSTGRES_DB); DB=${DB:-trendpilot_staging}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SCRATCH="${DB}_import"
OLD="${DB}_pre_import_${STAMP}"
psql_db() { local d="$1"; shift; $C exec -T db psql -U "$PGUSER_" -d "$d" -v ON_ERROR_STOP=1 -q "$@"; }
q() { $C exec -T db psql -U "$PGUSER_" -d "$1" -tA -v ON_ERROR_STOP=1 -c "$2"; }
drop_scratch() { psql_db postgres -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null 2>&1 || true; }

echo "== 1. Archive"
MANIFEST="${DUMP%.dump}.manifest"
if [ -f "$MANIFEST" ]; then
  want=$(grep '^sha256=' "$MANIFEST" | cut -d= -f2)
  got=$(sha256sum "$DUMP" | cut -d' ' -f1)
  [ "$want" = "$got" ] || die "sha256 mismatch: manifest $want, file $got"
  echo "   sha256 matches the manifest"
else
  echo "   WARNING: no manifest next to the dump; checksum and row counts are not verified"
fi
$C up -d db >/dev/null
for _ in $(seq 1 60); do $C exec -T db pg_isready -U "$PGUSER_" -d postgres >/dev/null 2>&1 && break; sleep 2; done
$C exec -T db pg_isready -U "$PGUSER_" -d postgres >/dev/null || die "database container is not ready"
$C exec -T db pg_restore --list < "$DUMP" >/dev/null || die "pg_restore cannot read $DUMP"
echo "   readable by pg_restore; target database: $DB"

echo "== 2. Restore into scratch database $SCRATCH and check"
CODE_MIGRATIONS=$($C run --rm --no-deps -T migrate sh -c 'ls packages/db/migrations/*.sql | wc -l' | tr -d '[:space:]')
[ -n "$CODE_MIGRATIONS" ] || die "could not count migrations in the deployed image"
drop_scratch
psql_db postgres -c "CREATE DATABASE \"$SCRATCH\""
trap drop_scratch EXIT
$C exec -T db pg_restore -U "$PGUSER_" -d "$SCRATCH" --no-owner --no-privileges --exit-on-error < "$DUMP"
ARCHIVE_MIGRATIONS=$(q "$SCRATCH" "select count(*) from drizzle.__drizzle_migrations")
echo "   migrations: archive $ARCHIVE_MIGRATIONS, deployed code $CODE_MIGRATIONS"
[ "$ARCHIVE_MIGRATIONS" -le "$CODE_MIGRATIONS" ] || die "the archive is newer than the deployed code; deploy the matching release first"

if [ -f "$MANIFEST" ]; then
  MISMATCH=0
  while IFS='=' read -r key val; do
    t=${key#rows.}
    n=$(q "$SCRATCH" "select count(*) from public.\"$t\"" 2>/dev/null || echo missing)
    if [ "$n" != "$val" ]; then echo "   FAIL rows $t: manifest $val, restored $n"; MISMATCH=1; fi
  done < <(grep '^rows\.' "$MANIFEST")
  [ "$MISMATCH" = 0 ] || die "restored row counts differ from the manifest"
  echo "   row counts equal the manifest ($(grep -c '^rows\.' "$MANIFEST") tables)"
fi

USERS=$(q "$SCRATCH" "select count(*) from users")
ADMINS=$(q "$SCRATCH" "select count(*) from users where role='ADMIN' and status='ACTIVE'")
FIXTURES=$(q "$SCRATCH" "select coalesce(string_agg(email, ', ' order by email), '') from users where email like '%@trendpilot.local'")
MFA_USERS=$(q "$SCRATCH" "select count(*) from users where mfa_secret_enc is not null")
SEALED_MAIL=$(q "$SCRATCH" "select count(*) from mail_settings where smtp_password_sealed is not null" 2>/dev/null || echo 0)
echo "   users $USERS (active admins $ADMINS, MFA $MFA_USERS)"
if [ -n "$FIXTURES" ]; then
  echo "   FIXTURE ACCOUNTS: $FIXTURES"
  echo "   Their password is the public development seed password. Anyone could sign in."
  [ "$ALLOW_FIXTURES" = 1 ] || die "refusing to import fixture accounts into a deployed database (create real users with ops:bootstrap-admin instead; --allow-fixture-accounts is for rehearsals only)"
  echo "   WARNING: continuing because --allow-fixture-accounts was given"
fi
[ "$ADMINS" -gt 0 ] || echo "   WARNING: no active administrator in the archive; create one afterwards with ops:bootstrap-admin"
if [ "$MFA_USERS" -gt 0 ] || [ "$SEALED_MAIL" -gt 0 ]; then
  echo "   NOTE: $MFA_USERS MFA secret(s) and $SEALED_MAIL SMTP password(s) are encrypted with the SOURCE DATA_ENCRYPTION_KEY."
  echo "         They only work if $ENV_FILE has the same key; otherwise re-enrol MFA and re-enter the SMTP password."
fi

TARGET_EXISTS=$(q postgres "select count(*) from pg_database where datname='$DB'")
TARGET_USERS=0
if [ "$TARGET_EXISTS" = 1 ]; then TARGET_USERS=$(q "$DB" "select count(*) from users" 2>/dev/null || echo 0); fi
echo "   current $DB: $([ "$TARGET_EXISTS" = 1 ] && echo "exists, $TARGET_USERS user(s)" || echo "does not exist")"
[ "$TARGET_USERS" = 0 ] || [ "$REPLACE" = 1 ] || die "$DB already has $TARGET_USERS user(s); pass --replace to replace it (it is kept as $OLD)"

if [ "$YES" != 1 ]; then
  echo
  echo "About to stop web/worker/feed and replace database '$DB' with the contents of $(basename "$DUMP")."
  read -r -p "Type the database name to continue: " answer
  [ "$answer" = "$DB" ] || die "not confirmed"
fi

echo "== 3. Stop services and back up the current database"
$C stop web worker feed >/dev/null 2>&1 || true
mkdir -p backups
if [ "$TARGET_EXISTS" = 1 ]; then
  BACKUP="backups/${DB}_pre-import_${STAMP}.dump"
  $C exec -T db pg_dump -U "$PGUSER_" -d "$DB" -Fc --no-owner > "$BACKUP"
  echo "   $BACKUP"
fi

echo "== 4. Swap databases"
trap - EXIT
if [ "$TARGET_EXISTS" = 1 ]; then
  psql_db postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$DB', '$SCRATCH') AND pid <> pg_backend_pid()" >/dev/null
  psql_db postgres -c "ALTER DATABASE \"$DB\" RENAME TO \"$OLD\""
  echo "   $DB -> $OLD (kept for rollback)"
fi
psql_db postgres -c "ALTER DATABASE \"$SCRATCH\" RENAME TO \"$DB\""
echo "   $SCRATCH -> $DB"

echo "== 5. Post-import hygiene"
ENDED=$(q "$DB" "with d as (delete from sessions returning 1) select count(*) from d")
CANCELLED=$(q "$DB" "with u as (update email_outbox set delivery_status='FAILED', delivery_error='Not sent: queued in the source environment before the database import.' where delivery_status='QUEUED' returning id), j as (delete from jobs where kind='email.deliver' and status in ('PENDING','RUNNING') returning 1) select count(*) from u" 2>/dev/null || echo 0)
echo "   ended $ENDED imported session(s); cancelled $CANCELLED queued email(s)"

echo "== 6. Migrate and start"
$C run --rm migrate
$C up -d
HEALTH=""
for _ in $(seq 1 40); do
  HEALTH=$($C exec -T web node -e 'fetch("http://127.0.0.1:3000/v1/health").then(r=>r.text()).then(t=>console.log(t)).catch(()=>process.exit(1))' 2>/dev/null || true)
  echo "$HEALTH" | grep -q '"status":"ok"' && break
  sleep 3
done
echo "   health: ${HEALTH:-not reporting}"
echo "$HEALTH" | grep -q '"status":"ok"' || echo "   WARNING: web did not report healthy; check '$C logs web'"

echo
echo "== RESULT: imported $(basename "$DUMP") into $DB"
if [ "$TARGET_EXISTS" = 1 ]; then
  echo "Rollback (keeps the imported data as ${DB}_failed_import):"
  echo "  $C stop web worker feed"
  echo "  $C exec -T db psql -U $PGUSER_ -d postgres -c 'ALTER DATABASE \"$DB\" RENAME TO \"${DB}_failed_import\"' -c 'ALTER DATABASE \"$OLD\" RENAME TO \"$DB\"'"
  echo "  $C up -d"
  echo "When no longer needed: DROP DATABASE \"$OLD\"; backup file: ${BACKUP:-none}"
fi
