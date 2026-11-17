#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server (e.g. Hetzner CX22). Run as root:
#   ssh root@SERVER 'bash -s' < deploy/setup.sh play.example.io https://github.com/singapaul/contrail.git
set -euo pipefail
DOMAIN="${1:?usage: setup.sh <domain> [git-url]}"
REPO="${2:-https://github.com/singapaul/contrail.git}"

apt-get update
apt-get install -y ca-certificates curl gnupg git ufw debian-keyring debian-archive-keyring apt-transport-https

# Node 22 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Caddy (official apt repo)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# App user + code
id contrail >/dev/null 2>&1 || useradd --system --home /opt/contrail --shell /usr/sbin/nologin contrail
if [ ! -d /opt/contrail/.git ]; then git clone "$REPO" /opt/contrail; fi
chown -R contrail:contrail /opt/contrail
sudo -u contrail -H bash -c 'cd /opt/contrail && npm ci --omit=dev'

# Service
sed "s|^Environment=ALLOWED_ORIGINS=.*|Environment=ALLOWED_ORIGINS=https://${DOMAIN}|" \
  /opt/contrail/deploy/contrail.service > /etc/systemd/system/contrail.service
systemctl daemon-reload
systemctl enable --now contrail

# HTTPS reverse proxy
sed "s|DOMAIN|${DOMAIN}|" /opt/contrail/deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

# Firewall
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "Done. Check: curl -s https://${DOMAIN}/health"
