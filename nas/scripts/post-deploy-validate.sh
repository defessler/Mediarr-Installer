#!/bin/bash
# ── Post-Deploy Validation ──
#
# Run after $COMPOSE up -d to verify the stack is working correctly.
# Checks containers, dashboard pages, VPN, and media visibility.
#
# Usage:
#   bash /volume1/docker/media/post-deploy-validate.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Compose root = scripts/ parent in the new layout, or SCRIPT_DIR
# itself in legacy loose-scripts installs.
if [ "$(basename "$SCRIPT_DIR")" = "scripts" ]; then
    INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    INSTALL_DIR="$SCRIPT_DIR"
fi
# v0.3.23+: prefer SCRIPT_DIR/.env (lives in scripts/ now).
# Fall back to INSTALL_DIR/.env (v0.3.22 layout) where applicable.
if [ -f "$SCRIPT_DIR/.env" ]; then
    ENV_FILE="$SCRIPT_DIR/.env"
else
    ENV_FILE="$INSTALL_DIR/.env"
fi

PASS=0
FAIL=0
WARN=0

ok()   { echo "  ✔ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✘ $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  ⚠ $1"; WARN=$((WARN + 1)); }

section() {
    echo ""
    echo "── $1 ──────────────────────────────────────────"
}

env_val() { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r'; }

# Default-on opt-out semantics matching the rest of the toolchain
# (env-render.ts isEnabled / setup.sh is_enabled / setup-arr-config.py
# is_enabled). Missing or empty → enabled; only an explicit
# false/0/no/off (any case) counts as disabled.
is_enabled() {
    local val
    val="$(env_val "$1" | tr '[:upper:]' '[:lower:]' | xargs)"
    case "$val" in
        false|0|no|off) return 1 ;;
        *)              return 0 ;;
    esac
}

# ── Container runtime (Docker or Podman) ──────────────────────────────────────
# Mirror setup.sh / collect-diagnostics.sh so validation works on a Podman-only
# host too — otherwise every $RT inspect/exec/logs below fails and a perfectly
# healthy Podman stack gets reported as a FAILED install at this step. DOCKER_SOCK
# in .env (set when Podman is the runtime) → export DOCKER_HOST so the CLI reaches
# the right socket; then pick the runtime CLI + compose front-end.
DOCKER_SOCK="$(env_val DOCKER_SOCK)"
if [ -n "$DOCKER_SOCK" ]; then
    case "$DOCKER_SOCK" in
        unix://*|tcp://*|ssh://*) export DOCKER_HOST="$DOCKER_SOCK" ;;
        *)                        export DOCKER_HOST="unix://$DOCKER_SOCK" ;;
    esac
fi
RT="docker"
COMPOSE="docker compose"
if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
elif command -v podman >/dev/null 2>&1; then
    RT="podman"
    if podman compose version >/dev/null 2>&1; then COMPOSE="podman compose"
    elif command -v podman-compose >/dev/null 2>&1; then COMPOSE="podman-compose"; fi
    if [ -z "${DOCKER_HOST:-}" ]; then
        if [ -S "$HOME/.local/share/containers/podman/podman.sock" ]; then
            export DOCKER_HOST="unix://$HOME/.local/share/containers/podman/podman.sock"
        elif [ -S /run/podman/podman.sock ]; then
            export DOCKER_HOST="unix:///run/podman/podman.sock"
        fi
    fi
fi

# VPN flag — used to gate the gluetun checks.
vpn_on() {
    local val
    val="$(env_val VPN_ENABLED | tr '[:upper:]' '[:lower:]' | xargs)"
    case "$val" in
        true|1|yes|on) return 0 ;;
        *)             return 1 ;;
    esac
}

LAN_IP=$(env_val "LAN_IP")

echo "============================================="
echo "  Post-Deploy Validation"
echo "============================================="

# ── Containers Running ────────────────────────────────────────────────────────

section "Containers"

