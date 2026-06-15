// Registry of VPN providers the wizard knows how to set up via gluetun.
//
// Gluetun is the actual VPN client running in the container. It supports
// 30+ providers, each with its own auth quirks:
//   • Some use WireGuard with a private key the user pastes
//   • Some use WireGuard but also need an "addresses" tunnel IP
//   • Some require an account-number-as-username for OpenVPN
//   • A few we can fetch credentials for via an upstream API (NordVPN
//     today; future: Mullvad, ProtonVPN — both have published APIs)
//
// This registry is the single source of truth for:
//   1. The Configure-screen UI (provider picker + dynamic fields)
//   2. env-render.ts (which env-vars to emit into .env)
//   3. env-schema.ts (per-provider validation)
//   4. The "Fetch key" UX in the renderer (only renders for providers
//      with a `fetchKey` capability — NordVPN today)
//
// Every provider's `toGluetunEnv(values)` returns the EXACT set of
// env vars Gluetun expects for that provider — see gluetun's
// `wiki/Providers/<provider>.md` for the canonical list.
//
// Adding a new provider: append an entry below, update tests if any.

import type { EnvFormValues } from './env-render.js'

export type VpnProviderId =
  | 'nordvpn'
  | 'protonvpn'
  | 'mullvad'
  | 'airvpn'
  | 'surfshark'
  | 'custom'

export interface VpnField {
  /** EnvFormValues key the field reads/writes. */
  envKey: keyof EnvFormValues
  label: string
  type: 'text' | 'password' | 'textarea'
  /** Tiny instruction text rendered under the input. */
  helpHint?: string
  /** Render placeholder for the input. */
  placeholder?: string
  /** Optional client-side validator. Returns null when valid, an error
   *  message when not. Run on form-submit, not blur. */
  validate?: (v: string) => string | null
  /** When true, the field renders even on screens where empty values
   *  are normally hidden (e.g. private key after fetch). */
  required?: boolean
}

export interface VpnProvider {
  id: VpnProviderId
  label: string
  /** Where the user goes to find their key / account info. Opens
   *  externally on click. */
  helpUrl: string
  /** Short one-line summary shown next to the radio button. */
  blurb: string
  /** wireguard / openvpn — what kind of credentials we collect.
   *  Mapped to Gluetun's VPN_TYPE env var. */
  vpnType: 'wireguard' | 'openvpn'
  /** Dynamic form fields rendered in the Configure VPN section. */
  fields: VpnField[]
  /** Convert collected values into the Gluetun env vars we'll write
   *  into .env. Keys must match what Gluetun documents for this
   *  provider — wrong keys are silently ignored by gluetun. */
  toGluetunEnv(values: Partial<EnvFormValues>): Record<string, string>
  /** Set when we have an upstream API to fetch a WireGuard key for the
   *  user (NordVPN). Renderer shows a "Fetch key" button when present. */
  fetchKeyEnvVar?: keyof EnvFormValues   // env-key that holds the user's API token
}

// ── Field-validators ─────────────────────────────────────────────────────────

const wgKeyValidator = (v: string): string | null => {
  if (!v) return 'Required'
  const trimmed = v.trim()
  if (trimmed.length < 40 || trimmed.length > 60) {
    return `Expected ~44 characters; got ${trimmed.length}.`
  }
  return null
}

// ── Provider definitions ─────────────────────────────────────────────────────

const NORDVPN: VpnProvider = {
  id: 'nordvpn',
  label: 'NordVPN',
  helpUrl: 'https://my.nordaccount.com/dashboard/nordvpn/manual-configuration/',
  blurb: 'WireGuard key fetched automatically via API. Note: no port-forwarding support.',
  vpnType: 'wireguard',
  fields: [
    {
      envKey: 'NORDVPN_ACCESS_TOKEN',
      label: 'NordVPN access token',
      type: 'password',
      helpHint: 'Generate at nordaccount.com → Tokens. We exchange it for a WireGuard key and never store the token unencrypted. Heads up: NordVPN doesn\'t expose port forwarding to third parties — your qBittorrent seeding ratio will be limited. Switch to ProtonVPN/PIA if seeding matters.',
    },
    {
      envKey: 'WIREGUARD_PRIVATE_KEY',
      label: 'WireGuard private key',
      type: 'password',
      helpHint: 'Auto-filled after clicking "Fetch key", or paste manually.',
      placeholder: 'cN8x…',
      validate: wgKeyValidator,
    },
    {
      envKey: 'VPN_COUNTRIES',
      label: 'Server countries',
      type: 'text',
      helpHint: 'Comma-separated list (e.g. "United States,Canada"). Gluetun picks a server in any of these.',
      placeholder: 'United States,Canada',
    },
  ],
  toGluetunEnv: (v) => ({
    VPN_SERVICE_PROVIDER: 'nordvpn',
    VPN_TYPE: 'wireguard',
    // NORDVPN_PRIVATE_KEY is the legacy env-var name from before we
    // generalised. WIREGUARD_PRIVATE_KEY is what gluetun actually reads.
    // Carry both during the transition so old setups don't break.
    WIREGUARD_PRIVATE_KEY: v.WIREGUARD_PRIVATE_KEY ?? v.NORDVPN_PRIVATE_KEY ?? '',
    SERVER_COUNTRIES: v.VPN_COUNTRIES ?? '',
  }),
  fetchKeyEnvVar: 'NORDVPN_ACCESS_TOKEN',
}

