#!/bin/bash
# ── diagnose-firewall.sh — family-aware firewall TRIAGE (read-only) ──
#
# Answers the question "a dashboard loads on the NAS but not from my laptop —
# is a firewall blocking it?" honestly, for non-Synology hosts.
#
# The key fact most firewall advice gets wrong: this stack runs in Docker, and
# Docker publishes its ${LAN_IP}:host:container ports via DNAT + the FORWARD /
# DOCKER-USER chain — they BYPASS the host INPUT chain. So a default-deny ufw /
# iptables / nftables INPUT firewall does NOT block these dashboards, and
# "opening" the ports on INPUT changes nothing. The only host-level place that
# can actually block a published port is Docker's DOCKER-USER (FORWARD) chain,
# which users rarely touch — so the usual real cause is upstream (router / AP
# client isolation). This script reflects that reality instead of nagging about
# INPUT, and prints the few commands that are actually correct for your host.
#
# SAFE BY DESIGN: it NEVER modifies, creates, enables, reloads, or deletes any
# firewall rule. It only READS firewall state and PRINTS commands you can choose
# to run yourself. On Synology DSM the wizard manages iptables via
# setup-firewall.sh, so this defers to that and exits.
#
# Run any time (e.g. if a dashboard won't load from another device):
#   sudo bash diagnose-firewall.sh
#
# setup.sh wires this into its firewall step on non-DSM platforms.

set -uo pipefail

# ── Resolve layout + .env (mirrors setup-firewall.sh) ──────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [ "$(basename "$SCRIPT_DIR")" = "scripts" ]; then
    INSTALL_DIR_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    INSTALL_DIR_DEFAULT="$SCRIPT_DIR"
fi
ENV_FILE=""
for candidate in \
    "$INSTALL_DIR_DEFAULT/.env" \
    "$SCRIPT_DIR/.env" \
    "/volume1/docker/media/.env" \
    "/volume1/docker/mediarr/.env"; do
    if [ -f "$candidate" ]; then ENV_FILE="$candidate"; break; fi
done

# ── Output helpers (match setup-validate.sh's glyph style) ─────────────────────
section() { echo ""; echo "── $1 ──────────────────────────────────────────"; }
ok()   { echo "  ✔ $1"; }
warn() { echo "  ⚠ $1"; }
info() { echo "  ℹ $1"; }
cmd()  { echo "      $1"; }   # an indented copy-paste command

# ── Read a single .env value / flag (default-on semantics, like the rest) ──────
env_val() {
    [ -n "$ENV_FILE" ] || { echo ""; return; }
    grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | sed 's/#.*//' | tr -d '\r' | xargs
}
is_enabled() {
    local val
    [ -z "$ENV_FILE" ] && return 0
    val=$(env_val "$1" | tr '[:upper:]' '[:lower:]')
    case "$val" in false|0|no|off) return 1 ;; *) return 0 ;; esac
}

MEDIA_SERVER="$(env_val MEDIA_SERVER | tr '[:upper:]' '[:lower:]')"
[ "$MEDIA_SERVER" = jellyfin ] || MEDIA_SERVER="plex"

# VPN on/off — matches restart-qbit.sh semantics (missing/empty → off). Decides
# whether qBittorrent's 6881 peer port is published on the host (no-vpn) or rides
# inside gluetun's tunnel (vpn → not host-published).
case "$(env_val VPN_ENABLED | tr '[:upper:]' '[:lower:]')" in true|1|yes|on) VPN_ON=1 ;; *) VPN_ON=0 ;; esac

LAN_IP="$(env_val LAN_IP)"
# Derive the LAN subnet from LAN_IP (192.168.50.42 → 192.168.50.0/24); honour an
# explicit LAN_SUBNET. Same logic + fallback as setup-firewall.sh.
LAN_SUBNET="${LAN_SUBNET:-}"
if [ -z "$LAN_SUBNET" ]; then
    if [[ "$LAN_IP" =~ ^([0-9]+\.[0-9]+\.[0-9]+)\.[0-9]+$ ]]; then
        LAN_SUBNET="${BASH_REMATCH[1]}.0/24"
    fi
    _sub_override="$(env_val LAN_SUBNET)"
    [ -n "$_sub_override" ] && LAN_SUBNET="$_sub_override"
fi
LAN="${LAN_SUBNET:-192.168.1.0/24}"
[ -n "$LAN_IP" ] || LAN_IP="your-nas-ip"

# ── Light NAS-family detection (read-only marker files; for tailored UI hints) ─
detect_family() {
    if   [ -f /etc/synoinfo.conf ]; then echo synology
    elif [ -f /etc/unraid-version ]; then echo unraid
    elif [ -f /etc/config/qpkg.conf ] || [ -d /share/CACHEDEV1_DATA ]; then echo qnap
    elif [ -f /etc/openmediavault/config.xml ]; then echo omv
    elif grep -qiE 'ugreen|ugos' /etc/os-release 2>/dev/null; then echo ugreen
    else echo linux
    fi
}
FAMILY="$(detect_family)"

