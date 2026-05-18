#!/bin/bash
# ── Synology Firewall Boot Script for Media Stack ──
#
# Synology-specific — this script writes iptables rules and installs
# itself into /usr/local/etc/rc.d/ which DSM auto-runs on boot. Other
# NAS families don't use rc.d/ for boot scripts; setup.sh skips this
# step entirely on Unraid / QNAP / TrueNAS / generic Linux. There, you
# open the stack's ports in your NAS firewall UI instead.
#
# Install (run once):
#   sudo cp <INSTALL_DIR>/setup-firewall.sh /usr/local/etc/rc.d/media-firewall.sh
#   sudo chmod 755 /usr/local/etc/rc.d/media-firewall.sh
#
# Synology auto-runs scripts in /usr/local/etc/rc.d/ on every boot.
#
# Manual usage:
#   sudo /usr/local/etc/rc.d/media-firewall.sh start
#   sudo /usr/local/etc/rc.d/media-firewall.sh stop

# Derive the LAN subnet from LAN_IP in .env so rules apply on whatever
# subnet the user is actually on (192.168.0.0/24, 192.168.50.0/24,
# 10.0.0.0/8, etc.). Falls back to 192.168.1.0/24 only when .env is
# absent or unparseable — which is the historical default the wizard
# shipped with on Synology.
#
# Override by exporting LAN_SUBNET before invoking this script; that
# wins over the .env-derived value.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# When this script is installed at /usr/local/etc/rc.d/, SCRIPT_DIR is
# /usr/local/etc/rc.d which has no .env. Look up one level (where DSM
# admin installed the stack) too. Final fallback: try the historical
# Synology path.
ENV_FILE=""
for candidate in \
    "$SCRIPT_DIR/.env" \
    "/volume1/docker/media/.env" \
    "/volume1/docker/mediarr/.env"; do
    if [ -f "$candidate" ]; then ENV_FILE="$candidate"; break; fi
done
if [ -z "${LAN_SUBNET:-}" ] && [ -n "$ENV_FILE" ]; then
    LAN_IP_VAL=$(grep -m1 '^LAN_IP=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r' | xargs)
    # LAN_IP=192.168.50.42 → LAN_SUBNET=192.168.50.0/24. Mask the last
    # octet to 0 and assume /24 — covers ~all home networks. Users on
    # /16 or /8 can override LAN_SUBNET via env or .env.
    if [[ "$LAN_IP_VAL" =~ ^([0-9]+\.[0-9]+\.[0-9]+)\.[0-9]+$ ]]; then
        LAN_SUBNET="${BASH_REMATCH[1]}.0/24"
    fi
    # Honor explicit LAN_SUBNET in .env if user wrote one.
    LAN_SUBNET_OVERRIDE=$(grep -m1 '^LAN_SUBNET=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r' | xargs)
    [ -n "$LAN_SUBNET_OVERRIDE" ] && LAN_SUBNET="$LAN_SUBNET_OVERRIDE"
fi
LOCAL_SUBNET="${LAN_SUBNET:-192.168.1.0/24}"
echo "Using LAN subnet: $LOCAL_SUBNET (set LAN_SUBNET in .env to override)"

# Read ENABLE_* flag from .env. Default-on semantics match the rest of
# the toolchain — missing/empty/anything-but-false counts as enabled.
# Lookup is best-effort: when this script runs from rc.d/ at boot, the
# .env file is wherever we resolved $ENV_FILE above. If we couldn't
# resolve one, every check returns "enabled" so the firewall opens all
# ports (back-compat with pre-flag installs).
is_enabled() {
    local key="$1"
    [ -z "$ENV_FILE" ] && return 0
    local val
    val=$(grep -m1 "^$key=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r' | tr '[:upper:]' '[:lower:]' | xargs)
    case "$val" in
        false|0|no|off) return 1 ;;
        *)              return 0 ;;
    esac
}

