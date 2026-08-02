---
title: "Comics, Manga & Books"
description: "Komga and Kavita: read comics, manga, and ebooks off your NAS on a phone, tablet, or e-ink reader."
lede: "Two readers for the formats Plex and Jellyfin can't touch."
group: "Using your stack"
order: 11
---
Your media server can't help you here, and that's the whole reason these exist.

Plex has no support for CBZ, CBR, PDF, or EPUB. Jellyfin technically had a books plugin, but the Jellyfin project archived it in June 2026, and it never did online metadata anyway. So if you want to read comics, manga, or ebooks off your NAS, you need a reader built for it.

> **In one sentence:** turn on Komga or Kavita, drop files into a folder, and read them in a browser or on your phone.

All of this is opt-in and off by default. The readers landed in v0.27.0, the automation in v0.28.0.

## Two Readers, Not One

It looks like overlap. It isn't, it's a split:

- **Komga** on `http://<NAS-IP>:49158` serves **Comics and Manga**. It has a first-party Mihon extension, which is the best way to read manga on Android.
- **Kavita** on `http://<NAS-IP>:49157` serves **Books**. It has a proper EPUB reader, two-way progress sync with KOReader, and one-click send-to-Kindle.

Komga has no ebook support at all, and Kavita only gets generic OPDS on Android where Komga gets a real extension. Each one covers the other's gap. You can run either alone if you only care about one side, and plenty of people will.

Neither one downloads anything. They read files off disk, and they mount your library read-only, so nothing they do can move or delete your files.

## Getting Files In

Comics and books can be automated. Manga can't, and it's worth understanding why before you go looking for the setting.

### Comics and Books: Automated

Two more opt-in services, both of which work exactly like Sonarr does:

- **Mylar3** on `http://<NAS-IP>:49159` for comics. Add a series, it watches for new issues.
- **LazyLibrarian** on `http://<NAS-IP>:49160` for books. Track an author, it grabs new releases.

Both are real Prowlarr Applications, so the indexers you already set up get synced into them automatically. They use the same SABnzbd and qBittorrent as the rest of the stack, with no new accounts and no separate download path.

### What You Finish By Hand

Unlike Sonarr and Radarr, these two aren't fully configured for you, and it's better you hear that here than discover it:

- **Point each one at a download client.** Open Mylar3 or LazyLibrarian's own settings and add SABnzbd (`sabnzbd:8080`) or qBittorrent (`gluetun:49156`). The installer creates the matching SABnzbd `comics` and `books` categories for you, so you just pick them from the list.
- **Set the library folder.** `/comics` in Mylar3, `/books` in LazyLibrarian. Those are the paths the containers see.
- **Mylar3 needs a ComicVine key.** It's [free](https://comicvine.gamespot.com/api/) and goes in Mylar3's own Settings. There's no way to pass it from the installer, and without it Mylar3 runs but can't look anything up.

One more honest caveat: comic coverage on general-purpose indexers is thinner than TV or movies, so expect a lower hit rate than Sonarr gives you. That's the cost of using your own indexers rather than a comics-specific source.

On LazyLibrarian we should be straight with you: it ships with several direct-download providers built in, including Anna's Archive, Z-Library, and IRC. The installer writes those off and configures the Prowlarr-fed path instead, so it behaves like the rest of your stack out of the box. The settings are still there in its own UI. What you do with them is your call.

### Manga: Not Automated, and That's Not an Oversight

There's no manga equivalent because there's nothing to build it on. Prowlarr supports exactly seven application types and none of them is a manga app. Manga simply isn't in the usenet or torrent indexer world the way TV, movies, and comics are, so the whole Sonarr pattern has nothing to attach to. Every real manga tool scrapes scanlation sites through Mihon extensions instead, which is a separate lane with its own source questions.

