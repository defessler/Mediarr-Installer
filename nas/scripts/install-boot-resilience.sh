#!/bin/bash
# ── install-boot-resilience.sh — auto-wire boot + self-heal hooks ──
#
# Called late by setup.sh (best-effort, never fails the install). It makes
# the qBittorrent/gluetun stack survive reboots and gluetun recreations
# WITHOUT the user hand-wiring a boot task:
#
#   • BOOT HOOK   → runs boot-orchestrator.sh at every boot, so the stack
#                   comes up in dependency order (gluetun before qBit) and
#                   qBit never hits "must join at least one network".
#                   Installed for any stack (clean ordered boot helps all).
#   • SELF-HEAL   → runs qbit-guardian.sh every ~5 min; recovers a wedged
#                   qBittorrent (exited, or running-but-network-dead after
#                   gluetun was recreated). Installed ONLY when VPN is on
#                   AND qBittorrent is enabled — that's the only layout
#                   where the gluetun-namespace wedge can happen.
#
# Per-platform mechanism (mirrors how setup-firewall.sh special-cases DSM):
#   Synology DSM   → /usr/local/etc/rc.d/media-boot.sh (boot) + /etc/crontab (heal)
#   Unraid         → /boot/config/plugins/dynamix/mediarr.cron (both, persists on USB)
#   QNAP QTS       → /etc/config/crontab (heal); boot hook printed (autorun.sh is manual)
#   UGREEN/OMV/Linux→ root crontab (@reboot boot + */5 heal)
#
# Idempotent: re-running setup.sh never duplicates an entry (fixed rc.d/
# cron filenames + tagged crontab lines `# mediarr-boot` / `# mediarr-guardian`,
# reconciled in place). Graceful-degrade: not-root / no-cron / unknown
# platform prints manual steps and exits 0 — it can never fail the install.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if   [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/.env" ]; then
    COMPOSE_DIR="$SCRIPT_DIR"
elif [ "$(basename "$SCRIPT_DIR")" = "scripts" ] && [ -f "$(dirname "$SCRIPT_DIR")/.env" ]; then
    COMPOSE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    COMPOSE_DIR="$SCRIPT_DIR"
fi
ENV_FILE="$SCRIPT_DIR/.env"; [ -f "$ENV_FILE" ] || ENV_FILE="$COMPOSE_DIR/.env"

env_val()    { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | sed 's/[[:space:]]#.*//' | tr -d '\r' | xargs; }
is_enabled() { local v; v="$(env_val "$1" | tr '[:upper:]' '[:lower:]')"; case "$v" in false|0|no|off) return 1 ;; *) return 0 ;; esac; }

# Boot hook is stack-wide; the self-heal cron is qBit+VPN only.
VPN_ON=0
case "$(env_val VPN_ENABLED | tr '[:upper:]' '[:lower:]')" in true|1|yes|on) VPN_ON=1 ;; esac
# slskd shares gluetun's namespace like qBittorrent, so the self-heal guardian
# is wanted when Soulseek is on too. ENABLE_SOULSEEK is OPT-IN (explicit true
# only — a missing key must NOT arm the guardian), unlike default-on qBittorrent.
is_optin() { case "$(env_val "$1" | tr '[:upper:]' '[:lower:]')" in true|1|yes|on) return 0 ;; *) return 1 ;; esac; }
INSTALL_GUARD=0
if [ "$VPN_ON" -eq 1 ] && { is_enabled ENABLE_QBITTORRENT || is_optin ENABLE_SOULSEEK; }; then
    INSTALL_GUARD=1
fi

BOOT_TAG='# mediarr-boot'
GUARD_TAG='# mediarr-guardian'
BOOT_SH="$SCRIPT_DIR/boot-orchestrator.sh"
GUARD_SH="$SCRIPT_DIR/qbit-guardian.sh"

echo ""
echo "  ── Boot + self-heal resilience ────────────────"

