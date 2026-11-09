#!/usr/bin/env bash
# Backup and restore drill for Paper staging (Step 10).
#
#   scripts/backup-restore-drill.sh [restore-db-name]
#
# 1. pg_dump (custom format) of the staging database from the staging `db` container into
#    ./backups/ (gitignored).
# 2. Restores it into a SEPARATE database (default trendpilot_restore_drill) on a DIFFERENT
#    PostgreSQL instance: the local development container (docker-compose.yml, service `db`).
#    The staging database is only read.
# 3. Verifies the restore: row counts and checksums of positions, exits, fills, funding and every
#    ledger entry match the source exactly; each restored paper account equals its ledger
#    buckets; the migration journal is complete.
# Exit code 0 only when every check passes.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET_DB="${1:-trendpilot_restore_drill}"
case "$TARGET_DB" in trendpilot|trendpilot_test|trendpilot_e2e|trendpilot_staging) echo "Refusing to restore over $TARGET_DB"; exit 2;; esac
STAGING="docker compose -f docker-compose.staging.yml --env-file .env.staging"
DEV="docker compose -f docker-compose.yml"
SRC_USER=$(grep '^POSTGRES_USER=' .env.staging | cut -d= -f2-); SRC_USER=${SRC_USER:-trendpilot}
SRC_DB=$(grep '^POSTGRES_DB=' .env.staging | cut -d= -f2-); SRC_DB=${SRC_DB:-trendpilot_staging}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p backups
DUMP="backups/${SRC_DB}_${STAMP}.dump"

echo "== 1. Backup: pg_dump -Fc $SRC_DB (staging) -> $DUMP"
$STAGING exec -T db pg_dump -U "$SRC_USER" -d "$SRC_DB" -Fc --no-owner > "$DUMP"
ls -l "$DUMP" | awk '{print "   size", $5, "bytes"}'
$STAGING exec -T db pg_restore --list < "$DUMP" > /dev/null && echo "   archive readable (pg_restore --list)"

echo "== 2. Restore into $TARGET_DB on the separate development PostgreSQL instance"
$DEV exec -T db psql -U trendpilot -d postgres -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $TARGET_DB" -c "CREATE DATABASE $TARGET_DB"
$DEV exec -T db pg_restore -U trendpilot -d "$TARGET_DB" --no-owner --exit-on-error < "$DUMP"
echo "   restored"

echo "== 3. Verify"
CHECKS="
SELECT 'migrations', count(*)::text, max(created_at)::text FROM drizzle.__drizzle_migrations
UNION ALL SELECT 'users', count(*)::text, md5(string_agg(id::text || email || status, ',' ORDER BY id)) FROM users
UNION ALL SELECT 'paper_accounts', count(*)::text, md5(string_agg(id::text || wallet_balance || position_margin || order_reserve, ',' ORDER BY id)) FROM paper_accounts
UNION ALL SELECT 'positions', count(*)::text, md5(string_agg(id::text || status || contracts || avg_entry_price || coalesce(close_reason,'') || realized_pnl_usdt || fees_usdt, ',' ORDER BY id)) FROM positions
UNION ALL SELECT 'position_exits', count(*)::text, md5(string_agg(id::text || contracts || price || fee || realized_pnl, ',' ORDER BY id)) FROM position_exits
UNION ALL SELECT 'fills', count(*)::text, md5(string_agg(id::text || exchange_fill_id || contracts || price || fee, ',' ORDER BY id)) FROM fills
UNION ALL SELECT 'paper_funding', count(*)::text, md5(coalesce(string_agg(id::text || amount, ',' ORDER BY id), '')) FROM paper_funding
UNION ALL SELECT 'ledger_entries', count(*)::text, md5(string_agg(id::text || kind || bucket || amount || ref_id, ',' ORDER BY id)) FROM ledger_entries
UNION ALL SELECT 'ledger_sum', sum(amount)::text, '' FROM ledger_entries
UNION ALL SELECT 'signal_events', count(*)::text, md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) FROM signal_events
UNION ALL SELECT 'audit_events', count(*)::text, '' FROM audit_events
"
SRC=$($STAGING exec -T db psql -U "$SRC_USER" -d "$SRC_DB" -tA -F '|' -c "$CHECKS")
DST=$($DEV exec -T db psql -U trendpilot -d "$TARGET_DB" -tA -F '|' -c "$CHECKS")
FAIL=0
while IFS= read -r line; do
  name=${line%%|*}
  other=$(echo "$DST" | grep "^$name|" || true)
  if [ "$line" = "$other" ]; then echo "   PASS  $name  ${line#*|}"; else echo "   FAIL  $name  source=${line#*|} restored=${other#*|}"; FAIL=1; fi
done <<< "$SRC"

IDENTITY=$($DEV exec -T db psql -U trendpilot -d "$TARGET_DB" -tA -c "
SELECT count(*) FROM paper_accounts a WHERE
  a.wallet_balance   <> (SELECT coalesce(sum(amount),0) FROM ledger_entries l WHERE l.paper_account_id = a.id AND l.bucket = 'WALLET') OR
  a.position_margin  <> (SELECT coalesce(sum(amount),0) FROM ledger_entries l WHERE l.paper_account_id = a.id AND l.bucket = 'POSITION_MARGIN') OR
  a.order_reserve    <> (SELECT coalesce(sum(amount),0) FROM ledger_entries l WHERE l.paper_account_id = a.id AND l.bucket = 'ORDER_RESERVE')")
if [ "$IDENTITY" = "0" ]; then echo "   PASS  restored balances equal their ledger buckets"; else echo "   FAIL  $IDENTITY restored account(s) differ from their ledger"; FAIL=1; fi

if [ "$FAIL" = "0" ]; then echo "== RESULT: restore verified ($DUMP -> $TARGET_DB)"; else echo "== RESULT: RESTORE MISMATCH"; fi
exit $FAIL
