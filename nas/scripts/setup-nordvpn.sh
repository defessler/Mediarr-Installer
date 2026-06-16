#!/bin/bash
# ── VPN WireGuard Key Setup (provider-aware) ──
#
# Historically NordVPN-specific (and the filename still reflects that for
# back-compat with older setup.sh invocations); now dispatches based on
# VPN_PROVIDER in .env. We only call the NordVPN API for VPN_PROVIDER=nordvpn;
# everything else is expected to have its credentials pre-populated in .env
# by the wizard (e.g. WIREGUARD_PRIVATE_KEY pasted by the user from
# ProtonVPN's dashboard).
#
# Usage:
#   bash <INSTALL_DIR>/setup-nordvpn.sh

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

if [ ! -f "$ENV_FILE" ]; then
    echo "  ✘ .env not found at $ENV_FILE"
    echo "  Copy the template first:  cp .env.example .env"
    exit 1
fi

# Helper for reading values out of .env (strips inline comments + whitespace).
env_val() {
    local raw
    raw="$(grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r')"
    case "$raw" in
        '"'*)
            # Double-quoted by the wizard's ESCAPE (env-render.ts): strip the
            # outer quotes and reverse the backslash-escaping in a single
            # left-to-right pass (\\ \" \$ \` -> the literal char; \n \r ->
            # newline/CR), so a VPN credential containing " $ ` \ round-trips
            # intact and a literal backslash can't be mis-paired. Text past the
            # closing quote is an inline comment.
            printf '%s' "$raw" | awk '
                {
                    n = length($0); out = ""; i = 2
                    while (i <= n) {
                        c = substr($0, i, 1)
                        if (c == "\\" && i < n) {
                            d = substr($0, i + 1, 1)
                            if (d == "n") out = out "\n"
                            else if (d == "r") out = out "\r"
                            else out = out d
                            i += 2
                            continue
                        }
                        if (c == "\"") break
                        out = out c
                        i++
                    }
                    printf "%s", out
                }'
            ;;
        *)
            # Unquoted (the common case): strip a whitespace-anchored inline
            # comment and trim — unchanged behavior.
            printf '%s' "$raw" | sed 's/[[:space:]]#.*//' | xargs
            ;;
    esac
}

# Skip entirely when the user has opted out of VPN. setup.sh applies
# docker-compose.no-vpn.yml in that case; gluetun never starts and the
# WireGuard key isn't needed.
VPN_ENABLED=$(env_val VPN_ENABLED | tr '[:upper:]' '[:lower:]')
case "$VPN_ENABLED" in
    true|1|yes|on)
        ;; # fall through to provider-specific path
    *)
        echo "  ⏭ VPN_ENABLED=$VPN_ENABLED — skipping VPN key setup (no VPN)."
        exit 0
        ;;
esac

# Dispatch on provider. For anything other than NordVPN we expect the
# credentials to already be in .env (the wizard collects them via the
# Configure screen and writes them as part of the rendered .env).
VPN_PROVIDER=$(env_val VPN_PROVIDER | tr '[:upper:]' '[:lower:]')
case "$VPN_PROVIDER" in
    ""|nordvpn)
        # Existing NordVPN flow follows below.
        ;;
    protonvpn|mullvad|airvpn|surfshark|custom)
        # User pasted credentials directly into Configure — nothing to fetch.
        echo "  ⏭ VPN_PROVIDER=$VPN_PROVIDER — using user-supplied credentials in .env."
        # Sanity-check the common case (WireGuard providers): warn if the
        # private key isn't there. Don't fail — gluetun will surface a
        # clearer error if creds are missing.
        case "$VPN_PROVIDER" in
            protonvpn|mullvad|airvpn)
                WG=$(env_val WIREGUARD_PRIVATE_KEY)
                if [ -z "$WG" ]; then
                    echo "  ⚠ WIREGUARD_PRIVATE_KEY is empty in .env — gluetun won't connect."
                    echo "    Re-run the wizard's Configure screen and paste the key from"
                    echo "    your provider's WireGuard config."
                fi
                ;;
        esac
        exit 0
        ;;
    *)
        echo "  ⚠ Unknown VPN_PROVIDER=$VPN_PROVIDER — passing through to gluetun as-is."
        exit 0
        ;;