# ── Manual-instruction fallback (used when auto-install can't proceed) ──
manual_hint() {
    echo "  ⚠ Couldn't auto-install boot resilience ($1)."
    echo "    Wire it yourself so reboots/updates don't strand qBittorrent:"
    case "$2" in
        synology)
            echo "      DSM → Control Panel → Task Scheduler → Triggered Task →"
            echo "        User: root, Event: Boot-up, Run: bash $BOOT_SH" ;;
        qnap)
            echo "      Add to autorun.sh (Control Panel → Hardware → enable"
            echo "        'Run user defined startup processes'): bash $BOOT_SH" ;;
        unraid)
            echo "      User Scripts plugin → 'At First Array Start Only': bash $BOOT_SH" ;;
        truenas)
            echo "      Web UI → System Settings → Advanced → Init/Shutdown Scripts →"
            echo "        Add → Type: Command, When: Post Init, Command: bash $BOOT_SH"
            echo "      (a plain crontab entry does NOT persist on TrueNAS — the"
            echo "       middleware rewrites cron and the rootfs resets on update.)" ;;
        *)
            echo "      sudo crontab -e  →  add:"
            echo "        @reboot sleep 30 && bash $BOOT_SH" ;;
    esac
    if [ "$INSTALL_GUARD" -eq 1 ]; then
        case "$2" in
            truenas)
                echo "    And a self-heal check every 5 min — add as a middleware-persisted"
                echo "    Cron Job (Web UI → System Settings → Advanced → Cron Jobs):"
                echo "        Command: bash $GUARD_SH   Schedule: every 5 minutes, Run as: root" ;;
            *)
                echo "    And a self-heal check every 5 min:"
                echo "        */5 * * * * bash $GUARD_SH" ;;
        esac
    fi
}

# Best-effort crond reload on DSM (command name varies across DSM versions).
reload_dsm_crond() {
    synoservice -restart crond 2>/dev/null \
        || synosystemctl restart crond 2>/dev/null \
        || synoservicectl --restart crond 2>/dev/null \
        || echo "  ℹ Couldn't reload crond — the self-heal cron activates on next reboot."
}

# Idempotently set a marked line in a raw crontab FILE (DSM /etc/crontab,
# QNAP /etc/config/crontab — files we append to, not `crontab -`). Removes
# any existing line carrying $3 first, then appends $2.
#   $1 file   $2 full line (incl. its trailing marker comment)   $3 marker
# Decouples the rewrite from grep's exit status: `grep -vF` returns 1 when
# the filtered result is EMPTY (the marked line was the file's only line),
# which a naive `grep -vF … && mv` would treat as failure — leaving the old
# line in place, orphaning the temp file, and letting the append create a
# DUPLICATE. The brace-group `|| true` makes the redirect always succeed, so
# the mv always runs. Also guarantees a trailing newline before the append
# so the new entry can't glue onto a non-newline-terminated last line.
crontab_file_set() {
    local file="$1" line="$2" tag="$3" tmp="$1.mediarr.$$"
    if [ -f "$file" ] && grep -qF "$tag" "$file" 2>/dev/null; then
        { grep -vF "$tag" "$file" 2>/dev/null || true; } > "$tmp"
        mv "$tmp" "$file"
    fi
    rm -f "$tmp" 2>/dev/null
    # busybox tail supports -c; $(...) strips a trailing newline, so a file
    # that already ends in \n yields "" → no extra newline added.
    if [ -s "$file" ] && [ "$(tail -c1 "$file" 2>/dev/null)" != "" ]; then
        printf '\n' >> "$file"
    fi
    printf '%s\n' "$line" >> "$file"
}

# Remove any line carrying marker $2 from raw crontab file $1. Returns 0 if
# it removed something (caller should reload), 1 if there was nothing to do.
crontab_file_unset() {
    local file="$1" tag="$2" tmp="$1.mediarr.$$"
    { [ -f "$file" ] && grep -qF "$tag" "$file" 2>/dev/null; } || return 1
    { grep -vF "$tag" "$file" 2>/dev/null || true; } > "$tmp"
    mv "$tmp" "$file"
    rm -f "$tmp" 2>/dev/null
    return 0
}

