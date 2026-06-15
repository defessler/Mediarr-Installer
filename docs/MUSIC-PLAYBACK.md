# Play your music like stations + playlists (Plexamp)

This guide is about **listening**. Once you've got music on your NAS, this turns
that library into your own personal radio — **SiriusXM-style stations** (a
"chill" channel, a "90s" channel, an all-Tom-Petty channel) and **Spotify-style
playlists** — streamed straight from your own server. Nothing is pulled from the
internet. No subscription to anyone else. Just your music, your way, on every
device.

> **In one sentence:** the installer turned your NAS music folder into a Plex
> Music library and switched on the "smarts" that group songs by mood and sound
> — now you install the free **Plexamp** app, sign in, and press play on a
> station or a playlist made entirely from *your* library.

> Looking to **add** music instead of play it? See
> [Music downloads with Soulseek](./MUSIC-SETUP.md).

---

## What the installer set up for you

You don't have to build any of this — it's already done:

- **A Plex *Music* library.** Your NAS music folder
  (`${DATA_ROOT}/Media/Music`) is now a proper Music library inside Plex, so
  every album you have (and every new one Lidarr grabs) shows up automatically.
- **Sonic Analysis — the magic behind stations.** This is a Plex Pass feature
  that *listens* to each track and learns its "sonic fingerprint" (is it mellow
  or energetic, acoustic or electronic, and so on). That's what lets Plexamp
  build a smooth "chill evening" station or a "high-energy workout" mix that
  actually flows, instead of jumping around randomly.

> **Heads up — first run takes a while.** Sonic Analysis is doing real listening
> work on every song, and on a big library that can take **hours, even a day or
> two**, the first time. That's normal. Your music plays fine the whole time —
> and your **stations simply get smarter and richer as the analysis finishes**.
> If stations look thin on day one, give it time and check back.

---

## Step 1 — Get Plexamp

**Plexamp** is Plex's dedicated music player, and it's where all the station and
playlist goodness lives. It's free with your account. Pick whichever is easiest:

- **Install the app** — Plexamp is on **iPhone/iPad (App Store)**, **Android
  (Google Play)**, and **desktop (Mac / Windows / Linux)**. Search "Plexamp" in
  your app store, or grab it from
  [plexamp.plex.tv](https://plexamp.plex.tv).
- **Or just use the web player** — open
  [**https://plexamp.plex.tv**](https://plexamp.plex.tv) in any browser, no
  install needed. Great for trying it out on a laptop right now.

Then **sign in with your Plex account** — the same login you use for your
server. Plexamp signs you in through Plex, but it **only plays *your* server's
library**. There's no outside music catalog mixed in; everything you hear is
what's on your NAS.

> The installer can't put the app on your phone for you — that part's a quick
> install you do yourself. Once you're signed in, your NAS music is right there.

---

## Step 2 — Start a station

Stations are auto-generated, never-ending mixes pulled from your library. This is
the **SiriusXM-like** part: pick a vibe, press play, and it keeps going.

In Plexamp, you'll find stations in a few places:

- **Mood & Genre stations** — this is the SiriusXM feel. Open an artist, album,
  or your library and look for **Play Station** / the radio icon, then choose a
  **mood** (Chill, Energetic, Romantic…) or a **genre** (Rock, Jazz, Hip-Hop…).
  Plexamp leans on Sonic Analysis to keep the mood consistent — like tuning to
  "The Pulse" or a "Chill" channel, except every song is one you own.
- **Decade stations** — fancy an all-80s or all-90s run? Start a decade station
  and let it roll.
- **Artist Radio** — pick an artist and start their radio; Plexamp plays that
  artist plus sonically similar music **from your own library**.
- **Sonic Adventures** — a fun one: Plexamp builds a journey that gradually
  *morphs* from one song or mood into another across your collection. Look for
  **Sonic Adventure** when you've got a track or artist open.

Tip: the more of your library Sonic Analysis has finished, the better and more
"on-vibe" every one of these gets.

---

## Step 3 — Make a playlist

Stations are automatic; **playlists** are the ones you build by hand and keep —
the Spotify-style mixtape.

- **A regular playlist.** Find a song, album, or artist, tap the **`...`**
  (more) menu, choose **Add to Playlist**, and either pick an existing playlist
  or create a new one. Add as much as you like; reorder it however you want. It
  syncs across all your Plexamp devices.
- **A *smart* playlist** (the cool trick). Smart playlists fill themselves in
  using rules. In the **Plex Web app** go to a music library, choose **New
  Playlist**, and switch it to **Smart Playlist**, then set rules like *Genre is
  Jazz*, *Year is after 2010*, or *Rating is 4 stars+*. The playlist updates
  itself automatically as your library grows — set it once, enjoy it forever. It
  shows up in Plexamp right alongside your regular playlists.

---

## Troubleshooting

**"I don't see any stations" or "my stations look thin / boring."**

Almost always one of two things:

1. **Sonic Analysis is still running.** On a large library the first pass takes
   a long time (see the heads-up above). Stations get richer as it completes —
   check the progress (below) and give it time.
2. **Sonic Analysis isn't switched on for the library.** The installer turns it
   on for you, but if a Plex update, an older Plex build, or a pre-existing
   music library means it didn't take, you can flip the switch yourself. It's a
   one-time toggle — follow the steps below.

> **Requires Plex Pass.** The station/sonic magic is a Plex Pass feature (you
> have it). It also only appears on supported x86-64 (Intel/AMD) servers — which
> your NAS is.

### Turn Sonic Analysis on yourself (the manual switch)

**Enable it for your music library** (this is the real on/off switch):

1. Open the **Plex Web app** and pick your server.
2. Hover over the **Music** library in the left sidebar and click the **`...`**
   (or the pencil / **Edit Library**).
3. Open the **Advanced** tab.
4. Find the dropdown labeled **"Analyze audio tracks for sonic features"** (Plex
   Pass only; appears only on supported x86-64 CPUs).
5. Choose when it runs:
   - **"As a scheduled task"** = analyze gradually during the nightly
     maintenance window.
   - **"As a scheduled task and when media is added"** = start now and run
     continuously until done (**use this to kick it off immediately**).
6. **Save Changes.**

**Set a server-wide default (optional):**

Go to **Settings > Server > Library** and set **"Analyze audio tracks for sonic
features"** to the default you want. This is the default applied to libraries;
the per-library **Advanced** setting above is what actually governs a given
library.

**Watch the progress:**

Open the **Activity** menu in the top bar. It shows how many albums are left to
analyze. Sonic analysis is very CPU-heavy and can take **hours to days** for a
large library.

> **Bonus — want waveforms?** In that same **Advanced** section there's a
> separate **"Analyze audio tracks for loudness"** setting. It powers the
> **waveforms** and **Sweet Fades** (smooth song-to-song crossfades) in Plexamp.
> Turn it on too if you'd like those — it's optional and independent of the
> station smarts.

---

## Quick reference

| Item | Value |
|---|---|
| Player app | **Plexamp** — iOS / Android / desktop, or web at `https://plexamp.plex.tv` |
| Sign in with | Your **Plex account** (plays **only** your NAS library) |
| Powers stations | **Sonic Analysis** (Plex Pass; set up by the installer) |
| Music library path | `${DATA_ROOT}/Media/Music` |
| Stations | Mood, Genre, Decade, Artist Radio, Sonic Adventures |
| Playlists | Regular + Smart (rule-based, self-updating) |
| Requires | **Plex Pass** + an x86-64 server (your NAS) |
| External sources | **None** — 100% your own library |

Want to **add** more music to play here? See
[Music downloads with Soulseek](./MUSIC-SETUP.md).
