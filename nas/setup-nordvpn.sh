#!/bin/bash
# ── NordVPN WireGuard Key Setup ──
#
# Fetches your WireGuard private key from the NordVPN API and writes
# it into the .env file automatically.
#
# Usage:
#   bash /volume1/docker/media/setup-nordvpn.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "  ✘ .env not found at $ENV_FILE"
    echo "  Copy the template first:  cp .env.example .env"
    exit 1
fi

# Helper for reading values out of .env (strips inline comments + whitespace).
env_val() {
    grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | sed 's/#.*//' | tr -d '\r' | xargs
}

# Skip entirely when the user has opted out of VPN. setup.sh applies
# docker-compose.no-vpn.yml in that case; gluetun never starts and the
# WireGuard key isn't needed.
VPN_ENABLED=$(env_val VPN_ENABLED | tr '[:upper:]' '[:lower:]')
case "$VPN_ENABLED" in
    true|1|yes|on)
        ;; # fall through to fetch
    *)
        echo "  ⏭ VPN_ENABLED=$VPN_ENABLED — skipping NordVPN key fetch (no VPN)."
        exit 0
        ;;
esac

# If a key is already populated (the wizard fetches it on the host
# machine and writes it before running setup.sh), nothing to do.
EXISTING_KEY=$(env_val NORDVPN_PRIVATE_KEY)
if [ -n "$EXISTING_KEY" ] && [ ${#EXISTING_KEY} -ge 43 ]; then
    echo "  ⏭ NORDVPN_PRIVATE_KEY already set (${#EXISTING_KEY} chars) — skipping fetch."
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
PRIVATE_KEY=$(curl -s -u "token:$ACCESS_TOKEN" https://api.nordvpn.com/v1/users/services/credentials | grep -o '"nordlynx_private_key":"[^"]*"' | cut -d'"' -f4)

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

# Update NORDVPN_PRIVATE_KEY in .env
sed -i "s|NORDVPN_PRIVATE_KEY=.*|NORDVPN_PRIVATE_KEY=$PRIVATE_KEY|" "$ENV_FILE"

echo "  ✔ .env updated with private key (44 chars)."
