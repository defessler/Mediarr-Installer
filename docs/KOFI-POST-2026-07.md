# Ko-fi post draft

Paste into <https://ko-fi.com/dougfessler> → Posts → New Post. Ko-fi's editor
takes basic markdown, so the headings and links below should survive a paste.
Nothing here publishes itself.

**Suggested title:** Mediarr now has proper docs (and a storage report that
tells you what's eating your NAS)

---

Mediarr Installer is a free, open-source wizard that sets up a whole
self-hosted media stack on your NAS. Plex or Jellyfin, the arr apps,
download clients behind a VPN kill-switch, subtitles, quality profiles, and a
dashboard tying it together. You point it at your NAS, pick what you want, and
it builds the lot over SSH. No command line.

Two things landed this month that I'm happy with.

## Documentation that actually explains the thing

There's a proper docs site now:

**https://dougfessler.com/Mediarr-Installer/**

The guides that used to live on a GitHub wiki moved over, but the part I
actually wanted to write is new: an **architecture breakdown** with diagrams of
how the stack fits together. How the VPN kill-switch works without a race it
can lose. Why every arr mounts one shared `/data` and what that saves you. What
happens between clicking Request and the file appearing in Plex. What the
installer is doing on your NAS during those thirteen steps.

If you've ever wanted to understand your own media stack rather than just run
it, that's the page.

Writing it also turned up three pages that had quietly gone out of date, which
is the sort of thing you only notice when you sit down and read your own docs
end to end.

## Librarian: where did my disk go?

Every arr already knows how many bytes each movie and series takes and what
quality it grabbed. Nothing ever put those on one screen, so working out where
your space went meant paging through Radarr and doing the arithmetic yourself.

Librarian is that screen. It ranks your library by **bytes per hour**, not raw
size, which is the difference between finding your long shows and finding the
90 GB two-hour remux you didn't mean to keep. It shows space grouped by quality
tier, how much of your disk the arrs can't account for, and, if you run
Tautulli or Jellyfin, what's large and has never once been played.

It's read-only by construction. It issues nothing but GETs, so it can't edit a
profile, trigger a search, or delete anything. You can point it at a live
library without thinking twice.

There's also a guide on re-grabbing releases at a different quality, including
the bit that catches people out: upgrading and downgrading aren't symmetric, and
doing a downgrade in the wrong order just re-grabs the file you were trying to
replace.

## Also recently

- **Live TV & DVR** via Dispatcharr. Around 2,300 free ad-supported channels
  with a full guide, presented to Plex or Jellyfin as a tuner. It records
  without a Plex Pass, because Dispatcharr does the recording itself.
- Playlist Sync keeps permanent monthly archive playlists per SiriusXM station,
  so you build a listenable record of what a station was playing in any month.

## If you want to help

It's free and it stays free. If it saved you an evening of wrestling with
Docker Compose and path mappings, a coffee is genuinely appreciated and goes
straight back into the time I spend on it.

Bug reports and feature requests are just as welcome:
<https://github.com/defessler/Mediarr-Installer/issues>

Thanks for reading, and thanks to everyone who's already chipped in.
