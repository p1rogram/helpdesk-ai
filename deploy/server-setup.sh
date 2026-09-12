#!/usr/bin/env bash
# AI: One-time server bootstrap (Ubuntu 22.04/24.04, run as root or with sudo):
#   curl -fsSL https://raw.githubusercontent.com/p1rogram/helpdesk-ai/master/deploy/server-setup.sh | sudo bash -s -- <domain>
# Installs Docker, clones the repo into /opt/helpdesk-ai, prepares .env and opens the firewall.
set -euo pipefail
DOMAIN="${1:?usage: server-setup.sh <domain>}"
APP_DIR=/opt/helpdesk-ai
REPO=https://github.com/p1rogram/helpdesk-ai.git

# AI: Нужен root (apt, /opt, ufw). При запуске через `sudo` вызвавший пользователь получает доступ к
# docker: пайплайн CI/CD заходит под этим пользователем и запускает docker compose.
if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo:  curl -fsSL <url> | sudo bash -s -- <domain>" >&2
  exit 1
fi
DEPLOY_USER="${SUDO_USER:-}"

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
apt-get install -y -q git ufw >/dev/null

if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
if [ -n "$DEPLOY_USER" ] && [ "$DEPLOY_USER" != "root" ]; then
  usermod -aG docker "$DEPLOY_USER"
  chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$APP_DIR"
  echo ">>> $DEPLOY_USER added to the docker group (takes effect on next login)."
fi

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s#^DOMAIN=.*#DOMAIN=$DOMAIN#" .env
  sed -i "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=$(openssl rand -hex 16)#" .env
  sed -i "s#^JWT_SECRET=.*#JWT_SECRET=$(openssl rand -base64 32)#" .env
  sed -i "s#^WEB_DEMO_LOGIN=.*#WEB_DEMO_LOGIN=false#" .env
  sed -i "s#^OPERATOR_OPEN_ACCESS=.*#OPERATOR_OPEN_ACCESS=false#" .env
  echo ">>> .env created. Fill in ANTHROPIC_API_KEY, LLM_BASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, ADMIN_USERS:"
  echo ">>>     nano $APP_DIR/.env"
fi

# AI: Ежедневный бэкап базы (03:00, хранение 7 дней) - deploy/backup.sh + cron.
chmod +x "$APP_DIR"/deploy/backup.sh "$APP_DIR"/deploy/restore.sh
install -m 0644 "$APP_DIR/deploy/backup.cron" /etc/cron.d/helpdesk-backup
mkdir -p /var/backups/helpdesk

ufw allow OpenSSH >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw --force enable >/dev/null
echo ">>> Done. Fill in .env, then add the GitHub secrets and push to master (or run the Deploy workflow):"
echo ">>> CI/CD builds the images, publishes them to GHCR and starts the stack here."
