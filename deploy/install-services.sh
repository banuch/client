#!/usr/bin/env bash
# =============================================================================
#  install-services.sh  --  run both AMR servers as systemd services
#
#    sudo ./deploy/install-services.sh
#
#  Creates the "amr" system user, gives it the servers' data/ and .env, installs
#  amr-ota.service and amr-dlms.service with this repository's path and the
#  node found in PATH, then enables and starts them. Safe to run again after
#  a git pull (it restarts the services).
# =============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "node not found in PATH. Install Node.js 18-22 first." >&2
  exit 1
fi
# nvm installs under /root are not readable by the amr user.
case "$NODE" in
  /root/*) echo "node is under /root ($NODE); install it system-wide (e.g. NodeSource) so user amr can run it." >&2; exit 1 ;;
esac

for dir in ota_server dlms_server; do
  if [ ! -f "$REPO/$dir/.env" ]; then
    echo "Missing $REPO/$dir/.env -- copy $dir/.env.example to .env and edit it first." >&2
    exit 1
  fi
  if [ ! -d "$REPO/$dir/node_modules" ]; then
    echo "Installing $dir dependencies"
    (cd "$REPO/$dir" && npm ci --omit=dev --no-audit --no-fund)
  fi
  mkdir -p "$REPO/$dir/data"
done

id amr >/dev/null 2>&1 || useradd --system --no-create-home --home-dir "$REPO" --shell /usr/sbin/nologin amr
# amr only reads the code; it owns just what it writes. The rest stays with
# root, so "git pull" as root keeps working.
for dir in ota_server dlms_server; do
  chown -R amr:amr "$REPO/$dir/data"
  chown amr:amr "$REPO/$dir/.env"
  chmod 600 "$REPO/$dir/.env"
done

for unit in amr-ota amr-dlms; do
  sed -e "s|/opt/client|$REPO|g" -e "s|/usr/bin/node|$NODE|g" \
    "$REPO/deploy/$unit.service" > "/etc/systemd/system/$unit.service"
done

systemctl daemon-reload
systemctl enable amr-ota amr-dlms
systemctl restart amr-ota amr-dlms
sleep 2
systemctl --no-pager --lines=5 status amr-ota amr-dlms || true

echo
echo "Logs:    journalctl -u amr-ota -f    journalctl -u amr-dlms -f"
echo "Check:   curl http://localhost:7000/health && (cd $REPO/dlms_server && npm run check)"