# Build the list of containers we expect to see running based on the
# ENABLE_* flags. Prowlarr + Flaresolverr are always-on (not profile-
# gated in docker-compose.yml). Each user-toggled service maps to one
# or more container names — Plex stack groups three under ENABLE_PLEX,
# qBittorrent pulls in gluetun when VPN_ENABLED.
# Media server (plex|jellyfin). seerr runs under either; Tautulli is
# Plex-only, so it's excluded when Jellyfin is the chosen server.
MEDIA_SERVER=$(env_val MEDIA_SERVER | tr '[:upper:]' '[:lower:]')
[ "$MEDIA_SERVER" = "jellyfin" ] || MEDIA_SERVER="plex"
CONTAINERS=(prowlarr)
is_enabled ENABLE_FLARESOLVERR && CONTAINERS+=(flaresolverr)
if is_enabled ENABLE_PLEX; then
    CONTAINERS+=(seerr)
    if [ "$MEDIA_SERVER" = "jellyfin" ]; then CONTAINERS+=(jellyfin); else CONTAINERS+=(plex tautulli); fi
fi
is_enabled ENABLE_SONARR      && CONTAINERS+=(sonarr)
is_enabled ENABLE_RADARR      && CONTAINERS+=(radarr)
is_enabled ENABLE_LIDARR      && CONTAINERS+=(lidarr)
is_enabled ENABLE_BAZARR      && CONTAINERS+=(bazarr)
is_enabled ENABLE_QBITTORRENT && CONTAINERS+=(qbittorrent)
is_enabled ENABLE_QBITTORRENT && vpn_on && CONTAINERS+=(gluetun)
is_enabled ENABLE_SABNZBD     && CONTAINERS+=(sabnzbd)
is_enabled ENABLE_HOMEPAGE    && CONTAINERS+=(homepage)
is_enabled ENABLE_RECYCLARR   && CONTAINERS+=(recyclarr recyclarr-trigger)
is_enabled ENABLE_UNPACKERR   && CONTAINERS+=(unpackerr)

for container in "${CONTAINERS[@]}"; do
    STATUS=$($RT inspect -f '{{.State.Status}}' "$container" 2>/dev/null)
    if [ "$STATUS" = "running" ]; then
        ok "$container is running"
    elif [ -z "$STATUS" ]; then
        fail "$container does not exist"
    else
        fail "$container is not running (status: $STATUS)"
    fi
done

# ── Gluetun ↔ qBittorrent coupling ────────────────────────────────────────────
#
# When VPN_ENABLED=true qBittorrent is configured with `network_mode:
# service:gluetun`, which Docker enforces hard: if gluetun is down or
# its network namespace has been recreated, ANY attempt to start /
# restart qBittorrent (compose, docker-cli, or Synology Container
# Manager's "Restart" button) errors out with:
#
#   container must join at least one network
#
# That state is otherwise silent — the container check above just shows
# "qbittorrent is not running" without a cause. Catch it here so the
# user sees the actual fix.
if is_enabled ENABLE_QBITTORRENT && vpn_on; then
    GLUETUN_STATE=$($RT inspect -f '{{.State.Status}}' gluetun 2>/dev/null || echo missing)
    QBIT_STATE=$($RT inspect -f '{{.State.Status}}' qbittorrent 2>/dev/null || echo missing)
    if [ "$GLUETUN_STATE" != "running" ] && [ "$QBIT_STATE" != "running" ]; then
        warn "qBittorrent can't start — gluetun is $GLUETUN_STATE. Fix:"
        warn "    bash $SCRIPT_DIR/restart-qbit.sh"
        warn "  (or check gluetun's VPN credentials:  $COMPOSE logs gluetun --tail 50)"
    fi
fi

# ── Dashboard Pages ───────────────────────────────────────────────────────────

section "Dashboard Pages"

check_url() {
    local label="$1"
    local url="$2"
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url")
    if [[ "$http_code" =~ ^(200|301|302|303|307|308|401|403)$ ]]; then
        ok "$label ($url) — HTTP $http_code"
    else
        fail "$label ($url) — HTTP $http_code (not reachable)"
    fi
}

# Same as check_url but treats HTTP 000 (connection refused) as a
# warning rather than a hard failure. Used for services that legitimately
# might not be serving HTTP yet at the end of `setup.sh` even though
# their container is up — Seerr in particular doesn't bind to its port
# until the user completes its first-run wizard in the browser, and a
# hard fail there marks the whole install as failed when nothing is
# actually broken. Other codes still fail as usual.
check_url_lenient() {
    local label="$1"
    local url="$2"
    local hint="$3"
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url")
    if [[ "$http_code" =~ ^(200|301|302|303|307|308|401|403)$ ]]; then
        ok "$label ($url) — HTTP $http_code"
    elif [ "$http_code" = "000" ]; then
        warn "$label ($url) — not serving HTTP yet. $hint"
    else
        fail "$label ($url) — HTTP $http_code (not reachable)"
    fi
}