# Need root to write rc.d / system crontab / boot config.
if [ "$(id -u)" -ne 0 ]; then
    if   [ -f /etc/synoinfo.conf ]; then fam=synology
    elif [ -f /etc/unraid-version ]; then fam=unraid
    elif [ -f /etc/config/qpkg.conf ] || [ -d /share/CACHEDEV1_DATA ]; then fam=qnap
    else fam=linux; fi
    manual_hint "not running as root" "$fam"
    exit 0
fi

# ════════════════════════════════════════════════════════════════════════
# Synology DSM — rc.d boot wrapper + /etc/crontab self-heal
# ════════════════════════════════════════════════════════════════════════
if [ -f /etc/synoinfo.conf ]; then
    # Boot hook: a thin rc.d wrapper that execs boot-orchestrator.sh. We do
    # NOT cp boot-orchestrator.sh itself into rc.d — from rc.d its layout
    # detection would resolve the wrong compose dir (no .env there).
    RC=/usr/local/etc/rc.d/media-boot.sh
    if [ -d /usr/local/etc/rc.d ]; then
        _tmp="$RC.tmp.$$"
        {
            printf '#!/bin/sh\n'
            printf '# mediarr-boot — auto-installed by setup.sh; safe to delete.\n'
            printf 'case "$1" in stop) exit 0 ;; esac\n'
            # rc.d runs with a stripped PATH that omits the container-runtime bin
            # dirs, so export the full Synology/QNAP set (matches the export at
            # the top of boot-orchestrator.sh) before exec'ing it — otherwise
            # docker isn't on PATH at boot and the ordered-boot feature no-ops.
            printf 'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/var/packages/ContainerManager/target/usr/bin:/var/packages/Docker/target/usr/bin:/share/CACHEDEV1_DATA/.qpkg/container-station/bin:/share/.qpkg/container-station/bin:${PATH:-}"\n'
            printf '[ -x "%s" ] && exec /bin/bash "%s"\n' "$BOOT_SH" "$BOOT_SH"
        } > "$_tmp"
        if [ -f "$RC" ] && cmp -s "$_tmp" "$RC"; then
            rm -f "$_tmp"; echo "  ✔ Boot hook already current ($RC)"
        else
            mv "$_tmp" "$RC" && chmod 755 "$RC" && echo "  ✔ Boot hook installed at $RC"
        fi
    else
        echo "  ⚠ /usr/local/etc/rc.d missing — skipping DSM boot hook."
        manual_hint "no rc.d directory" synology
    fi

    # Self-heal: a TAB-separated root line in /etc/crontab (DSM ignores
    # space-separated lines). Reconcile in place so re-runs never dup and a
    # VPN-off re-run removes it.
    CRON=/etc/crontab
    if [ -w "$CRON" ] || { [ ! -e "$CRON" ] && [ -w /etc ]; }; then
        if [ "$INSTALL_GUARD" -eq 1 ]; then
            # TAB-separated 7-field root line (DSM ignores space-separated
            # lines). Build with real tabs via printf, then set idempotently.
            GUARD_LINE=$(printf '*/5\t*\t*\t*\t*\troot\t/bin/bash %s >/dev/null 2>&1 %s' "$GUARD_SH" "$GUARD_TAG")
            crontab_file_set "$CRON" "$GUARD_LINE" "$GUARD_TAG"
            echo "  ✔ Self-heal cron added to $CRON (every 5 min)"
            reload_dsm_crond
        elif crontab_file_unset "$CRON" "$GUARD_TAG"; then
            echo "  ✔ Removed stale self-heal cron (VPN/qBit off)"
            reload_dsm_crond
        else
            echo "  ⏭ Self-heal cron skipped — only needed when VPN_ENABLED=true + qBittorrent on"
        fi
    else
        echo "  ⚠ $CRON not writable — skipping self-heal cron."
        [ "$INSTALL_GUARD" -eq 1 ] && manual_hint "/etc/crontab not writable" synology
    fi
    exit 0
fi