const PROTONVPN: VpnProvider = {
  id: 'protonvpn',
  label: 'Proton VPN',
  helpUrl: 'https://account.protonvpn.com/downloads#wireguard-configuration',
  blurb: 'WireGuard config from Proton dashboard. Port forwarding supported.',
  vpnType: 'wireguard',
  fields: [
    {
      envKey: 'WIREGUARD_PRIVATE_KEY',
      label: 'WireGuard private key',
      type: 'password',
      helpHint: 'Download a WireGuard config from Proton VPN → Downloads → WireGuard configuration. Paste the PrivateKey value here.',
      validate: wgKeyValidator,
    },
    {
      envKey: 'WIREGUARD_ADDRESSES',
      label: 'WireGuard tunnel address',
      type: 'text',
      helpHint: 'From the same WireGuard config file — the "Address" line (e.g. "10.2.0.2/32").',
      placeholder: '10.2.0.2/32',
    },
    {
      envKey: 'VPN_COUNTRIES',
      label: 'Server countries',
      type: 'text',
      helpHint: 'Comma-separated. Use country names as Gluetun knows them (see helpUrl).',
      placeholder: 'United States,Netherlands',
    },
  ],
  toGluetunEnv: (v) => ({
    VPN_SERVICE_PROVIDER: 'protonvpn',
    VPN_TYPE: 'wireguard',
    WIREGUARD_PRIVATE_KEY: v.WIREGUARD_PRIVATE_KEY ?? '',
    WIREGUARD_ADDRESSES:   v.WIREGUARD_ADDRESSES ?? '',
    SERVER_COUNTRIES: v.VPN_COUNTRIES ?? '',
  }),
}

const MULLVAD: VpnProvider = {
  id: 'mullvad',
  label: 'Mullvad',
  helpUrl: 'https://mullvad.net/en/account/wireguard-config',
  blurb: 'Account number + WireGuard key.',
  vpnType: 'wireguard',
  fields: [
    {
      envKey: 'WIREGUARD_PRIVATE_KEY',
      label: 'WireGuard private key',
      type: 'password',
      helpHint: 'Generate at mullvad.net → WireGuard configuration → Add key. Paste the PrivateKey from the downloaded config.',
      validate: wgKeyValidator,
    },
    {
      envKey: 'WIREGUARD_ADDRESSES',
      label: 'WireGuard tunnel address',
      type: 'text',
      helpHint: 'The "Address" line from the same WireGuard config file (e.g. "10.66.123.45/32").',
      placeholder: '10.66.123.45/32',
    },
    {
      envKey: 'VPN_COUNTRIES',
      label: 'Server countries',
      type: 'text',
      placeholder: 'United States,Switzerland',
    },
  ],
  toGluetunEnv: (v) => ({
    VPN_SERVICE_PROVIDER: 'mullvad',
    VPN_TYPE: 'wireguard',
    WIREGUARD_PRIVATE_KEY: v.WIREGUARD_PRIVATE_KEY ?? '',
    WIREGUARD_ADDRESSES:   v.WIREGUARD_ADDRESSES ?? '',
    SERVER_COUNTRIES: v.VPN_COUNTRIES ?? '',
  }),
}

