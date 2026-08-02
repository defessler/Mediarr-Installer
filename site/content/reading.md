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

Both are opt-in and off by default. Added in v0.27.0.

## Two Readers, Not One

It looks like overlap. It isn't, it's a split:

- **Komga** on `http://<NAS-IP>:49158` serves **Comics and Manga**. It has a first-party Mihon extension, which is the best way to read manga on Android.
- **Kavita** on `http://<NAS-IP>:49157` serves **Books**. It has a proper EPUB reader, two-way progress sync with KOReader, and one-click send-to-Kindle.

Komga has no ebook support at all, and Kavita only gets generic OPDS on Android where Komga gets a real extension. Each one covers the other's gap. You can run either alone if you only care about one side, and plenty of people will.

Neither one downloads anything. They read files off disk, and they mount your library read-only, so nothing they do can move or delete your files.

## Getting Files In

Right now this is a drop folder, and we should be straight with you about why.

Comics have real automation available and it's coming in a later release. Books and manga are harder. Readarr, the Sonarr equivalent for books, was retired by the *arr team in June 2025 when its metadata source went away, and nothing has cleanly replaced it yet. Manga never had an indexer lane at all, because it lives on scanlation sites rather than the usenet and torrent indexers the rest of your stack uses.

So for now, copy files into:

```
<your data root>/Media/Comics/
<your data root>/Media/Manga/
<your data root>/Media/Books/
```

The installer creates all three whether or not you turn a reader on, so you can start filling them early.

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

Both are toggles on the installer's Services screen, or set them by hand in `.env`:

```
ENABLE_KOMGA=true
ENABLE_KAVITA=true
```

Re-run the installer or `bash setup.sh` and they'll appear on your [Dashboard](Dashboard) under a Reading section.

On first launch each one asks you to create an admin account, then to add a library. Point Komga's libraries at `/comics` and `/manga`, and Kavita's at `/books`. Those are the paths as the containers see them, and they map to the folders above.

## Resource Notes

Kavita is light. Komga runs on Java, and we cap it at 512MB of heap inside a 1GB container, because left alone a JVM helps itself to a quarter of your NAS's total RAM. If you have a very large comic library and Komga feels sluggish during a scan, that cap is the first thing to raise in `docker-compose.yml`.