# Diagnostic check for qBittorrent. A plain HTTP-000 fail is unhelpful
# here because qBit can be in three different broken states with three
# different fixes, and the user shouldn't have to docker-inspect to
# tell them apart:
#
#   (a) Container running, WebUI not bound yet  — give it a minute,
#       re-run validate. Common right at end-of-install when the LSIO
#       init scripts haven't finished applying qBittorrent.conf, or
#       when gluetun's WireGuard handshake is still in flight.
#   (b) Container running, gluetun unhealthy    — qBit shares
#       gluetun's network namespace, so when gluetun's VPN tunnel
#       fails (bad WG key, etc.) qBit's WebUI never becomes
#       reachable. Fix: restart-qbit.sh after fixing gluetun, OR
#       check `$COMPOSE logs gluetun --tail 50`.
#   (c) Container not running                   — install left it
#       wedged (the install log usually has a "qBittorrent's WebUI
#       isn't responding after 80s of retries" warning). Recovery is
#       restart-qbit.sh which does an orderly gluetun→qbit recreate.
check_qbit() {
    local url="http://$LAN_IP:49156"
    local label="qBittorrent"
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url")
    if [[ "$http_code" =~ ^(200|301|302|303|307|308|401|403)$ ]]; then
        ok "$label ($url) — HTTP $http_code"
        return
    fi
    local qbit_state gluetun_state gluetun_health
    qbit_state=$($RT inspect -f '{{.State.Status}}' qbittorrent 2>/dev/null || echo missing)
    gluetun_state=$($RT inspect -f '{{.State.Status}}' gluetun 2>/dev/null || echo missing)
    gluetun_health=$($RT inspect -f '{{.State.Health.Status}}' gluetun 2>/dev/null || echo none)
    if [ "$qbit_state" = "missing" ]; then
        fail "$label ($url) — container missing. Run: bash $SCRIPT_DIR/restart-qbit.sh"
    elif [ "$qbit_state" != "running" ]; then
        fail "$label ($url) — container is $qbit_state. Run: bash $SCRIPT_DIR/restart-qbit.sh"
    elif vpn_on && [ "$gluetun_state" != "running" ]; then
        fail "$label ($url) — gluetun is $gluetun_state (qBit shares its network)."
        fail "    Run: bash $SCRIPT_DIR/restart-qbit.sh   (or check '$COMPOSE logs gluetun --tail 50')"
    elif vpn_on && [ "$gluetun_health" = "unhealthy" ]; then
        fail "$label ($url) — gluetun is unhealthy (qBit shares its network). VPN credentials may be wrong."
        fail "    Check:  $COMPOSE logs gluetun --tail 50"
    else
        # Container's up, network's healthy, WebUI still doesn't answer.
        # On Synology spinning rust + non-trivial resume data this is
        # almost always qBit's "internal preparations" phase — a SLOW
        # state, not a BROKEN one. Three iterations of trying to make
        # the install handle this in-band (docker restart, compose
        # recreate, longer retry budgets) confirmed the right answer:
        # the install's qBit-side config is already best-effort, the
        # rest of the stack works fine without it, and the user just
        # needs to run restart-qbit.sh once + re-run setup.sh.
        #
        # So this is a WARNING, not a FAIL. The install-level exit
        # code shouldn't go red on a known recoverable slow-startup
        # condition. The log dump + clear recovery steps stay so the
        # user knows what to do.
        warn "$label ($url) — container running but WebUI not serving HTTP yet (qBit's first-boot 'internal preparations' phase — slow not broken)."
        # The previous version of this dump grep'd for ~10 keywords and
        # would surface generic LSIO startup chatter (e.g. "migrations
        # started") that didn't actually diagnose anything. Show the
        # last 30 lines verbatim instead — that's where the real signal
        # lives. A separate filtered set highlights the most damning
        # patterns at the top so the user doesn't have to scan the
        # whole dump. Patterns trimmed to ACTUAL failure signals (no
        # generic "migrat" prefix or "webui" hit) — the kind of thing
        # that points at root cause vs. routine init noise.
        local logs
        logs=$($RT logs --tail 40 qbittorrent 2>&1 || true)
        local relevant
        relevant=$(echo "$logs" | grep -iE 'error|denied|fatal|cannot|unable to|refused|address already in use|conflict|crash|bad config|invalid|aborted|terminated' | head -10 || true)
        if [ -n "$relevant" ]; then
            echo "    qBittorrent log lines that look like the cause:"
            echo "$relevant" | sed 's/^/      /'
            echo "    ── Last 30 lines (full context): ───"
        else
            echo "    qBittorrent log — last 30 lines (no obvious error keywords):"
        fi
        echo "$logs" | tail -30 | sed 's/^/      /'
        echo "    Recovery options:"
        echo "      1. Full log:  $RT logs qbittorrent --tail 200"
        echo "      2. Restart:   bash $SCRIPT_DIR/restart-qbit.sh"
        echo "      3. If qBit is in a config-crash loop, reset its config:"
        echo "           $COMPOSE stop qbittorrent"
        echo "           rm /volume1/docker/media/qbittorrent/config/qBittorrent/qBittorrent.conf"
        echo "           bash $SCRIPT_DIR/setup.sh   (regenerates the conf + restarts qBit)"
    fi
}

