#!/usr/bin/env bash
# AI: One-time server bootstrap (Ubuntu 22.04/24.04, run as root or with sudo):
#   curl -fsSL https://raw.githubusercontent.com/p1rogram/helpdesk-ai/master/deploy/server-setup.sh | bash -s -- <domain>
# Installs Docker, clones the repo into /opt/helpdesk-ai, prepares .env and opens the firewall.
set -euo pipefail
DOMAIN="${1:?usage: server-setup.sh <domain>}"
APP_DIR=/opt/helpdesk-ai
REPO=https://github.com/p1rogram/helpdesk-ai.git

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
apt-get install -y -q git ufw >/dev/null

if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s#^DOMAIN=.*#DOMAIN=$DOMAIN#" .env
  sed -i "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=$(openssl rand -hex 16)#" .env
  sed -i "s#^JWT_SECRET=.*#JWT_SECRET=$(openssl rand -base64 32)#" .env
  sed -i "s#^AUTH_DEV_BYPASS=.*#AUTH_DEV_BYPASS=false#" .env
  sed -i "s#^OPERATOR_OPEN_ACCESS=.*#OPERATOR_OPEN_ACCESS=false#" .env
  echo ">>> .env created. Fill in ANTHROPIC_API_KEY, LLM_BASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, ADMIN_USERS:"
  echo ">>>     nano $APP_DIR/.env"
fi

ufw allow OpenSSH >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw --force enable >/dev/null
echo ">>> Done. First start:  cd $APP_DIR && docker compose up -d --build"
echo ">>> Afterwards CI/CD deploys on every push to master (see README)."
