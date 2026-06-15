# Music downloads with Soulseek

This guide explains how to set up and use the **music download** feature in
Mediarr — **Soulseek**, wired into Lidarr so your wanted albums get found and
downloaded automatically.

> **In one sentence:** turn on Soulseek in the installer, give it a free
> Soulseek account, and `soularr` will watch Lidarr's wanted list and pull
> matching music off the Soulseek network — through your VPN — for Lidarr to
> import.

> Want to **play** your music as stations/playlists? See
> [Play your music like stations + playlists (Plexamp)](./MUSIC-PLAYBACK.md).
> Want your own **24/7 broadcast radio**? See
> [Build your own radio stations (AzuraCast)](./MUSIC-RADIO.md).

---

## What you get

Two small containers, added only when you opt in:

- **slskd** — the Soulseek client/daemon. It connects to the Soulseek network,
  searches, and downloads. It runs **inside your VPN** (the same way
  qBittorrent does), and has a web UI at **`http://<NAS-IP>:5030`**.
- **soularr** — the bridge. Every few minutes it reads Lidarr's *wanted* list,
  asks slskd to search Soulseek for each missing album, downloads the best
  match, and hands it to Lidarr to import.

Everything is **off by default** — nothing changes for existing installs unless
you explicitly enable it.

---

## Before you start

You need three things:

1. **Lidarr enabled.** Soulseek feeds Lidarr, so Lidarr must be part of your
   stack. (It's on by default.)
2. **A free Soulseek account.** Create one at
   [slsknet.org](https://www.slsknet.org) or directly in the slskd web UI on
   first run. There's no cost.
3. **A VPN is strongly recommended.** slskd routes through gluetun just like
   qBittorrent. You can run it without a VPN, but you shouldn't share a P2P
   network connection unprotected. See
   [VPN & expectations](#vpn--what-to-expect) below.

---

## Turn it on (in the installer)

On the **Configure** screen:

1. Open the **Services** group and check **Lidarr** (if it isn't already) and
   **Soulseek**. Soulseek shows a small "needs Lidarr" hint if Lidarr is off.
2. Open the **Music** group and enter the **one** thing it needs — your free
   Soulseek account:

   | Field | What to put |
   |---|---|
   | **Soulseek username** | Your Soulseek account name |
   | **Soulseek password** | Your Soulseek account password |

   That's it. Everything else (the scan interval and the internal API key) is
   under **"Optional settings — you can skip these"** with sensible defaults.

3. Finish the wizard and install as normal. The install is idempotent — if you
   already installed without Soulseek, just re-run **Install** with Soulseek
   checked; your existing data and settings are preserved.

### The "slskd API key" — you can ignore it

You may notice an *slskd API key* field under Optional settings. **Leave it
blank.** It is **not** a Soulseek login — it's just an internal secret the two
Soulseek containers use to talk to each other, and **the installer generates one
for you** automatically on first run. The only reason to ever set it yourself is
if you want to pin a specific value.

---

## How it works

```
   Lidarr  ──"I'm missing these albums"──►  soularr
                                              │
                                              │  search + download via REST
                                              ▼
                                            slskd  ──► Soulseek network
                                              │            (through your VPN)
                                              ▼
              ${DATA_ROOT}/Downloads/Soulseek  ◄── completed files land here
                                              │
                                              ▼
   Lidarr  ◄──"new music to import"───────────┘
```

- **soularr** runs a loop every `SOULARR_INTERVAL` seconds (default 300 = 5
  minutes). It is *not* a cron job — it's a self-contained loop inside the
  container, so there's nothing to schedule.
- **slskd** downloads completed files into a shared folder that Lidarr also
  sees, so Lidarr can **hardlink/import** them with no copying.
- Partial/incomplete downloads stay hidden inside slskd's own data dir, so
  Lidarr never sees a half-finished file.

### Where the music lands

| What | Path on the NAS |
|---|---|
| Downloads (shared by slskd, soularr, Lidarr) | `${DATA_ROOT}/Downloads/Soulseek` |
| slskd config | `${INSTALL_DIR}/slskd/config` |
| soularr config (`config.ini`) | `${INSTALL_DIR}/soularr/config` |
| Final imported music (by Lidarr) | `${DATA_ROOT}/Media/Music` |

---

## After install: check it's working

1. **Open the slskd web UI** at `http://<NAS-IP>:5030` — it's also a tile in the
   **Downloads** section of your Homepage dashboard. Log in with your Soulseek
   username/password. The dashboard should show **"Connected"** to the Soulseek
   network (give it a minute on first boot).
2. **Give Lidarr something to find.** In Lidarr, add an artist or mark an album
   as *Monitored* + *Search* so it lands on the wanted list.
3. **Watch soularr work.** Within one scan interval (≤5 min by default) soularr
   will search and start a download. You can follow it:
   ```bash
   docker logs -f soularr
   ```
   You'll see it connect to Lidarr and to slskd (`http://<NAS-IP>:5030`), search
   for each wanted album, and queue downloads.
4. **Confirm the import.** Completed downloads appear under
   `${DATA_ROOT}/Downloads/Soulseek` and Lidarr imports them into
   `${DATA_ROOT}/Media/Music`.

---

## VPN & what to expect

slskd egresses through the same VPN container as qBittorrent. One thing to know:

- **If your VPN provider has no port forwarding** (e.g. **NordVPN**), Soulseek
  runs **outbound-only**. Downloads still work, but **search results and the
  ability to browse some users are reduced** — this is a documented Soulseek
  behaviour, not a bug. For the best Soulseek experience, use a
  port-forwarding-capable provider (Proton, PIA, AirVPN) — the same advice that
  applies to torrent seeding.

---

## Troubleshooting

**The slskd web UI won't load at `:5030`.**
Make sure you're on **v0.7.3 or newer** — earlier builds shipped slskd on the
wrong port and the UI was unreachable. Update the installer, re-run **Update**
(or **Install**), and try again. Also confirm the VPN container (`gluetun`) is
healthy — slskd lives inside its network, so if the VPN is down, so is slskd.

**slskd says it can't log in to Soulseek.**
Double-check `SLSKD_USER`/`SLSKD_PASS` match a real Soulseek account. You can
create/verify the account directly in the slskd web UI. (Tip: a password
containing `#` is fine — v0.7.4+ no longer truncates credentials at `#`.)

**soularr runs but never downloads anything.**
- Confirm Lidarr actually has albums on its **wanted** list (Monitored +
  searched).
- Check `docker logs soularr` — if it can't reach slskd, confirm the web UI
  loads at `http://<NAS-IP>:5030`.
- Soulseek is a real P2P network: niche or brand-new releases may simply have no
  seeders. Popular albums in common formats (FLAC, MP3-320) find matches most
  reliably.

**Downloads complete but Lidarr doesn't import them.**
This is almost always a path-mapping mismatch. With a standard install all three
containers share `${DATA_ROOT}/Downloads/Soulseek`, so it should "just work." If
you customized paths, make sure slskd's download dir and Lidarr's view of it
point at the **same physical folder**.

**I see a one-time warning about a missing slskd API key.**
If you left the API key blank, set one in the **Music** group and re-run. soularr
needs it to drive slskd.

---

## Turning it off

Uncheck **Soulseek** in the Configure screen and re-run **Install** (or
**Update**). The `slskd` and `soularr` containers are stopped and removed; your
already-downloaded and imported music is untouched. Your Lidarr setup keeps
working with your other download clients (qBittorrent / SABnzbd).

---

## Quick reference

| Item | Value |
|---|---|
| slskd web UI | `http://<NAS-IP>:5030` |
| Routed through VPN | Yes (gluetun, like qBittorrent) |
| Requires | Lidarr + a free Soulseek account |
| Default state | **Off** (opt-in) |
| Scan interval | `SOULARR_INTERVAL`, default 300s |
| Shared download dir | `${DATA_ROOT}/Downloads/Soulseek` |
| Env keys | `ENABLE_SOULSEEK`, `SLSKD_USER`, `SLSKD_PASS`, `SLSKD_API_KEY`, `SOULARR_INTERVAL` |

For the technical design and implementation details, see
[`SOULSEEK-SPEC.md`](./SOULSEEK-SPEC.md).
