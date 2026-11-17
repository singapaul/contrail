#!/usr/bin/env bash
# Deploy the latest main to the server. Players get a "Server updating" notice and reconnect by themselves.
#   ./deploy/deploy.sh root@SERVER
set -euo pipefail
HOST="${1:?usage: deploy.sh user@server}"
ssh "$HOST" 'set -e
  cd /opt/contrail
  sudo -u contrail git pull --ff-only
  sudo -u contrail -H npm ci --omit=dev
  systemctl restart contrail
  sleep 2
  curl -fsS localhost:3000/health; echo'