esac

# ── NordVPN-specific path below ──

# Python runner (host python3, else a throwaway python:3-alpine container).
# Only the NordVPN path needs Python (to parse the API JSON), so this is
# scoped here. Without a fallback, a Docker/Podman-only NAS (no host
# python3) would die at the parse step below and — because the parse
# failure is reported as "check your access token" — send the user chasing
# a perfectly valid token. setup.sh and setup-folders.sh already use this
# exact "host python3 → else container" shape; mirror it so the fetch works
# wherever they do. The JSON parse is pure stdlib reading stdin (no docker
# socket, no network from inside the container), so the container form is
# minimal: `run --rm -i <image> python3 ...`.
#
# When invoked by setup.sh we inherit the runtime it already picked via the
# exported CONTAINER_RUNTIME; standalone (per the usage header) we detect it
# ourselves so this still works run by hand.
run_python() {
    if command -v python3 >/dev/null 2>&1; then
        python3 "$@"
        return $?
    fi
    local _rt="${CONTAINER_RUNTIME:-}"
    if [ -z "$_rt" ]; then
        if command -v docker >/dev/null 2>&1; then
            _rt="docker"
        elif command -v podman >/dev/null 2>&1; then
            _rt="podman"
        fi
    fi
    if [ -z "$_rt" ]; then
        # No host python3 and no container runtime — there's nothing left to
        # run the parser with. Say so honestly instead of letting the caller
        # blame the token.
        echo "  ✘ python3 not found on host, and no Docker/Podman to run the" >&2
        echo "    container fallback. Install python3 (or Docker), then re-run." >&2
        return 127
    fi
    "$_rt" run --rm -i mirror.gcr.io/library/python:3-alpine python3 "$@"
}

# If a key is already populated (the wizard fetches it on the host
# machine and writes it before running setup.sh), nothing to do.
# Check both env-var names: WIREGUARD_PRIVATE_KEY is the new generic
# slot; NORDVPN_PRIVATE_KEY is the legacy one we still mirror for
# backwards compatibility.
EXISTING_KEY=$(env_val WIREGUARD_PRIVATE_KEY)
if [ -z "$EXISTING_KEY" ]; then
    EXISTING_KEY=$(env_val NORDVPN_PRIVATE_KEY)
