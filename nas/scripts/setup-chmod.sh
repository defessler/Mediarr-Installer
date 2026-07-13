#!/bin/bash
# ── File Permission Setup ──
#
# Sets correct permissions on all stack files. Path-agnostic — uses
# $SCRIPT_DIR (where this script lives) for sibling scripts and
# $INSTALL_DIR (the compose root) for top-level files like
# docker-compose.yml and .env. Works wherever the wizard installed
# the stack: Synology /volume1/docker/media, Unraid /mnt/user/appdata/
# mediarr, QNAP /share/Container/mediarr, etc.
# Safe to run multiple times.
#
# Usage:
#   bash <INSTALL_DIR>/scripts/setup-chmod.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Compose root = scripts/ parent in the new layout, or SCRIPT_DIR
# itself in legacy loose-scripts installs.
if [ "$(basename "$SCRIPT_DIR")" = "scripts" ]; then
    INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    INSTALL_DIR="$SCRIPT_DIR"
fi

echo "Setting permissions on stack directory..."
chmod 755 "$INSTALL_DIR"
echo "  ✔ $INSTALL_DIR"
if [ "$INSTALL_DIR" != "$SCRIPT_DIR" ]; then
    chmod 755 "$SCRIPT_DIR"
    echo "  ✔ $SCRIPT_DIR"
fi

echo ""
echo "Setting permissions on scripts..."
# Core setup scripts — run by setup.sh in order.
for script in setup.sh setup-chmod.sh setup-folders.sh relocate-stack.sh setup-firewall.sh diagnose-firewall.sh setup-nordvpn.sh setup-validate.sh post-deploy-validate.sh; do
    if [ -f "$SCRIPT_DIR/$script" ]; then
        chmod 755 "$SCRIPT_DIR/$script"
        echo "  ✔ $script"
    fi
done

# Helper scripts — user-invoked from CLI or Task Scheduler.
for script in restart-qbit.sh recyclarr-sync.sh fix-imports.sh tune-arrs.sh stop-all.sh boot-orchestrator.sh install-boot-resilience.sh qbit-guardian.sh; do
    if [ -f "$SCRIPT_DIR/$script" ]; then
        chmod 755 "$SCRIPT_DIR/$script"
        echo "  ✔ $script"
    fi
done

# Python scripts + migration tools. Migration tools live at INSTALL_DIR/
# migration/ regardless of layout (legacy or new) — they're separate
# from the scripts/ subfolder.
for script in indexers/setup-indexers.py indexers/setup-bazarr-providers.py setup-arr-config.py setup-dispatcharr.py recyclarr-trigger.py auto-manual-import.py; do
    if [ -f "$SCRIPT_DIR/$script" ]; then
        chmod 755 "$SCRIPT_DIR/$script"
        echo "  ✔ $script"
    fi
done
for script in migration/fix-qbit-paths.sh migration/fix-plex-paths.py; do
    if [ -f "$INSTALL_DIR/$script" ]; then
        chmod 755 "$INSTALL_DIR/$script"
        echo "  ✔ $script"
    fi
done

echo ""
echo "Setting permissions on config files..."
# v0.3.23+ puts docker-compose.* + .env under SCRIPT_DIR; v0.3.22 had
# them at INSTALL_DIR root. Loop both directories so this works in
# either layout — chmod is idempotent and only fails on missing files.
for cfg_dir in "$SCRIPT_DIR" "$INSTALL_DIR"; do
    [ -z "$cfg_dir" ] && continue
    if [ -f "$cfg_dir/docker-compose.yml" ]; then
        chmod 644 "$cfg_dir/docker-compose.yml"
        echo "  ✔ $cfg_dir/docker-compose.yml"
    fi
    if [ -f "$cfg_dir/docker-compose.no-vpn.yml" ]; then
        chmod 644 "$cfg_dir/docker-compose.no-vpn.yml"
        echo "  ✔ $cfg_dir/docker-compose.no-vpn.yml"
    fi
    if [ -f "$cfg_dir/docker-compose.test-override.yml" ]; then
        chmod 644 "$cfg_dir/docker-compose.test-override.yml"
        echo "  ✔ $cfg_dir/docker-compose.test-override.yml"
    fi
    if [ -f "$cfg_dir/.env" ]; then
        chmod 600 "$cfg_dir/.env"
        echo "  ✔ $cfg_dir/.env (owner read-only — contains secrets)"
    fi
    if [ -f "$cfg_dir/.env.example" ]; then
        chmod 644 "$cfg_dir/.env.example"
        echo "  ✔ $cfg_dir/.env.example"
    fi
    if [ -f "$cfg_dir/INDEXERS.md" ]; then
        chmod 644 "$cfg_dir/INDEXERS.md"
        echo "  ✔ $cfg_dir/INDEXERS.md"
    fi
    [ "$cfg_dir" = "$SCRIPT_DIR" ] && [ "$INSTALL_DIR" = "$SCRIPT_DIR" ] && break
done

# Re-assert 600 on qBittorrent.conf — it holds the PBKDF2 WebUI password hash
# (same secret class as .env, which is 600 above). setup-folders.sh writes it
# 600, but an older install may have left it world-readable, and qBittorrent
# itself rewrites the file at runtime with its own mode; this idempotent
# re-run pins it back down.
QB_CONF="$INSTALL_DIR/qbittorrent/config/qBittorrent/qBittorrent.conf"
if [ -f "$QB_CONF" ]; then
    chmod 600 "$QB_CONF"
    echo "  ✔ $QB_CONF (owner read-only — contains the WebUI password hash)"
fi

echo ""
echo "Done."