# ════════════════════════════════════════════════════════════════════════
# Unraid — single persistent .cron on the USB boot device (rootfs is tmpfs)
# ════════════════════════════════════════════════════════════════════════
if [ -f /etc/unraid-version ]; then
    if [ -d /boot/config ]; then
        CRON_DIR=/boot/config/plugins/dynamix
        CRON="$CRON_DIR/mediarr.cron"
        mkdir -p "$CRON_DIR"
        {
            echo "# mediarr — auto-generated; safe to delete (boot hook + qBit self-heal)"
            printf '@reboot sleep 30 && /bin/bash %s >/dev/null 2>&1\n' "$BOOT_SH"
            [ "$INSTALL_GUARD" -eq 1 ] && printf '*/5 * * * * /bin/bash %s >/dev/null 2>&1\n' "$GUARD_SH"
        } > "$CRON"
        # NOTE: earlier builds called update_cron here — but that's an Unraid
        # webGUI helper, NOT a command on PATH in this script's context, so the
        # call always failed (the message below was always the one that ran).
        # Dynamix reconciles /boot/config/plugins/dynamix/*.cron at every array
        # start, so the cron loads then either way — no need to invoke it.
        echo "  ✔ Cron written to $CRON (dynamix loads it at your next array start)."
        # @reboot honoring varies by dcron build, and every container carries
        # restart: unless-stopped (Docker brings the stack back at array start
        # regardless). For a GUARANTEED, strictly-ordered boot — gluetun before
        # qBittorrent on a VPN setup — the reliable hook is the User Scripts
        # plugin, which runs after the array + Docker are up:
        echo "    For guaranteed ordered boot, add in the User Scripts plugin as"
        echo "    'At First Array Start Only':  bash $BOOT_SH"
    else
        manual_hint "/boot/config missing" unraid
    fi
    exit 0
fi

# ════════════════════════════════════════════════════════════════════════
# QNAP QTS — persistent /etc/config/crontab for self-heal; boot is manual
# ════════════════════════════════════════════════════════════════════════
if [ -f /etc/config/qpkg.conf ] || [ -d /share/CACHEDEV1_DATA ]; then
    CRON=/etc/config/crontab
    if [ -w "$CRON" ] || { [ ! -e "$CRON" ] && [ -w /etc/config ]; }; then
        if [ "$INSTALL_GUARD" -eq 1 ]; then
            # /etc/config/crontab is space-separated, 5 fields + command, no
            # user field (runs as root). Set idempotently, then reload.
            crontab_file_set "$CRON" "*/5 * * * * /bin/bash $GUARD_SH >/dev/null 2>&1 $GUARD_TAG" "$GUARD_TAG"
            crontab "$CRON" 2>/dev/null
            echo "  ✔ Self-heal cron added to $CRON (every 5 min, reloaded)"
        elif crontab_file_unset "$CRON" "$GUARD_TAG"; then
            # Reconcile the OFF-path like every other platform: a prior run with
            # VPN+qBit/Soulseek on left a */5 guardian line; with them now off it
            # must be removed, else an orphaned guardian keeps probing/“healing”
            # a stack that should be idle. Reload so QTS drops it immediately.
            crontab "$CRON" 2>/dev/null
            echo "  ✔ Removed stale self-heal cron (VPN/qBit off)"
        else
            echo "  ⏭ Self-heal cron skipped — only needed when VPN_ENABLED=true + qBittorrent on"
        fi
    else
        echo "  ⚠ $CRON not writable — skipping self-heal cron."
        [ "$INSTALL_GUARD" -eq 1 ] && manual_hint "/etc/config/crontab not writable" qnap
    fi
    # QTS boot scripting (autorun.sh) needs a Control-Panel toggle + a
    # per-model DOM mount we can't do unattended. It's non-fatal either way:
    # every container carries restart: unless-stopped, so QTS's Docker brings
    # the stack back on reboot; and on a VPN setup the */5 guardian recovers a
    # gluetun-namespace-wedged qBittorrent within 5 min. A boot hook only buys
    # a faster, strictly-ordered start. Keep the reboot-coverage note accurate
    # to the VPN state — the guardian is only installed when INSTALL_GUARD=1.
    if [ "$INSTALL_GUARD" -eq 1 ]; then
        echo "  ℹ Reboots are covered: Docker's restart policy brings the stack"
        echo "    back, and the 5-min self-heal recovers qBittorrent."
    else
        echo "  ℹ Reboots are covered by Docker's restart policy (every container"
        echo "    is restart: unless-stopped)."
    fi
    echo "    For a faster, strictly-ordered boot, enable Control Panel → Hardware"
    echo "    → 'Run user defined startup processes', then add to autorun.sh:"
    echo "      bash $BOOT_SH"
    exit 0
