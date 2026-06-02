# ── Fake-NAS test image ───────────────────────────────────────────────────────
#
# A throwaway "NAS in a box" the Mediarr payload (nas/scripts/*) can be run
# against for REAL end-to-end tests: it runs its own Docker daemon (DinD) so
# `docker compose up` inside it actually starts the stack, plus sshd so the
# real Electron installer can be pointed at it too.
#
# Debian bookworm base on purpose — it's glibc/GNU (like Synology DSM, UGREEN
# UGOS, QNAP, TrueNAS SCALE), so behaviour matches real NAS targets far better
# than an Alpine/busybox image would. The simulated NAS *family* is layered on
# at container start by entrypoint.sh (marker files), not baked in — so one
# image covers synology / ugreen / generic via the NAS_FAMILY env var.
#
# Build:   docker build -t mediarr-testnas test/
# Run:     see test/compose.yml or test/run-e2e.sh (needs --privileged for DinD)

FROM debian:bookworm

# Tools the setup scripts assume on the host: bash, python3 (setup-arr-config
# .py + the qBit hash gen), curl + iproute2 + net-tools (probes/healthchecks),
# iptables (REQUIRED check), sudo, flock (util-linux), ca-certificates, plus
# the Docker engine + compose plugin for the in-container DinD.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash python3 curl ca-certificates iproute2 net-tools iptables sudo \
        procps openssh-server uidmap \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        docker-ce docker-ce-cli containerd.io docker-compose-plugin \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# A non-root admin user matching a typical NAS account: uid 1000, primary
# group `users`(100). Passwordless sudo so the automated runner doesn't need
# to pipe a password; the README explains how to switch to password-sudo to
# exercise that path too. Password `tester` is set so the real installer can
# SSH in with password auth.
RUN useradd -m -u 1000 -G sudo -s /bin/bash tester \
    && echo 'tester:tester' | chpasswd \
    && echo 'tester ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/tester \
    && chmod 0440 /etc/sudoers.d/tester \
    && mkdir -p /run/sshd

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# 22 = sshd (point the installer here). The DinD daemon is internal only.
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
