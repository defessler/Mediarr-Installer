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
    grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | sed 's/[[:space:]]#.*//' | tr -d '\r' | xargs
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
# Parse JSON properly via python3 (already required by the rest of the
# stack) instead of grep | cut. The old regex broke silently when
# NordVPN's response changed whitespace / field ordering, leaving an
# empty PRIVATE_KEY with no diagnostic. Python parses + raises if the
# expected key is absent so we surface the actual API response.
RAW=$(curl -s -u "token:$ACCESS_TOKEN" https://api.nordvpn.com/v1/users/services/credentials)
if [ -z "$RAW" ]; then
    echo "  ✘ NordVPN API returned an empty body — check internet connectivity."
    exit 1
fi
PYTHON_OUT=$(printf '%s' "$RAW" | python3 -c '
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
