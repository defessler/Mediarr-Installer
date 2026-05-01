#!/bin/bash
# ── File Permission Setup ──
#
# Sets correct permissions on all stack files.
# Safe to run multiple times.
#
# Usage:
#   bash /volume1/docker/media/setup-chmod.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Setting permissions on stack directory..."
chmod 755 "$SCRIPT_DIR"
echo "  ✔ $SCRIPT_DIR"

echo ""
echo "Setting permissions on scripts..."
for script in setup.sh setup-chmod.sh setup-folders.sh setup-firewall.sh setup-nordvpn.sh setup-validate.sh post-deploy-validate.sh; do
    if [ -f "$SCRIPT_DIR/$script" ]; then
        chmod 755 "$SCRIPT_DIR/$script"
        echo "  ✔ $script"
    fi
done

for script in migration/fix-qbit-paths.sh migration/fix-plex-paths.py indexers/setup-indexers.py indexers/setup-bazarr-providers.py setup-arr-config.py; do
    if [ -f "$SCRIPT_DIR/$script" ]; then
        chmod 755 "$SCRIPT_DIR/$script"
        echo "  ✔ $script"
    fi
done

echo ""
echo "Setting permissions on config files..."
if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
    chmod 644 "$SCRIPT_DIR/docker-compose.yml"
    echo "  ✔ docker-compose.yml"
fi

if [ -f "$SCRIPT_DIR/.env" ]; then
    chmod 600 "$SCRIPT_DIR/.env"
    echo "  ✔ .env (owner read-only — contains secrets)"
fi

if [ -f "$SCRIPT_DIR/.env.example" ]; then
    chmod 644 "$SCRIPT_DIR/.env.example"
    echo "  ✔ .env.example"
fi

echo ""
echo "Done."