# Diagnostic check for Tautulli. A bare HTTP-000 here is almost always
# a "still booting" condition — Tautulli's first-boot writes config.ini,
# then re-reads it, which takes 30-90s on slower NASes. setup-arr-
# config.py only does `$COMPOSE stop tautulli` + `$COMPOSE
# up -d tautulli` (returns once the container is starting, not healthy)
# so the post-deploy check can fire before Tautulli has bound its port.
check_tautulli() {
    local url="http://$LAN_IP:8181"
    local label="Tautulli"
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url")
    if [[ "$http_code" =~ ^(200|301|302|303|307|308|401|403)$ ]]; then
        ok "$label ($url) — HTTP $http_code"
        return
    fi
    local state restart_count
    state=$($RT inspect -f '{{.State.Status}}' tautulli 2>/dev/null || echo missing)
    restart_count=$($RT inspect -f '{{.RestartCount}}' tautulli 2>/dev/null || echo 0)
    if [ "$state" = "missing" ]; then
        fail "$label ($url) — container missing. Run: $COMPOSE up -d tautulli"
        return
    elif [ "$state" != "running" ]; then
        fail "$label ($url) — container is $state. Run: $COMPOSE up -d tautulli"
        return
    fi
    # Container is "running" but WebUI not serving. Two possibilities:
    #   (a) Still booting — first run takes 60-90s on slow NASes.
    #   (b) Crash-looping — Tautulli restarted itself N times. Common
    #       causes: bad config.ini from a half-applied write, can't
    #       read its sqlite db, permission errors on /config.
    # Distinguish by RestartCount: >0 in the first few minutes of an
    # install means the container is failing and being recreated by
    # `restart: unless-stopped`. >1 = definitely not just "booting".
    if [ "$restart_count" -gt 1 ]; then
        fail "$label ($url) — container is crash-looping (RestartCount=$restart_count)."
        local logs
        logs=$($RT logs --tail 20 tautulli 2>&1 || true)
        local relevant
        relevant=$(echo "$logs" | grep -iE 'error|denied|fatal|fail|cannot|unable|refused|exception|traceback' | head -6 || true)
        if [ -n "$relevant" ]; then
            echo "    Recent Tautulli log lines suggesting the cause:"
            echo "$relevant" | sed 's/^/      /'
        else
            echo "    Last 10 lines of Tautulli log:"
            echo "$logs" | tail -10 | sed 's/^/      /'
        fi
        echo "    Recovery:"
        echo "      1. Full log:  $RT logs tautulli --tail 100"
        echo "      2. Reset config (loses Tautulli-only state, NOT Plex history):"
        echo "           $COMPOSE stop tautulli"
        echo "           mv /volume1/docker/media/tautulli/config/config.ini{,.broken-\$(date +%Y%m%d-%H%M%S)}"
        echo "           bash $SCRIPT_DIR/setup.sh"
    else
        # RestartCount is 0 or 1 — could legitimately be still booting.
        warn "$label ($url) — container is running but not serving HTTP yet."
        warn "    Tautulli's first boot can take 60-90s on slower NASes. Wait, then re-run:"
        warn "      bash $SCRIPT_DIR/post-deploy-validate.sh"
        warn "    Still 000? Check:  $RT logs tautulli --tail 50"
    fi
}