fi

# ════════════════════════════════════════════════════════════════════════
# TrueNAS SCALE / CORE — crontab is middleware-owned and the rootfs resets on
# update, so a plain `crontab -` write LOOKS installed (exit 0) but vanishes on
# the next reboot/update. Don't claim success — point at the persistent
# Init/Shutdown-script + Cron-Job mechanisms (same detection signal env-detector
# uses for the truenas family). Checked BEFORE the generic crontab branch so
# TrueNAS never falls through to the misleading "installed in root crontab".
# ════════════════════════════════════════════════════════════════════════
if grep -qiE 'truenas|freenas' /etc/version 2>/dev/null || [ -f /etc/truenas_version ]; then
    echo "  ⚠ TrueNAS detected — crontab here is managed by the middleware and is reset"
    echo "    on reboot/update, so an auto-installed hook would not survive. Wire it via"
    echo "    the persistent Web UI mechanism instead:"
    manual_hint "TrueNAS middleware-managed cron isn't persistent" truenas
    echo "  ℹ Reboots are still partly covered by Docker's restart policy (every"
    echo "    container is restart: unless-stopped); the boot hook only adds a faster,"
    echo "    strictly-ordered start, and (on a VPN setup) the self-heal recovers qBit."
    exit 0
fi

# ════════════════════════════════════════════════════════════════════════
# UGREEN / OMV / generic Linux — root crontab (@reboot + */5), atomic RMW
# ════════════════════════════════════════════════════════════════════════
if command -v crontab >/dev/null 2>&1; then
    BOOT_LINE="@reboot sleep 30 && /bin/bash $BOOT_SH >/dev/null 2>&1 $BOOT_TAG"
    GUARD_LINE="*/5 * * * * /bin/bash $GUARD_SH >/dev/null 2>&1 $GUARD_TAG"
    # Drop our managed lines AND any unmarked line pointing at OUR scripts
    # (adopts a hand-rolled entry the user may have added per the old docs),
    # then re-add canonical lines — a single atomic `crontab -` rewrite, so
    # nothing duplicates and an unrelated foreign entry is left untouched.
    cur="$(crontab -l 2>/dev/null | grep -vF "$BOOT_TAG" | grep -vF "$GUARD_TAG" | grep -vF "$BOOT_SH" | grep -vF "$GUARD_SH")"
    wrote_ok=0
    {
        printf '%s\n' "$cur"
        printf '%s\n' "$BOOT_LINE"
        [ "$INSTALL_GUARD" -eq 1 ] && printf '%s\n' "$GUARD_LINE"
    } | grep -v '^[[:space:]]*$' | crontab - && wrote_ok=1
    # Confirm the write actually PERSISTED before claiming success. On a
    # read-only / appliance rootfs (e.g. ZimaOS) or a middleware-owned cron,
    # `crontab -` can exit 0 yet the entry is gone on the next read (and the
    # next reboot) — so re-read crontab -l for our marked boot line. If it
    # isn't there, print manual steps + a warning instead of overstating it.
    if [ "$wrote_ok" -eq 1 ] && crontab -l 2>/dev/null | grep -qF "$BOOT_TAG"; then
        echo "  ✔ Boot hook installed in root crontab (@reboot)"
        if [ "$INSTALL_GUARD" -eq 1 ]; then
            echo "  ✔ Self-heal cron installed in root crontab (every 5 min)"
        else
            echo "  ⏭ Self-heal cron skipped — only needed when VPN_ENABLED=true + qBittorrent on"
        fi
    else
        echo "  ⚠ Boot hook did not persist — this host's crontab looks read-only or"
        echo "    middleware-managed (the entry was gone when re-read), so it wouldn't"
        echo "    survive a reboot/update."
        manual_hint "crontab not persistent on this host" linux
    fi
    exit 0
fi

# ── Nothing matched / no crontab: degrade to manual ──
manual_hint "no supported scheduler found" linux
exit 0