echo ""
echo "════ Firewall triage ════"

# ── Synology defers to the wizard's own iptables manager ───────────────────────
if [ "$FAMILY" = synology ]; then
    info "Synology DSM detected — the wizard manages the firewall for you via"
    info "setup-firewall.sh (and DSM Control Panel → Security → Firewall)."
    info "Nothing to open here."
    exit 0
fi

[ -n "$ENV_FILE" ] || info "No .env found — assuming all services enabled and LAN $LAN. Run from your install dir (or pass LAN_SUBNET) for tailored output."

# ── Build the set of enabled LAN-facing ports (label + number) ─────────────────
# Source of truth: docker-compose.yml's ${LAN_IP}:host:container bindings, gated
# by the same ENABLE_*/MEDIA_SERVER flags the stack uses. recyclarr-trigger
# (8889) is always-on (no compose profile) so it is listed unconditionally.
PORTS_TCP=""        # space-joined numbers (for the firewalld recipe)
PORTS_LABELED=""    # newline-joined "PORT  Label" (for display)
_add() {            # _add <port> <label>
    PORTS_TCP="$PORTS_TCP $1"
    PORTS_LABELED="$PORTS_LABELED
      $1  $2"
}
if is_enabled ENABLE_PLEX; then
    if [ "$MEDIA_SERVER" = jellyfin ]; then
        _add 8096 "Jellyfin"
    else
        _add 32400 "Plex"
        _add 8181 "Tautulli"
    fi
    _add 5056 "Seerr / Jellyseerr"
fi
_add 49150 "Prowlarr"
is_enabled ENABLE_FLARESOLVERR && _add 8191 "FlareSolverr"
is_enabled ENABLE_SONARR       && _add 49152 "Sonarr"
is_enabled ENABLE_RADARR       && _add 49151 "Radarr"
is_enabled ENABLE_BAZARR       && _add 49153 "Bazarr"
is_enabled ENABLE_LIDARR       && _add 49154 "Lidarr"
is_enabled ENABLE_SABNZBD      && _add 49155 "SABnzbd"
is_enabled ENABLE_QBITTORRENT  && _add 49156 "qBittorrent"
is_enabled ENABLE_HOMEPAGE     && _add 3000 "Homepage"
_add 8889 "Recyclarr trigger"
PORTS_TCP="$(echo "$PORTS_TCP" | xargs)"
PORTS_FWD=""; for _p in $PORTS_TCP; do PORTS_FWD="$PORTS_FWD --add-port=$_p/tcp"; done
PORTS_FWD="$(echo "$PORTS_FWD" | xargs)"

# ── Root check — the state probes below need CAP_NET_ADMIN to be reliable ──────
ROOT=1; [ "$(id -u 2>/dev/null || echo 0)" -eq 0 ] || ROOT=0
[ "$ROOT" -eq 1 ] || warn "Not running as root — detection is best-effort; re-run with: sudo bash $SCRIPT_DIR/$(basename "$0")"

# ── Container runtime + the one host-level chain that can block a published port ─
# Docker seeds DOCKER-USER with a lone RETURN; any DROP/REJECT there is a
# user-added restriction that CAN block LAN access to the stack. Podman has no
# such chain (it uses netavark/CNI), so we only assert the Docker specifics.
RT=""
command -v docker >/dev/null 2>&1 && RT="docker"
[ -z "$RT" ] && command -v podman >/dev/null 2>&1 && RT="podman"
HAS_DOCKER_USER=0; DOCKER_USER_BLOCKS=0
if command -v iptables >/dev/null 2>&1 && iptables -nL DOCKER-USER >/dev/null 2>&1; then
    HAS_DOCKER_USER=1
    # Anchor on the target column (iptables -nL left-justifies it) so a rule whose
    # /* comment */ merely contains the word DROP/REJECT can't false-trigger this.
    iptables -nL DOCKER-USER 2>/dev/null | grep -Eq '^(DROP|REJECT)[[:space:]]' && DOCKER_USER_BLOCKS=1
fi

# Active host firewall front-ends — informational, for the caveats below.
UFW_ACTIVE=0;  command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -qi 'Status: active' && UFW_ACTIVE=1
FWLD_ACTIVE=0; command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state 2>/dev/null | grep -qi running && FWLD_ACTIVE=1

# ── Report: the stack's LAN ports ──────────────────────────────────────────────
section "Your stack's LAN ports (bound to $LAN_IP)"
info "These dashboards/services are published on your LAN:$PORTS_LABELED"