const AIRVPN: VpnProvider = {
  id: 'airvpn',
  label: 'AirVPN',
  helpUrl: 'https://airvpn.org/generator/',
  blurb: 'WireGuard config from AirVPN config generator.',
  vpnType: 'wireguard',
  fields: [
    {
      envKey: 'WIREGUARD_PRIVATE_KEY',
      label: 'WireGuard private key',
      type: 'password',
      helpHint: 'AirVPN → Client Area → Config Generator → WireGuard. Open the .conf file and copy the PrivateKey line.',
      validate: wgKeyValidator,
    },
    {
      envKey: 'WIREGUARD_PRESHARED_KEY',
      label: 'WireGuard preshared key',
      type: 'password',
      helpHint: 'From the same .conf file — the PresharedKey line.',
    },
    {
      envKey: 'WIREGUARD_ADDRESSES',
      label: 'WireGuard tunnel address',
      type: 'text',
      placeholder: '10.150.0.2/32',
    },
    {
      envKey: 'VPN_COUNTRIES',
      label: 'Server countries',
      type: 'text',
      placeholder: 'United States,Netherlands',
    },
  ],
  toGluetunEnv: (v) => ({
    VPN_SERVICE_PROVIDER: 'airvpn',
    VPN_TYPE: 'wireguard',
    WIREGUARD_PRIVATE_KEY:   v.WIREGUARD_PRIVATE_KEY ?? '',
    WIREGUARD_PRESHARED_KEY: v.WIREGUARD_PRESHARED_KEY ?? '',
    WIREGUARD_ADDRESSES:     v.WIREGUARD_ADDRESSES ?? '',
    SERVER_COUNTRIES: v.VPN_COUNTRIES ?? '',
  }),
}

const SURFSHARK: VpnProvider = {
  id: 'surfshark',
  label: 'Surfshark',
  helpUrl: 'https://my.surfshark.com/vpn/manual-setup/main/openvpn',
  blurb: 'Manual-setup username + password (OpenVPN).',
  vpnType: 'openvpn',
  fields: [
    {
      envKey: 'OPENVPN_USER',
      label: 'Manual-setup username',
      type: 'text',
      helpHint: 'Surfshark → Account → Manual Setup → "Credentials" tab. NOT your account email.',
    },
    {
      envKey: 'OPENVPN_PASSWORD',
      label: 'Manual-setup password',
      type: 'password',
      helpHint: 'Same place as the username.',
    },
    {
      envKey: 'VPN_COUNTRIES',
      label: 'Server countries',
      type: 'text',
      placeholder: 'United States',
    },
  ],
  toGluetunEnv: (v) => ({
    VPN_SERVICE_PROVIDER: 'surfshark',
    VPN_TYPE: 'openvpn',
    OPENVPN_USER:     v.OPENVPN_USER ?? '',
    OPENVPN_PASSWORD: v.OPENVPN_PASSWORD ?? '',
    SERVER_COUNTRIES: v.VPN_COUNTRIES ?? '',
  }),
}

const CUSTOM: VpnProvider = {
  id: 'custom',
  label: 'Custom / other',
  helpUrl: 'https://github.com/qdm12/gluetun-wiki/tree/main/setup/providers',
  blurb: 'Power-user escape hatch — see gluetun wiki for env vars.',
  vpnType: 'wireguard',
  fields: [
    {
      envKey: 'CUSTOM_VPN_ENV',
      label: 'Custom gluetun env block',
      type: 'textarea',
      helpHint: 'Paste any VPN_SERVICE_PROVIDER / WIREGUARD_* / OPENVPN_* env vars you need. One KEY=value per line. (FIREWALL=off is ignored — the VPN killswitch stays on to prevent leaks.)',
      placeholder: 'VPN_SERVICE_PROVIDER=pia\nVPN_TYPE=openvpn\nOPENVPN_USER=…\nOPENVPN_PASSWORD=…',
    },
  ],
  toGluetunEnv: (v) => {
    // Parse the textarea content into individual env vars. Lines
    // that aren't KEY=value are dropped silently.
    const out: Record<string, string> = {}
    for (const line of (v.CUSTOM_VPN_ENV ?? '').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const k = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim()
      if (!k) continue
      // SAFETY: never let a pasted snippet silently disable gluetun's
      // killswitch. qBittorrent is welded to gluetun's network namespace so its
      // traffic can't leak; a stray FIREWALL=off (or an internet-wide
      // FIREWALL_OUTBOUND_SUBNETS) copied from a forum would defeat that with no
      // warning. Drop those — gluetun then keeps its secure default (FIREWALL
      // on). Advanced users who truly want the killswitch off can edit compose.
      const kUpper = k.toUpperCase()
      if (kUpper === 'FIREWALL' && /^(off|false|0|no)$/i.test(val)) continue
      if (kUpper === 'FIREWALL_OUTBOUND_SUBNETS' && /(^|,)\s*0\.0\.0\.0\/0\s*(,|$)/.test(val)) continue
      out[k] = val
    }
    return out
  },
}

export const VPN_PROVIDERS: VpnProvider[] = [
  NORDVPN, PROTONVPN, MULLVAD, AIRVPN, SURFSHARK, CUSTOM,
]

export function findVpnProvider(id: string | undefined | null): VpnProvider {
  // Fallback to NordVPN so existing profiles (which assumed nordvpn was
  // the only option) keep working without explicit migration. The
  // Configure screen still surfaces the picker; this just guarantees
  // we never crash on null/undefined.
  return VPN_PROVIDERS.find((p) => p.id === id) ?? NORDVPN
}