add_rules() {
    # DSM (always open — needed to manage the NAS itself)
    iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 5000 -j ACCEPT
    iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 5002 -j ACCEPT

    # SSH
    iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 22 -j ACCEPT

    # Plex (bridge network — 32400 is the main HTTP port).
    # Discovery ports below are OPTIONAL — Plex.tv's cloud discovery
    # works without them. Open them if you want fast LAN-only client
    # auto-discovery or DLNA renderer support:
    #   32400/tcp — main HTTP API (required)
    #   32469/tcp — DLNA media server (DLNA opt-in)
    #   32410-32414/udp — Plex GDM (LAN client auto-discovery)
    # Only open ports for services the user actually enabled. Closed
    # ports for disabled services aren't reachable anyway (the listener
    # isn't bound), so the firewall rule is redundant — but pruning
    # them tightens the surface area and matches what's actually
    # running.
    if is_enabled ENABLE_PLEX; then
        iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 32400 -j ACCEPT
        iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 32469 -j ACCEPT
        iptables -I INPUT -s $LOCAL_SUBNET -p udp --dport 32410 -j ACCEPT
        iptables -I INPUT -s $LOCAL_SUBNET -p udp --dport 32412 -j ACCEPT
        iptables -I INPUT -s $LOCAL_SUBNET -p udp --dport 32413 -j ACCEPT
        iptables -I INPUT -s $LOCAL_SUBNET -p udp --dport 32414 -j ACCEPT
        # Tautulli + Seerr (ride on ENABLE_PLEX in the rest of the stack)
        iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 5056 -j ACCEPT
        iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 8181 -j ACCEPT
    fi

    if is_enabled ENABLE_SONARR; then
        iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 49152 -j ACCEPT
    fi
    if is_enabled ENABLE_RADARR; then
        iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 49151 -j ACCEPT
    fi
    if is_enabled ENABLE_LIDARR; then
        iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 49154 -j ACCEPT
    fi
    if is_enabled ENABLE_BAZARR; then
        iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 49153 -j ACCEPT
    fi
    if is_enabled ENABLE_SABNZBD; then
        iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 49155 -j ACCEPT
    fi
    if is_enabled ENABLE_QBITTORRENT; then
        iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 49156 -j ACCEPT
        # 6881 BT peer port — open from anywhere (peers come from the
        # internet through gluetun's tunnel, or via the host's bridge
        # network when VPN_ENABLED=false).
        iptables -I INPUT -p tcp --dport 6881 -j ACCEPT
        iptables -I INPUT -p udp --dport 6881 -j ACCEPT
    fi
    if is_enabled ENABLE_HOMEPAGE; then
        iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 3000 -j ACCEPT
    fi

    # Prowlarr + Flaresolverr are always-on (not profile-gated)
    iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 49150 -j ACCEPT
    iptables -I INPUT -s $LOCAL_SUBNET -p tcp --dport 8191 -j ACCEPT
}

remove_rules() {
    # DSM
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 5000 -j ACCEPT 2>/dev/null
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 5002 -j ACCEPT 2>/dev/null

    # SSH
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 22 -j ACCEPT 2>/dev/null

    # Plex (main + DLNA + GDM)
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 32400 -j ACCEPT 2>/dev/null
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 32469 -j ACCEPT 2>/dev/null
    iptables -D INPUT -s $LOCAL_SUBNET -p udp --dport 32410 -j ACCEPT 2>/dev/null
    iptables -D INPUT -s $LOCAL_SUBNET -p udp --dport 32412 -j ACCEPT 2>/dev/null
    iptables -D INPUT -s $LOCAL_SUBNET -p udp --dport 32413 -j ACCEPT 2>/dev/null
    iptables -D INPUT -s $LOCAL_SUBNET -p udp --dport 32414 -j ACCEPT 2>/dev/null

    # Sonarr
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 49152 -j ACCEPT 2>/dev/null

    # Radarr
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 49151 -j ACCEPT 2>/dev/null

    # Lidarr
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 49154 -j ACCEPT 2>/dev/null

    # Prowlarr
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 49150 -j ACCEPT 2>/dev/null

    # Bazarr
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 49153 -j ACCEPT 2>/dev/null

    # SABnzbd
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 49155 -j ACCEPT 2>/dev/null

    # qBittorrent (via Gluetun)
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 49156 -j ACCEPT 2>/dev/null
    iptables -D INPUT -p tcp --dport 6881 -j ACCEPT 2>/dev/null
    iptables -D INPUT -p udp --dport 6881 -j ACCEPT 2>/dev/null

    # Seerr
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 5056 -j ACCEPT 2>/dev/null

    # Tautulli
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 8181 -j ACCEPT 2>/dev/null

    # Homepage dashboard
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 3000 -j ACCEPT 2>/dev/null

    # Flaresolverr
    iptables -D INPUT -s $LOCAL_SUBNET -p tcp --dport 8191 -j ACCEPT 2>/dev/null
}

RC_SCRIPT=/usr/local/etc/rc.d/media-firewall.sh

install_to_rcd() {
    local source
    source="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
    if [ ! -f "$RC_SCRIPT" ] || ! diff -q "$source" "$RC_SCRIPT" &>/dev/null; then
        cp "$source" "$RC_SCRIPT"
        chmod 755 "$RC_SCRIPT"
        echo "  ✔ Installed to $RC_SCRIPT (rules will apply on every reboot)"
    else
        echo "  ✔ rc.d script already up to date"
    fi
}

case "$1" in
    stop)
        echo "Removing media stack firewall rules..."
        remove_rules
        echo "Done."
        ;;
    *)
        # Default to start (covers both explicit 'start' and boot — Synology calls without args)
        # Always remove first so re-running never creates duplicate rules
        echo "Applying media stack firewall rules..."
        remove_rules
        add_rules
        echo "  ✔ Firewall rules applied."

        # Also install to rc.d so rules survive reboots (idempotent — safe to re-run)
        install_to_rcd
        ;;
esac
