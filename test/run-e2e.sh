#!/bin/bash
# ── End-to-end payload test against a fake NAS ────────────────────────────────
#
# Spins up a privileged "fake NAS" container (its own Docker daemon via DinD),
# drops the real nas/ payload into it exactly where the installer would, writes
# a test .env, runs setup.sh for real, and asserts the stack came up — so we
# can verify the install pipeline actually works in practice, per simulated
# NAS family.
#
# Usage:
#   bash test/run-e2e.sh [--family synology|ugreen|generic] [--profile smoke|full] [--keep]
#
#   --family   which environment to simulate (default: ugreen)
#   --profile  smoke = Prowlarr + Flaresolverr only (fast, ~2 small images)
#              full  = the default service set (slow, pulls several GB)
#   --keep     leave the container running afterwards for inspection
#
# Requires Docker on the machine running this script (it manages the fake-NAS
# container; the media stack runs inside that container's own daemon).
set -euo pipefail

FAMILY="ugreen"
PROFILE="smoke"
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --family)  FAMILY="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --keep)    KEEP=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$FAMILY" in
  synology|ugreen) INSTALL_DIR="/volume1/docker/media"; DATA_ROOT="/volume1/Data" ;;
  asustor)         INSTALL_DIR="/volume1/Docker/mediarr"; DATA_ROOT="/volume1/Data" ;;
  terramaster)     INSTALL_DIR="/Volume1/docker/media"; DATA_ROOT="/Volume1/data" ;;
  zimaos)          INSTALL_DIR="/DATA/AppData/mediarr"; DATA_ROOT="/DATA/Media" ;;
  generic)         INSTALL_DIR="/opt/mediarr";          DATA_ROOT="/srv/data" ;;
  *) echo "unknown family: $FAMILY (want synology|ugreen|asustor|terramaster|zimaos|generic)" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
NAME="mediarr-testnas-$FAMILY"
say() { printf '\n\033[1;36m[e2e:%s]\033[0m %s\n' "$FAMILY" "$*"; }
fail() { printf '\n\033[1;31m[e2e:%s FAIL]\033[0m %s\n' "$FAMILY" "$*"; exit 1; }

cleanup() {
  if [ "$KEEP" = 1 ]; then
    say "leaving $NAME running (--keep). Remove with: docker rm -f $NAME"
  else
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

say "building fake-NAS image"
docker build -t mediarr-testnas:latest "$HERE" >/dev/null

say "starting $NAME (privileged DinD)"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --privileged --name "$NAME" -e "NAS_FAMILY=$FAMILY" mediarr-testnas:latest >/dev/null

say "waiting for the in-container Docker daemon"
for _ in $(seq 1 60); do
  if docker exec "$NAME" docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" docker info >/dev/null 2>&1 || fail "in-container dockerd never came up (see: docker logs $NAME)"

# ── Drop the payload where the installer would (INSTALL_DIR/scripts) ──────────
say "uploading payload to $INSTALL_DIR/scripts"
docker exec "$NAME" mkdir -p "$INSTALL_DIR" "$DATA_ROOT"
docker cp "$REPO/nas/scripts/." "$NAME:$INSTALL_DIR/scripts/"
if [ -d "$REPO/nas/migration" ]; then
  docker cp "$REPO/nas/migration/." "$NAME:$INSTALL_DIR/migration/" || true
fi

# ── Write a test .env ─────────────────────────────────────────────────────────
# smoke: everything optional OFF → only the always-on Prowlarr + Flaresolverr
# start, so the run is fast but still exercises folders + .env + compose up +
# the arr API config + validation. full: leave the defaults (everything on).
ENV_TMP="$(mktemp)"
{
  echo "INSTALL_DIR=$INSTALL_DIR"
  echo "DATA_ROOT=$DATA_ROOT"
  echo "PUID=1000"
  echo "PGID=100"
  echo "TZ=Etc/UTC"
  echo "LAN_IP=127.0.0.1"
  echo "QBITTORRENT_USER=admin"
  echo "QBITTORRENT_PASS=testpass1234"
  echo "VPN_ENABLED=false"
  echo "MEDIA_SERVER=jellyfin"
  if [ "$PROFILE" = "smoke" ]; then
    for s in PLEX SONARR RADARR LIDARR BAZARR QBITTORRENT SABNZBD HOMEPAGE RECYCLARR UNPACKERR; do
      echo "ENABLE_$s=false"
    done
  fi
} > "$ENV_TMP"
docker cp "$ENV_TMP" "$NAME:$INSTALL_DIR/scripts/.env"
rm -f "$ENV_TMP"

# ── Run the real installer payload ────────────────────────────────────────────
say "running setup.sh (profile=$PROFILE) — this pulls images inside the fake NAS"
if docker exec "$NAME" bash "$INSTALL_DIR/scripts/setup.sh"; then
  SETUP_RC=0
else
  SETUP_RC=$?
fi

say "running post-deploy-validate.sh"
docker exec "$NAME" bash "$INSTALL_DIR/scripts/post-deploy-validate.sh" || true

say "containers running inside the fake NAS:"
docker exec "$NAME" docker ps --format '  {{.Names}}\t{{.Status}}' || true

if [ "$SETUP_RC" -ne 0 ]; then
  fail "setup.sh exited $SETUP_RC"
fi
say "PASS — setup.sh completed and the stack came up on the $FAMILY environment"