Suwayomi is the tool people use, and it works well pointed at `Media/Manga`, but it ships with no extension sources at all and you'd have to supply your own. That's a decision we'd rather leave with you than make on your behalf, so it isn't bundled.

### Or Just Drop Files In

Every folder works as a plain drop target whether or not you enable any automation:

```
<your data root>/Media/Comics/
<your data root>/Media/Manga/
<your data root>/Media/Books/
```

The installer creates all three regardless, so you can start filling them early.

### The One Layout Rule That Matters

Put the files **flat, inside exactly one folder per series**. No per-volume subfolders.

```
Media/Comics/
└── Amazing Spider-Man (1963)/
    ├── Amazing Spider-Man (1963) #001.cbz
    └── Amazing Spider-Man (1963) #002.cbz
```

This one trips people up, because most guides online show a `Series/Volume 01/` shape. Komga creates a separate series for every subfolder that has files in it, at any depth, so that layout gives you a series named literally "Volume 01". Kavita separately refuses to index loose files sitting at the top of a library. Flat files in one folder per series is the shape both of them are happy with.

## Where the Metadata Comes From

Both readers pull metadata out of the files themselves rather than looking it up online:

- **Comics and manga** use a `ComicInfo.xml` file stored **inside** the `.cbz` archive. A loose XML file sitting next to the archive is read by nobody.
- **Ebooks** use the OPF metadata already inside the `.epub`. Kavita reads the Calibre series fields from it, so a series groups correctly even when the filename is a mess.

That's worth knowing because it means a tidy download usually just works, and a messy one is best fixed by injecting a `ComicInfo.xml` rather than by renaming files.

Kavita does offer online metadata lookup, but it's a paid add-on called Kavita+ at about $4 a month. The free version reads embedded metadata only. We're not routing around that, and for most libraries the embedded data is enough.

## What You Read On

The web reader in either app covers most people, and it needs no setup at all. Komga does single page, dual page, and webtoon modes. Kavita has separate EPUB and PDF readers.

Beyond the browser:

- **Android, manga and comics** - [Mihon](https://mihon.app/), pointed at Komga's extension. Offline downloads, proper right-to-left and webtoon handling, and progress syncs back to the server. Mihon isn't on the Play Store, so it's an F-Droid install or a sideload.
- **iPhone and iPad** - Panels, from the App Store, connected over OPDS. It reads CBR, CBZ, PDF, and comic EPUB in one app and writes your page progress back. Paperback is the free alternative.
- **Kobo, jailbroken Kindle, other e-ink** - KOReader, which does two-way progress sync with Kavita. Set it to **manual** sync rather than automatic. Kavita's own docs warn that automatic sync can clobber your reading position, and that's not recoverable.
- **A stock Kindle** - Kavita's send-to-Kindle button emails the book to your device. No jailbreak, no cables.
- **Your TV** - nothing, and that's deliberate. None of these work on a TV, and nobody reads manga on one.

## Turning It On

They're toggles on the installer's Services screen, or set them by hand in `.env`:

```
ENABLE_KOMGA=true            # comics + manga reader
ENABLE_KAVITA=true           # ebook reader
ENABLE_MYLAR=true            # comic automation
ENABLE_LAZYLIBRARIAN=true    # book automation
```

Pick whichever you want. A reader with no automation is a perfectly normal setup, and so is automation feeding a library you read somewhere else.

Re-run the installer or `bash setup.sh` and they'll appear on your [Dashboard](Dashboard) under a Reading section.

On first launch each one asks you to create an admin account, then to add a library. Point Komga's libraries at `/comics` and `/manga`, and Kavita's at `/books`. Those are the paths as the containers see them, and they map to the folders above.

## Resource Notes

Kavita is light. Komga runs on Java, and we cap it at 512MB of heap inside a 1GB container, because left alone a JVM helps itself to a quarter of your NAS's total RAM. If you have a very large comic library and Komga feels sluggish during a scan, that cap is the first thing to raise in `docker-compose.yml`.
