#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: $0 /path/to/bun"
  echo "Example: sudo $0 \$(which bun)"
  exit 1
fi

BUN_PATH="$(realpath "$1")"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -x "$BUN_PATH" ]; then
  echo "Error: $BUN_PATH is not executable"
  exit 1
fi

cat > /etc/systemd/system/saki.service <<EOF
[Unit]
Description=Saki CalDAV Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$BUN_PATH run $PROJECT_DIR/src/index.ts
Restart=on-failure
RestartSec=5
EnvironmentFile=$PROJECT_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable saki
systemctl restart saki

echo "Saki service installed and started."
echo "  Status: systemctl status saki"
echo "  Logs:   journalctl -u saki -f"
