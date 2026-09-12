#!/usr/bin/env bash
# AI: Ежедневный бэкап Postgres из контейнера compose. Хранит 7 последних дней (BACKUP_KEEP_DAYS).
#   Вручную:   /opt/helpdesk-ai/deploy/backup.sh
#   Cron:      см. deploy/backup.cron (устанавливает server-setup.sh)
#   Восстановить: /opt/helpdesk-ai/deploy/restore.sh /var/backups/helpdesk/helpdesk-2026-09-12_03-00.sql.gz
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/helpdesk-ai}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/helpdesk}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"

mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"
stamp="$(date +%F_%H-%M)"
out="$BACKUP_DIR/helpdesk-$stamp.sql.gz"
tmp="$out.part"

# AI: pg_dump внутри контейнера базы: версия клиента совпадает с сервером, пароль не нужен -
# соединение локальное под пользователем postgres-образа.
docker compose exec -T postgres pg_dump -U helpdesk --no-owner --clean --if-exists helpdesk \
  | gzip -6 > "$tmp"
mv "$tmp" "$out"

# AI: Пустой или крошечный дамп - признак сбоя; лучше упасть, чем хранить мусор 7 дней.
size=$(stat -c %s "$out")
if [ "$size" -lt 1024 ]; then
  echo "backup looks empty ($size bytes): $out" >&2
  exit 1
fi

find "$BACKUP_DIR" -name 'helpdesk-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $out ($size bytes), kept $(ls "$BACKUP_DIR"/helpdesk-*.sql.gz | wc -l) file(s)"
