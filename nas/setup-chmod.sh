#!/bin/bash
# ── File Permission Setup ──
#
# Sets correct permissions on all stack files. Path-agnostic — uses
# $SCRIPT_DIR (where this script lives) for everything, so it works
# wherever the wizard installed the stack: Synology /volume1/docker/media,
# Unraid /mnt/user/appdata/mediarr, QNAP /share/Container/mediarr, etc.
# Safe to run multiple times.
#
# Usage:
#   bash <INSTALL_DIR>/setup-chmod.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Setting permissions on stack directory..."
chmod 755 "$SCRIPT_DIR"
echo "  ✔ $SCRIPT_DIR"

echo ""
echo "Setting permissions on scripts..."
# Core setup scripts — run by setup.sh in order.
for script in setup.sh setup-chmod.sh setup-folders.sh setup-firewall.sh setup-nordvpn.sh setup-validate.sh post-deploy-validate.sh; do
    if [ -f "$SCRIPT_DIR/$script" ]; then
        chmod 755 "$SCRIPT_DIR/$script"
        echo "  ✔ $script"
    fi
done

# Helper scripts — user-invoked from CLI or Task Scheduler.
for script in restart-qbit.sh recyclarr-sync.sh fix-imports.sh tune-arrs.sh stop-all.sh boot-orchestrator.sh; do
    if [ -f "$SCRIPT_DIR/$script" ]; then
        chmod 755 "$SCRIPT_DIR/$script"
        echo "  ✔ $script"
    fi
done

# Python scripts + migration tools.
for script in migration/fix-qbit-paths.sh migration/fix-plex-paths.py indexers/setup-indexers.py indexers/setup-bazarr-providers.py setup-arr-config.py recyclarr-trigger.py; do
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
