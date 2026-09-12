#!/usr/bin/env bash
# AI: Восстановление базы из дампа deploy/backup.sh. Останавливает api/worker на время загрузки,
# чтобы никто не писал в базу поверх восстановления.
#   /opt/helpdesk-ai/deploy/restore.sh /var/backups/helpdesk/helpdesk-2026-09-12_03-00.sql.gz
set -euo pipefail
DUMP="${1:?usage: restore.sh <file.sql.gz>}"
APP_DIR="${APP_DIR:-/opt/helpdesk-ai}"
cd "$APP_DIR"

docker compose stop api worker
gunzip -c "$DUMP" | docker compose exec -T postgres psql -U helpdesk -v ON_ERROR_STOP=1 -q helpdesk
docker compose start api worker
echo "restored from $DUMP"