# ── Report: does a host firewall actually block them? ──────────────────────────
section "Can a host firewall block these?"
if [ "$HAS_DOCKER_USER" -eq 1 ]; then
    info "Your stack runs in Docker. Docker publishes these ports through DNAT + the"
    info "FORWARD/DOCKER-USER chain, which BYPASSES the host INPUT chain — so a"
    info "default-deny ufw / iptables / nftables INPUT firewall does NOT block your"
    info "dashboards, and 'allowing' them on INPUT would change nothing."
    if [ "$DOCKER_USER_BLOCKS" -eq 1 ]; then
        echo ""
        warn "Your DOCKER-USER chain DOES contain DROP/REJECT rules — that CAN block LAN"
        warn "  access to the stack. Inspect them, then allow your LAN above them:"
        cmd "sudo iptables -nL DOCKER-USER --line-numbers          # read your rules first"
        cmd "sudo iptables -I DOCKER-USER -s $LAN -j ACCEPT          # allow your LAN to reach the stack"
        info "Persist it the way you already persist iptables rules — note that a full"
        info "  ruleset save can collide with Docker re-creating its own chains at boot."
    else
        ok "DOCKER-USER has no DROP/REJECT rules — nothing at the host firewall level is"
        ok "  blocking your stack. (Confirm yourself: sudo iptables -nL DOCKER-USER)"
    fi
elif [ "$RT" = podman ]; then
    info "Your stack runs under Podman, which publishes ports via netavark/CNI and"
    info "also routes them around the host INPUT chain — a default-deny INPUT firewall"
    info "usually does not block them. If a dashboard is unreachable, check Podman's"
    info "forward rules (sudo iptables -nL / nft list ruleset) and the network below."
else
    info "Containers publish ports via DNAT/forwarding, which bypasses the host INPUT"
    info "chain — so a default-deny INPUT firewall usually does not block them. If a"
    info "dashboard is unreachable, the cause is almost always the network, below."
fi

# ── Front-end caveats (only when actually active) ──────────────────────────────
if [ "$UFW_ACTIVE" -eq 1 ]; then
    section "ufw is active — but it is rarely the cause"
    info "ufw does NOT filter Docker-published ports by default (Docker inserts its"
    info "FORWARD rules below ufw's INPUT rules). So you do NOT need 'ufw allow ...'"
    info "to reach the stack, and disabling ufw will not help. Leave ufw as-is."
fi
if [ "$FWLD_ACTIVE" -eq 1 ]; then
    section "firewalld is running"
    info "Some firewalld versions police forwarded/Docker traffic. If DOCKER-USER is"
    info "clean (above) and a dashboard is still unreachable, try allowing the ports"
    info "in the zone serving your LAN, then reload:"
    cmd "sudo firewall-cmd --permanent $PORTS_FWD"
    cmd "sudo firewall-cmd --reload"
fi

# ── qBittorrent peer port 6881 — only host-published when VPN is off ───────────
if is_enabled ENABLE_QBITTORRENT && [ "$VPN_ON" -eq 0 ]; then
    section "qBittorrent peer port (6881)"
    info "VPN is off, so qBittorrent publishes 6881 (TCP+UDP) on the host for incoming"
    info "peers. For best connectability, forward 6881 on your ROUTER to $LAN_IP — a"
    info "host firewall rule is not needed (it's Docker-published, like the dashboards)."
elif is_enabled ENABLE_QBITTORRENT; then
    info "qBittorrent peer traffic rides inside the VPN tunnel (VPN on) — no host port"
    info "to open for 6881."
fi

# ── The usual real cause: the network between your devices ─────────────────────
section "Most common real cause: router / network"
info "Since the host firewall rarely blocks Docker-published ports, if a dashboard"
info "won't load from another device the cause is usually upstream:"
info "  • Router/AP 'client isolation' (a.k.a. AP/guest isolation) — turn it OFF."
info "  • Wrong address — browse to the NAS LAN IP ($LAN_IP), not localhost/hostname."
info "  • The container isn't actually up — check:  ${RT:-docker} ps"
case "$FAMILY" in
    unraid) info "  • Unraid: any firewall plugin you added (most setups have none)." ;;
    qnap)   info "  • QNAP QTS: Control Panel → Security → Allow/Deny List." ;;
    omv)    info "  • OpenMediaVault: no firewall by default — check any ufw/firewalld you added." ;;
    ugreen) info "  • UGREEN UGOS runs Debian underneath — the Docker/host notes above apply." ;;
    *)      info "  • Any external firewall (router ACLs, OPNsense/pfSense) between devices." ;;
esac
info "Verify a port is listening on the NAS (swap the number):"
cmd "sudo ss -tlnp | grep ':32400'        # or your service's port"
echo ""

# Guidance only — never let a probe hiccup fail the caller's step.
exit 0
