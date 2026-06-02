#!/bin/bash
# ── Fake-NAS entrypoint ───────────────────────────────────────────────────────
# Lays down the simulated NAS-family markers, starts the in-container Docker
# daemon (DinD), then runs sshd in the foreground so the container stays alive
# and the real installer can connect.
set -e

FAMILY="${NAS_FAMILY:-generic}"
echo "[fake-nas] simulating NAS family: $FAMILY"

# ── Family markers + storage layout ──────────────────────────────────────────
# These mirror exactly what env-detector.ts probes for, so the installer (and
# the setup scripts) classify the box the same way a real one would.
case "$FAMILY" in
  synology)
    # DSM's definitive marker is /etc/synoinfo.conf; storage at /volume1.
    : > /etc/synoinfo.conf
    mkdir -p /volume1/docker /volume1/Data
    ;;
  ugreen)
    # UGOS = Debian (the base image already has /etc/debian_version) + a
    # /volume1 storage pool and NO synoinfo.conf — which is exactly the
    # heuristic env-detector uses to classify a box as 'ugreen'.
    mkdir -p /volume1/docker /volume1/Data
    ;;
  generic | *)
    # A plain Linux Docker host — no NAS markers, FHS-style paths.
    mkdir -p /opt/mediarr /srv/data
    ;;
esac
chown -R tester:tester /volume1 /opt/mediarr /srv/data 2>/dev/null || true

# ── In-container Docker daemon (DinD) ─────────────────────────────────────────
echo "[fake-nas] starting dockerd (requires the container to run --privileged)..."
dockerd >/var/log/dockerd.log 2>&1 &
ready=0
for _ in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" = 1 ]; then
  echo "[fake-nas] dockerd ready"
  # Let the tester user drive docker without sudo (matches a NAS admin who's
  # in the docker group).
  usermod -aG docker tester 2>/dev/null || true
else
  echo "[fake-nas] WARNING: dockerd did not start. Did you forget --privileged?"
  tail -n 20 /var/log/dockerd.log 2>/dev/null || true
fi

# ── sshd (keeps the container alive + lets the real installer connect) ────────
ssh-keygen -A >/dev/null 2>&1 || true
echo "[fake-nas] sshd on :22 — connect the installer as  tester / tester  (or run-e2e.sh uses docker exec)"
exec /usr/sbin/sshd -D -e