fi
if [ -n "$EXISTING_KEY" ] && [ ${#EXISTING_KEY} -ge 43 ]; then
    echo "  ⏭ WireGuard key already set (${#EXISTING_KEY} chars) — skipping fetch."
    exit 0
fi

ACCESS_TOKEN=$(env_val NORDVPN_ACCESS_TOKEN)

# This script is invoked over a non-interactive SSH channel by the
# wizard; `read` would block forever. Bail out with a clear message
# instead. The fallback path: user fills NORDVPN_ACCESS_TOKEN in the
# wizard, or pastes the WireGuard key directly.
if [ -z "$ACCESS_TOKEN" ]; then
    echo "  ✘ No NORDVPN_ACCESS_TOKEN in .env, and no TTY for interactive input."
    echo "    Either:"
    echo "      - Set NORDVPN_ACCESS_TOKEN in .env and re-run, OR"
    echo "      - Paste your WireGuard private key directly as NORDVPN_PRIVATE_KEY, OR"
    echo "      - Set VPN_ENABLED=false to skip VPN entirely."
    echo "    Token URL: https://my.nordaccount.com/dashboard/nordvpn/manual-configuration/"
    exit 1
fi

echo ""
echo "  Fetching private key from NordVPN API..."
# Pass the access token via a 0600 --netrc-file instead of `-u token:$TOKEN`
# on the curl argv. On a multi-user NAS the argv is world-readable through
# `ps` / /proc/<pid>/cmdline for the lifetime of the request, which would
# leak the NordVPN token to any other local user. curl's --netrc-file does
# the same HTTP Basic auth (login=token, password=<token>) for the matching
# host, so behaviour is identical — only the credential is no longer on argv.
# The temp file is created with a restrictive umask and removed on exit.
NETRC_FILE=$(mktemp 2>/dev/null) || NETRC_FILE="$ENV_FILE.netrc.$$"
trap 'rm -f "$NETRC_FILE"' EXIT
( umask 077; : > "$NETRC_FILE" )  # ensure 0600 before any secret is written
printf 'machine api.nordvpn.com login token password %s\n' "$ACCESS_TOKEN" > "$NETRC_FILE"
# Parse JSON properly via python3 (already required by the rest of the
# stack) instead of grep | cut. The old regex broke silently when
# NordVPN's response changed whitespace / field ordering, leaving an
# empty PRIVATE_KEY with no diagnostic. Python parses + raises if the
# expected key is absent so we surface the actual API response.
RAW=$(curl -s --netrc-file "$NETRC_FILE" https://api.nordvpn.com/v1/users/services/credentials)
rm -f "$NETRC_FILE"; trap - EXIT  # token no longer needed; drop it immediately
if [ -z "$RAW" ]; then
    echo "  ✘ NordVPN API returned an empty body — check internet connectivity."
    exit 1
fi
PYTHON_OUT=$(printf '%s' "$RAW" | run_python -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception as e:
    print(f"ERROR: not valid JSON: {e}")
    sys.exit(0)
key = data.get("nordlynx_private_key", "")
if not key:
    msg = data.get("message") or data.get("error") or "no nordlynx_private_key in response"
    print(f"ERROR: {msg}")
    sys.exit(0)
print(key)
' 2>&1)
PY_STATUS=$?
# Surface a no-python3-and-no-runtime failure (run_python returns 127) on its
# own, so it isn't misread below as a bad/expired token. The parser itself
# always exits 0 and signals problems via the ERROR: prefix, so any non-zero
# here is the runner failing to start, not the JSON being bad.
if [ "$PY_STATUS" -ne 0 ]; then
    echo "  ✘ Could not run the JSON parser to read the NordVPN response:"
    echo "      ${PYTHON_OUT:-(no output)}"
    exit 1
fi
if [[ "$PYTHON_OUT" == ERROR:* ]]; then
    echo "  ✘ Failed to parse NordVPN API response:"
    echo "      $PYTHON_OUT"
    exit 1
fi
PRIVATE_KEY="$PYTHON_OUT"

if [ -z "$PRIVATE_KEY" ]; then
    echo "  ✘ Failed to fetch private key. Check your access token and try again."
    exit 1
fi

echo "  ✔ Private key retrieved."

# WireGuard private keys are 32 bytes = 44 base64 chars with padding.
# NordVPN's API sometimes returns 43 chars (missing trailing =). Pad it.
if [ ${#PRIVATE_KEY} -eq 43 ]; then
    PRIVATE_KEY="${PRIVATE_KEY}="
    echo "  ℹ Key was 43 chars — padded to 44 (NordVPN API omits trailing = on some accounts)"
fi

KEY_LEN=${#PRIVATE_KEY}
if [ "$KEY_LEN" -ne 44 ]; then
    echo "  ✘ Key length is $KEY_LEN — expected 44. The API may have returned an unexpected format."
    exit 1
fi

# Update BOTH env-var names so the rest of the stack finds the key
# regardless of which name it reads. WIREGUARD_PRIVATE_KEY is the
# generic name gluetun consumes; NORDVPN_PRIVATE_KEY is the legacy
# name kept for backwards compatibility with older .env templates.
if grep -q '^NORDVPN_PRIVATE_KEY=' "$ENV_FILE"; then
    sed -i "s|NORDVPN_PRIVATE_KEY=.*|NORDVPN_PRIVATE_KEY=$PRIVATE_KEY|" "$ENV_FILE"
else
    echo "NORDVPN_PRIVATE_KEY=$PRIVATE_KEY" >> "$ENV_FILE"
fi
if grep -q '^WIREGUARD_PRIVATE_KEY=' "$ENV_FILE"; then
    sed -i "s|WIREGUARD_PRIVATE_KEY=.*|WIREGUARD_PRIVATE_KEY=$PRIVATE_KEY|" "$ENV_FILE"
else
    echo "WIREGUARD_PRIVATE_KEY=$PRIVATE_KEY" >> "$ENV_FILE"
fi

echo "  ✔ .env updated with private key (44 chars)."