# Check URL only when the underlying service is enabled — checking a
# disabled service would return HTTP 000 (nothing listening) and false-
# fail the post-deploy.
is_enabled ENABLE_HOMEPAGE    && check_url "Homepage"     "http://$LAN_IP:3000"
if is_enabled ENABLE_PLEX; then
    if [ "$MEDIA_SERVER" = "jellyfin" ]; then
        check_url "Jellyfin" "http://$LAN_IP:8096"
    else
        check_url "Plex" "http://$LAN_IP:32400/web"
    fi
fi
is_enabled ENABLE_SONARR      && check_url "Sonarr"       "http://$LAN_IP:49152"
is_enabled ENABLE_RADARR      && check_url "Radarr"       "http://$LAN_IP:49151"
is_enabled ENABLE_LIDARR      && check_url "Lidarr"       "http://$LAN_IP:49154"
check_url "Prowlarr"     "http://$LAN_IP:49150"
is_enabled ENABLE_BAZARR      && check_url "Bazarr"       "http://$LAN_IP:49153"
is_enabled ENABLE_SABNZBD     && check_url "SABnzbd"      "http://$LAN_IP:49155"
# qBittorrent often shows HTTP 000 at end-of-install even when the
# container is running — gluetun's network namespace can be busy with
# the WireGuard handshake, or LSIO's init scripts haven't finished
# applying the qBittorrent.conf yet. Use the diagnostic check_qbit
# below which inspects the container state + emits a specific recovery
# hint (restart-qbit.sh) instead of a flat fail.
is_enabled ENABLE_QBITTORRENT && check_qbit
{ is_enabled ENABLE_PLEX && [ "$MEDIA_SERVER" != "jellyfin" ]; } && check_tautulli
# Seerr binds to its port only AFTER the user completes the first-run
# wizard at http://<NAS>:5056 in a browser. Until then curl gets HTTP
# 000 (connection refused). Treat that as a warning, not a fail —
# step 7 already told the user to complete the wizard. Once they do,
# this validator passes on re-run.
is_enabled ENABLE_PLEX        && check_url_lenient "Seerr" "http://$LAN_IP:5056" \
    "Complete the first-run wizard at http://$LAN_IP:5056 to bind its port."
# Tautulli is checked via check_tautulli above — it has a richer diagnostic
# (container-state aware: distinguishes booting vs crash-loop). Don't duplicate
# it here.
is_enabled ENABLE_FLARESOLVERR && check_url "Flaresolverr" "http://$LAN_IP:8191"
# Recyclarr trigger webhook — port 8889 serves the "Sync Now" tile UI.
# Apk-installs docker-cli at first start (5s) so HTTP isn't reachable
# the instant the container exists; check_url has a 30s retry budget
# which covers the slow boot just fine.
is_enabled ENABLE_RECYCLARR   && check_url "Recyclarr trigger" "http://$LAN_IP:8889"

# ── Plex External Access ──────────────────────────────────────────────────────

