# Build your own 24/7 radio stations (AzuraCast)

This guide is about **broadcasting**. Plexamp gives you instant, auto-generated
stations for *your own* listening (see [Play your music like stations +
playlists](./MUSIC-PLAYBACK.md)). **AzuraCast** is the other kind of radio: real,
always-on **broadcast stations** — "The Pulse", a "Chill" channel, an all-90s
channel — that play around the clock and that **anyone on your network can tune
into**, like running your own little SiriusXM. You build the station, set a
playlist, switch on the AutoDJ, and it just *plays* — whether you're listening or
not.

> **In one sentence:** turn AzuraCast on in the installer, open its web player,
> point it at your NAS music folder, and create a station that broadcasts your
> library 24/7 with smooth crossfades — streamed to any device on your LAN.

> Want the simpler, instant kind of "station" just for yourself? See
> [Play your music like stations + playlists (Plexamp)](./MUSIC-PLAYBACK.md).

---

## Before you turn it on — the weight heads-up

AzuraCast is genuinely powerful, and that power comes with a footprint. It's the
**heaviest** thing in the whole stack, so it's **off by default** and you opt in
deliberately:

- **~1.4 GB image** to download on first install.
- **2 GB RAM minimum, 4 GB comfortable.** It bundles its *own* database
  (MariaDB), cache (Redis), web server (Nginx) and audio engine (Liquidsoap) all
  in one container — a complete radio station in a box.
- Best on a NAS with **4–8 GB of RAM**. On a small 2 GB box it'll run, but it'll
  be tight alongside everything else.

If that's fine for your NAS, you're going to love it. If your NAS is small and
you just want music for *yourself*, Plexamp (already set up, near-zero weight) is
the better pick — see the playback guide linked above. Nothing about AzuraCast
changes for people who leave it off.

---

## What you get

- **A real broadcast platform.** Named 24/7 stations with an **AutoDJ** that
  keeps them playing forever, **crossfades** between tracks, live **Icecast
  streams**, scheduled playlists, even live DJ hand-offs if you ever want them.
- **A web player + admin UI** at **`http://<NAS-IP>:49157`** — this is where you
  build everything.
- **Your library, read-only.** Your NAS music folder
  (`${DATA_ROOT}/Media/Music` — the very same library Lidarr fills) is mounted
  **read-only** inside AzuraCast at **`/mnt/music`**. AzuraCast can *play* your
  music but can never change or delete it.

The installer stands the container up and wires all of that in. **You** create
the stations and playlists in AzuraCast's own web UI — exactly the way you set up
Plex yourself.

---

## Step 1 — Turn it on (in the installer)

On the **Configure** screen:

1. Open the **Services** group and check **AzuraCast**. It carries a small
   "heavier service (~1.4 GB, wants 2–4 GB RAM)" note — that's the heads-up
   above, right where you flip the switch.
2. Finish the wizard and install as normal. The install is idempotent — if you
   already installed without AzuraCast, just re-run **Install** with AzuraCast
   checked; everything else is preserved.

On first install AzuraCast pulls a large image and sets up its internal database,
so **give the first boot a few minutes** before the web UI answers.

---

## Step 2 — First run: create your admin account

1. Open **`http://<NAS-IP>:49157`** in any browser on your network (replace
   `<NAS-IP>` with your NAS's LAN address — the same one you use for Plex or
   Homepage).
2. AzuraCast greets you with a **first-run setup wizard**. Create your **admin
   account** (your email + a password you choose). This account is yours — the
   installer deliberately doesn't pre-create it, just like Plex.
3. Step through the rest of the wizard's defaults. You'll land on the AzuraCast
   dashboard.

> The installer can't create the admin for you — that first account is yours to
> set. Once it's made, you're in.

---

## Step 3 — Point AzuraCast at your music (Storage Location)

Your music is already mounted inside AzuraCast at **`/mnt/music`** (read-only).
You just need to tell AzuraCast about it:

1. In the AzuraCast dashboard, go to **Administration** (the cog) → **Storage
   Locations**.
2. **Add a Storage Location**:
   - **Adapter:** Local Filesystem
   - **Path:** **`/mnt/music`**
   - Type: *Station Media* (so stations can use it).
3. Save it. This is the read-only window onto your Lidarr library — AzuraCast
   reads from it and never writes back.

---

## Step 4 — Create a station ("The Pulse")

1. Go to **Administration** → **Stations** → **Add Station**.
2. Give it a name — say **The Pulse** — and a short description. AzuraCast fills
   in sensible defaults for everything else.
3. For **Media Storage**, pick the **`/mnt/music`** storage location you just
   added (and the same for podcasts/recordings if asked — `/mnt/music` is fine).
4. Save. AzuraCast creates the station and its broadcast endpoints.

### Turn on the AutoDJ + crossfade (the "24/7" magic)

This is what makes it a *station* instead of a one-off playlist:

1. Open your station → **Profile** / **Edit** → the **AutoDJ** section.
2. Make sure the **AutoDJ is enabled** (it is by default) — this is the engine
   that keeps the station playing around the clock.
3. Set a **crossfade** (a few seconds, e.g. 2–4s) so tracks blend smoothly
   instead of hard-cutting. Save.

### Build a playlist

A station plays from **playlists**, so give it one:

1. In your station, go to **Playlists** → **Add Playlist**. Name it (e.g.
   *Everything*, or *Chill*).
2. Set it to play **across the whole day** (a "General Rotation" playlist) so the
   AutoDJ always has something to pull from.
3. Go to **Music Files**, browse your **`/mnt/music`** library, select the tracks
   or folders you want, and **assign them to the playlist**.
4. Hit **Reshuffle** / let the AutoDJ pick it up, and your station starts
   broadcasting.

You can make as many stations as you like — a mellow "Chill", a high-energy
workout channel, an all-80s run — each with its own playlists and vibe.

---

## Step 5 — Tune in

Once the station is broadcasting, listen from anywhere on your network:

- **The built-in web player.** On the AzuraCast dashboard, open your station and
  hit **play** — there's a public player page you can bookmark and share with
  anyone on your LAN.
- **A direct stream URL.** Point any media player (VLC, your phone, a smart
  speaker) at the station's stream — typically
  **`http://<NAS-IP>:8000/radio.mp3`** for the first station. AzuraCast shows
  each station's exact stream URL on its dashboard (the port lives in the
  **8000–8029** range; the first station is usually **8000**).

Drop the stream URL into VLC's *Open Network Stream*, or add it to a smart
speaker as an internet-radio favourite, and your station is on.

---

## Troubleshooting

**My music doesn't show up under Music Files (or a station says "empty").**
AzuraCast scans the storage location when you add it, but a freshly-mounted
external library sometimes needs a **manual re-scan**. Go to **Administration →
Storage Locations → `/mnt/music`** (or the station's **Music Files** view) and
trigger a **re-scan / "Process Media"**. Give it a moment on a large library.

**I get "Nonexistent file" errors, or AzuraCast can't read some tracks.**
Because `/mnt/music` is mounted **read-only** and owned outside the container,
AzuraCast occasionally trips over files it can't fully process. A **re-scan**
(above) clears most of these. Note that AzuraCast intentionally has **no write
access** to your library — that's by design, so it can never alter or delete your
music. If a specific file stays stubborn, confirm it actually exists under
`${DATA_ROOT}/Media/Music` and is a normal audio file.

**A permission note (it's normal).** AzuraCast runs as **UID/GID 1000** — its
*own* fixed user — and **does not honor PUID/PGID** like the other Mediarr
containers. The installer chowns AzuraCast's own data folders to `1000:1000`
for you, and mounts your library read-only, so there's nothing to set. If you
ever hand-edit AzuraCast's data dirs, keep them owned by `1000:1000`.

**The web UI at `:49157` (or the stream at `:8000`) won't load from another
device.** First confirm the container is up and healthy and you're using the
NAS's LAN IP. If it loads on the NAS itself but not from your phone/laptop, it's
almost certainly a **firewall** rule — the installer opens **49157** and the
**8000–8029** stream range on your LAN subnet when AzuraCast is enabled, but a
custom firewall can still block them. Make sure both **49157** (web UI) and
**8000** (stream) are allowed from your LAN.

**It feels slow / the NAS is struggling.** Re-read the weight heads-up at the
top — AzuraCast wants real RAM. On a 2 GB NAS it works but competes with
everything else; 4 GB+ makes it comfortable.

---

## Turning it off

Uncheck **AzuraCast** in the Configure screen and re-run **Install** (or
**Update**). The AzuraCast container is stopped and removed. Your **music library
is untouched** (it was only ever mounted read-only), and AzuraCast's own data
(stations, playlists, settings) is kept on disk under
`${INSTALL_DIR}/azuracast/` — so if you turn it back on later, your stations come
right back.

---

## Quick reference

| Item | Value |
|---|---|
| Web UI / admin | `http://<NAS-IP>:49157` |
| Stream URL (first station) | `http://<NAS-IP>:8000/radio.mp3` |
| Stream port range | `8000–8029` |
| Music library (inside container) | `/mnt/music` (**read-only**) → `${DATA_ROOT}/Media/Music` |
| Runs as | **UID/GID 1000** (its own — ignores PUID/PGID) |
| Image | `ghcr.io/azuracast/azuracast:stable` |
| Weight | **~1.4 GB image**, wants **2–4 GB RAM** |
| Default state | **Off** (opt-in) |
| Env keys | `ENABLE_AZURACAST`, `AZURACAST_HTTP_PORT` |
| Who builds the stations | **You**, in AzuraCast's web UI (like Plex) |

Want the simpler, instant stations just for your own listening? See
[Play your music like stations + playlists (Plexamp)](./MUSIC-PLAYBACK.md).