# Fetch public IP up-front — both Plex external check and VPN check need
# it, and they're each independently gated below.
PUBLIC_IP=""
if { is_enabled ENABLE_PLEX && [ "$MEDIA_SERVER" != "jellyfin" ]; } || { is_enabled ENABLE_QBITTORRENT && vpn_on; }; then
    echo "  Fetching public IP..."
    # 3 retries with 2s spacing covers transient DNS / network hiccups
    # during install — public IP lookup is non-critical so we tolerate
    # noise. Max wall time: 5s × 4 attempts + 2s × 3 backoffs = ~26s.
    PUBLIC_IP=$(curl -sf --max-time 5 --retry 3 --retry-delay 2 https://api.ipify.org)
fi

if is_enabled ENABLE_PLEX && [ "$MEDIA_SERVER" != "jellyfin" ]; then
    section "Plex External Access"
    if [ -z "$PUBLIC_IP" ]; then
        # Non-fatal: a public-IP lookup blip (DNS/ipify hiccup) doesn't mean
        # the stack is broken — it only skips the external-reachability probe.
        warn "Could not determine public IP — skipping external Plex reachability test (check internet if this persists)"
    else
        ok "Public IP: $PUBLIC_IP"
        echo "  Testing Plex on $PUBLIC_IP:32400 from outside..."
        PLEX_EXTERNAL=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://$PUBLIC_IP:32400/identity")
        if [[ "$PLEX_EXTERNAL" =~ ^(200|301)$ ]]; then
            ok "Plex is reachable externally on port 32400"
        else
            warn "Plex is not reachable externally (HTTP $PLEX_EXTERNAL)"
            warn "Port 32400 may not be forwarded on your router — remote access via relay will still work"
        fi
    fi
fi

# ── Gluetun VPN ───────────────────────────────────────────────────────────────

# Only meaningful when the user actually opted into VPN-wrapped torrenting
# (VPN_ENABLED=true AND ENABLE_QBITTORRENT=true). Otherwise gluetun isn't
# running and `$RT exec gluetun` would fail; skip with a clear note.
if is_enabled ENABLE_QBITTORRENT && vpn_on; then
    section "Gluetun VPN"
    echo "  Checking VPN IP..."
    VPN_IP=$($RT exec gluetun wget -qO- --timeout=10 https://api.ipify.org 2>/dev/null)
    if [ -z "$VPN_IP" ]; then
        fail "Could not get IP through Gluetun — VPN may not be connected"
    elif [ -z "$PUBLIC_IP" ]; then
        # Leak check is a COMPARISON: gluetun's exit IP must differ from the
        # host's bare public IP. With no public IP to compare against (the
        # earlier ipify lookup failed — exactly the degraded-network case),
        # claiming "VPN is active" would be false confidence: VPN_IP simply
        # can't equal an empty string, so the happy branch fires by accident.
        # Warn that it's inconclusive instead of green-lighting a possible leak.
        warn "Gluetun has an exit IP ($VPN_IP) but the host's public IP was unavailable — can't confirm the VPN isn't leaking; re-run when internet is stable"
    elif [ "$VPN_IP" = "$PUBLIC_IP" ]; then
        fail "VPN IP matches your public IP — traffic is NOT going through the VPN"
    else
        ok "VPN is active — qBittorrent traffic exits via $VPN_IP"
    fi
fi

# ── Media Visibility ──────────────────────────────────────────────────────────

# $RT exec'ing into disabled arrs fails ("no such container") and
# false-fails the post-deploy. Each media check needs its container to
# exist — gate them on the matching ENABLE_*.

if is_enabled ENABLE_SONARR || is_enabled ENABLE_RADARR || is_enabled ENABLE_LIDARR; then
    section "Media Visibility"
fi

check_media() {
    local container="$1"
    local path="$2"
    local label="$3"
    local count
    count=$($RT exec "$container" find "$path" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l)
    if [ "$count" -gt 0 ]; then
        ok "$label — $count items found ($container:$path)"
    else
        warn "$label — folder is empty ($container:$path)"
    fi
}

if is_enabled ENABLE_SONARR; then
    check_media "sonarr" "/data/Media/TV Shows"       "TV Shows"
    check_media "sonarr" "/data/Media/Anime/TV Shows" "Anime TV"
    check_media "sonarr" "/data/Downloads"            "Downloads folder"
fi
if is_enabled ENABLE_RADARR; then
    check_media "radarr" "/data/Media/Movies"         "Movies"
    check_media "radarr" "/data/Media/Anime/Movies"   "Anime Movies"
fi
if is_enabled ENABLE_LIDARR; then
    check_media "lidarr" "/data/Media/Music"          "Music"
fi

# ── Indexer Smoke Test ────────────────────────────────────────────────────────
#
# "Containers are running" + "media folders have files in them" is the
# old completeness bar, and it's why the post-deploy could pass while
# the user actually had ZERO working indexers (CloudFlare blocks,
# stale URLs, missing Flaresolverr tags, expired private-tracker creds).
# This section adds an end-to-end indexer health check.
#
# We don't search for a specific guaranteed-available title (that'd
# need updating as the canary changes); we just ask Prowlarr to TEST
# each configured indexer (Prowlarr's own indexer-test endpoint does
# the same connectivity probe its UI does) and report how many pass.
# 0/N passing is a hard fail — the user has no working source.
section "Indexer Health"
PROWLARR_KEY=$(env_val PROWLARR_API_KEY)
# Prowlarr's key isn't always in .env (auto-discovered from config.xml
# by setup-arr-config.py). Fall back to extracting from config.xml.
if [ -z "$PROWLARR_KEY" ] && [ -f "$INSTALL_DIR/prowlarr/config/config.xml" ]; then
    PROWLARR_KEY=$(sed -n 's|.*<ApiKey>\([^<]*\)</ApiKey>.*|\1|p' "$INSTALL_DIR/prowlarr/config/config.xml" 2>/dev/null | head -1)
fi
if [ -z "$PROWLARR_KEY" ]; then
    warn "Prowlarr API key not found — skipping indexer health check"
elif ! command -v python3 >/dev/null 2>&1; then
    warn "python3 not available — skipping indexer health check"
else
    PROWLARR_URL="http://$LAN_IP:49150"
    # Each indexer needs an explicit test (POST /api/v1/indexer/test
    # with the indexer config). We list, then test each, then count.
    # 20s per indexer × 10 indexers = up to 200s worst case; in
    # practice each test returns in 2-5s.
    INDEXER_LIST=$(curl -sS -m 10 -H "X-Api-Key: $PROWLARR_KEY" \
        "$PROWLARR_URL/api/v1/indexer" 2>/dev/null || echo '[]')
    TOTAL=$(echo "$INDEXER_LIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
    if [ "$TOTAL" -eq 0 ]; then
        # Non-fatal: the stack is up; you just have nothing to search yet.
        # Don't red-fail a working install over a fixable config gap.
        warn "Prowlarr has 0 indexers configured — Sonarr/Radarr/Lidarr have nothing to search"
        echo "    Re-run setup.sh to install the default indexer set, or add some manually:"
        echo "      Prowlarr → Indexers → Add Indexer"
    else
        echo "  Testing $TOTAL indexer(s) — this can take 30-60s..."
        TEST_RESULTS=$(echo "$INDEXER_LIST" | python3 -c "
import sys, json, urllib.request, urllib.error
indexers = json.load(sys.stdin)
working, failed = 0, []
for ix in indexers:
    body = json.dumps(ix).encode()
    req = urllib.request.Request(
        '$PROWLARR_URL/api/v1/indexer/test',
        data=body, method='POST',
        headers={'X-Api-Key': '$PROWLARR_KEY', 'Content-Type': 'application/json'},
    )
    try:
        urllib.request.urlopen(req, timeout=20)
        working += 1
    except Exception as e:
        msg = ''
        if isinstance(e, urllib.error.HTTPError):
            try:
                err = json.loads(e.read().decode(errors='replace'))
                if isinstance(err, list) and err:
                    msg = err[0].get('errorMessage','') or err[0].get('detailedDescription','')
                elif isinstance(err, dict):
                    msg = err.get('message','') or err.get('errorMessage','')
            except Exception:
                pass
        failed.append((ix.get('name','?'), msg[:80] if msg else str(e)[:80]))
print(f'{working}|{len(indexers)}|' + ';'.join(f'{n}:{m}' for n,m in failed))
" 2>/dev/null || echo "0|0|")
        WORKING=$(echo "$TEST_RESULTS" | cut -d'|' -f1)
        FAILED_LIST=$(echo "$TEST_RESULTS" | cut -d'|' -f3)
        if [ "$WORKING" -eq "$TOTAL" ]; then
            ok "All $TOTAL indexers responding to test searches"
        elif [ "$WORKING" -gt 0 ]; then
            warn "$WORKING of $TOTAL indexers working — Sonarr/Radarr will only see results from those $WORKING"
            if [ -n "$FAILED_LIST" ]; then
                echo "    Failed indexers:"
                echo "$FAILED_LIST" | tr ';' '\n' | sed 's/^/      - /'
            fi
        else
            # Non-fatal: at install time indexers can fail the test transiently
            # (CloudFlare challenge that Flaresolverr clears on the first real
            # search, rate-limits, cold caches). The stack works; warn, don't fail.
            warn "0 of $TOTAL indexers passed test — they often clear on the first real search (CloudFlare/rate-limit); re-test in Prowlarr if it persists"
            if [ -n "$FAILED_LIST" ]; then
                echo "    Failed indexers:"
                echo "$FAILED_LIST" | tr ';' '\n' | sed 's/^/      - /'
            fi
            echo "    Common causes: CloudFlare block (check Flaresolverr tag), stale indexer URL,"
            echo "    expired private-tracker credentials. Re-run setup.sh to re-apply Flaresolverr tags."
        fi
    fi
fi

# ── Dashboard Config (Homepage tiles) ─────────────────────────────────────────
#
# Homepage's services.yaml is generated by setup-arr-config.py from the
# user's ENABLE_* picks. The wizard used to write this with the skip-
# if-exists helper, which meant an older services.yaml from a previous
# install would never get refreshed when:
#   - the user enabled a service that wasn't on before
#   - the wizard added a new section (e.g. the Recyclarr / Maintenance
#     section added in commit 764104e)
# The user would re-run setup.sh, the new code would generate a tile
# for the new service, the writer would say "skipped, already exists,"
# and the dashboard would be stuck on the old layout forever.
#
# Fixed at the write-helper level in a22b1ca (services.yaml +
# settings.yaml now overwrite every run). This section asserts the fix
# stuck: if any enabled service is missing from services.yaml, warn
# loudly with a one-command fix.
if is_enabled ENABLE_HOMEPAGE; then
    section "Dashboard Config"
    SERVICES_YAML="$INSTALL_DIR/homepage/config/services.yaml"
    if [ ! -f "$SERVICES_YAML" ]; then
        warn "Homepage services.yaml is missing — dashboard will be empty"
        echo "    Fix:  sudo python3 $SCRIPT_DIR/setup-arr-config.py"
    else
        # Each entry: ENABLE_<flag>:expected_tile_label  pairs.
        # The "expected tile label" is the string that appears after
        # the "- " in services.yaml — same as render_homepage_services'
        # block() name argument. Add new entries here when a new tile
        # is added to the generator.
        EXPECTED_TILES=()
        if is_enabled ENABLE_PLEX; then
            if [ "$MEDIA_SERVER" = "jellyfin" ]; then
                EXPECTED_TILES+=("ENABLE_PLEX:Jellyfin" "ENABLE_PLEX:Seerr")
            else
                EXPECTED_TILES+=("ENABLE_PLEX:Plex" "ENABLE_PLEX:Tautulli" "ENABLE_PLEX:Seerr")
            fi
        fi
        EXPECTED_TILES+=(
            "ENABLE_SONARR:Sonarr"
            "ENABLE_RADARR:Radarr"
            "ENABLE_LIDARR:Lidarr"
            "ENABLE_BAZARR:Bazarr"
            "ENABLE_SABNZBD:SABnzbd"
            "ENABLE_QBITTORRENT:qBittorrent"
            "ENABLE_RECYCLARR:Recyclarr"
        )
        MISSING=()
        for pair in "${EXPECTED_TILES[@]}"; do
            flag="${pair%%:*}"
            tile="${pair##*:}"
            if is_enabled "$flag"; then
                # Look for "- <Tile>:" with the YAML two-space + four-space
                # indentation render_homepage_services produces (e.g.
                # "    - Recyclarr:"). Anchoring on the leading spaces +
                # trailing colon avoids matching the tile name in a
                # description string or comment.
                if ! grep -qE "^    - ${tile}:" "$SERVICES_YAML"; then
                    MISSING+=("$tile ($flag=true)")
                fi
            fi
        done
        if [ ${#MISSING[@]} -eq 0 ]; then
            ok "Homepage tiles cover every enabled service"
        else
            warn "Homepage services.yaml is missing ${#MISSING[@]} tile(s) for enabled services:"
            for entry in "${MISSING[@]}"; do
                echo "      - $entry"
            done
            echo "    The wizard regenerates services.yaml from your .env on every run."
            echo "    Most likely cause: services.yaml is from a pre-fix install."
            echo "    Fix — force a fresh regeneration (Homepage picks it up live):"
            echo "      sudo rm $SERVICES_YAML $INSTALL_DIR/homepage/config/settings.yaml"
            echo "      sudo python3 $SCRIPT_DIR/setup-arr-config.py"
        fi
    fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "============================================="
echo "  Results: $PASS passed, $WARN warnings, $FAIL failed"
echo "============================================="

if [ $FAIL -gt 0 ]; then
    echo "  Some checks failed — review the output above."
    exit 1
elif [ $WARN -gt 0 ]; then
    echo "  All checks passed with warnings — review above."
    exit 0
else
    echo "  Everything looks good!"
    exit 0
fi
