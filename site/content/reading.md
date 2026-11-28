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

All of this is opt-in and off by default. The readers landed in v0.27.0, the automation in v0.28.0, and Shelfmark and ReadMeABook in v0.33.0.

## Two Readers, Not One

It looks like overlap. It isn't, it's a split:

- **Komga** on `http://<NAS-IP>:49158` serves **Comics and Manga**. It has a first-party Mihon extension, which is the best way to read manga on Android.
- **Kavita** on `http://<NAS-IP>:49157` serves **Books**. It has a proper EPUB reader, two-way progress sync with KOReader, and one-click send-to-Kindle.

Komga has no ebook support at all, and Kavita only gets generic OPDS on Android where Komga gets a real extension. Each one covers the other's gap. You can run either alone if you only care about one side, and plenty of people will.

Neither one downloads anything. They read files off disk, and they mount your library read-only, so nothing they do can move or delete your files.

## Getting Files In

Comics and books can be automated. Manga can't, and it's worth understanding why before you go looking for the setting.

### Comics and Books: Automated

Three more opt-in services, all of which search the indexers you already set up in Prowlarr:

- **Mylar3** on `http://<NAS-IP>:49159` for comics. Add a series, it watches for new issues.
- **Shelfmark** on `http://<NAS-IP>:49163` for ebooks and audiobooks. Look a book up, pick a release, and it lands in your library. This is the one we recommend for books.
- **LazyLibrarian** on `http://<NAS-IP>:49160` for following authors. It's marked not recommended in the installer. See [LazyLibrarian, If You Want Author Tracking](#lazylibrarian-if-you-want-author-tracking) below for why it's still there.

They use the same SABnzbd and qBittorrent as the rest of the stack, with no new accounts and no separate download path.

### Shelfmark Is a Search Page, Not a Tracker

This is the part to know before you turn it on. Mylar3 works like Sonarr. Shelfmark doesn't. You ask for a book and it fetches that book. It doesn't watch an author and grab their next release when it comes out.

Shelfmark's own README calls that a non-goal. The one piece of automation it has is an optional sync from a Hardcover shelf, which you turn on in its own settings. If you want new audiobooks requested for you as a series continues, that's what ReadMeABook does, further down this page.

What you get in exchange is very little setup. The installer writes all of this for you:

- Prowlarr - Linked with Prowlarr's real API key, so every indexer you've added is searchable.
- qBittorrent and SABnzbd - Both added as download clients when you have them on, with a `books` category and an `audiobooks` category.
- Destinations - Ebooks go to `Media/Books`, which is what Kavita reads. Audiobooks go to `Media/Audiobooks`, which is what Audiobookshelf reads.
- Path mappings - The two mappings Shelfmark needs to find what the download clients finished.

A re-run fixes a changed Prowlarr key or `QBITTORRENT_PASS`. It leaves alone anything you changed in Shelfmark's own settings, including a Prowlarr or a download client of your own on another host.

On first launch Shelfmark shows a short onboarding wizard. It asks you to pick a metadata provider, which is where book titles and covers come from. Open Library needs no key. Hardcover needs a free API token and gives better results.

Note: Shelfmark has no login out of the box. Anyone on your LAN can open it and request a book. You can turn on a login under Settings -> Security in Shelfmark.

On Shelfmark's sources we should be straight with you. Besides Prowlarr it can search direct-download sites, including Anna's Archive mirrors, Libgen, and IRC. Those are off, which is also how Shelfmark ships. The installer uses Shelfmark's lite image, which leaves out the browser those sources need. Prowlarr is the only source configured, so it behaves like the rest of your stack out of the box. The settings are still there in its own UI. What you do with them is your call.

One consequence worth knowing. With those sources off, Prowlarr is Shelfmark's only source. If the Prowlarr link doesn't get set up, Shelfmark has nothing to search and every search comes back empty with no error explaining why. The installer checks for this and warns you. The fix is to re-run the installer, or to add Prowlarr under Settings -> Prowlarr in Shelfmark.

### What You Finish By Hand in Mylar3

Unlike Sonarr, Radarr, and Shelfmark, Mylar3 isn't fully configured for you, and it's better you hear that here than discover it:

- **Point it at a download client.** Open Mylar3's own settings and add SABnzbd (`sabnzbd:8080`) or qBittorrent (`gluetun:49156`). The installer creates the matching SABnzbd `comics` category for you, so you just pick it from the list.
- **Set the library folder** to `/comics`. That's the path the container sees.
- **Mylar3 needs a ComicVine key.** It's [free](https://comicvine.gamespot.com/api/). Put it in `MYLAR_COMICVINE_KEY` and the installer writes it straight into Mylar3 for you.

  Do supply it, because of how Mylar3 fails without one: **the search page comes back completely blank.** Mylar3 returns an empty response instead of an error, so there's nothing on screen to tell you a key is missing. If you've already installed without one, paste it into Mylar3 → Settings → ComicVine and searching starts working.

One more honest caveat: comic and book coverage on general-purpose indexers is thinner than TV or movies, so expect a lower hit rate than Sonarr gives you. That's the cost of using your own indexers rather than a dedicated source.

### LazyLibrarian, If You Want Author Tracking

LazyLibrarian was the book automation here until v0.33.0, when Shelfmark took over. It came back in v0.33.1 as an option marked not recommended, for the one job Shelfmark won't do. You add an author, and it grabs their new books as they come out.

Here's how the two compare:

| | Shelfmark | LazyLibrarian |
|---|---|---|
| Set up for you | Everything: Prowlarr, both download clients, library folders | Only its API, its Prowlarr link and its provider settings |
| Audiobooks | Yes | Supported, but the installer doesn't set it up |
| Follows authors | No | Yes |
| Keeps looking for a book it hasn't found | No | Yes, from its wanted list |

If you tick both, the installer shows you this trade-off and asks which you want to keep. Running both works. They share the `books` download category and both write into `Media/Books`, so the same book can land twice if you ask both for it.

What you finish by hand in LazyLibrarian, the same kind of steps as Mylar3:

- **Point it at a download client.** Add SABnzbd (`sabnzbd:8080`) or qBittorrent (`gluetun:49156`) in its own settings, with the `books` category the installer already created.
- **Set the library folder** to `/books`. That's `Media/Books` on the NAS, which Kavita reads.

On its sources we should be straight with you too. LazyLibrarian ships with direct-download providers built in, including Anna's Archive, Z-Library, and IRC. The installer switches those off and leaves Prowlarr as its only source. If the Prowlarr link doesn't land, LazyLibrarian has nothing to search, and the installer warns you about it. The providers are still in its own settings if you decide otherwise.

If you had LazyLibrarian on before v0.33.0, its settings folder is still in your install directory. Tick it again and it picks up where it left off.

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
- **Audiobooks and podcasts** - a separate app, because they're a separate thing. See below.
- **Your TV** - nothing, and that's deliberate. None of these work on a TV, and nobody reads manga on one.

## Audiobooks and Podcasts

**Audiobookshelf** on `http://<NAS-IP>:49161` is the odd one out here, and it's opt-in like the rest:

```
ENABLE_AUDIOBOOKSHELF=true
```

It covers the two things nothing else in this stack touches. Drop audiobooks into `Media/Audiobooks` and it indexes them, tracks your position per user, and remembers where you were across devices. Podcasts are the one thing it fetches on its own, straight from RSS on a schedule, which needs no indexer and no account at all.

The apps are the good part. Android is a normal Play Store install. On iOS the official app is TestFlight-only and the beta is usually full, but that's less of a wall than it sounds: ShelfPlayer and Plappa are both on the App Store, both talk to an Audiobookshelf server, and Plappa syncs your position back.

### Getting Audiobooks In

There are two ways to fill `Media/Audiobooks` without doing it by hand. You can run either, or both.

- **Shelfmark** - The same search page as for ebooks, covered above. One book at a time, nothing to set up.
- **ReadMeABook** on `http://<NAS-IP>:49164` - Sonarr plus Seerr for audiobooks. Browse an Audible-backed catalog, request a book, or watch a series or an author and new releases are requested for you.

ReadMeABook is the heavier of the two. One container runs the app, its own PostgreSQL, and Redis, so give it a minute or two on first boot. It needs a library to import into, so turn Audiobookshelf on with it unless you use a Plex audiobook library.

The best audiobook source for either is MyAnonamouse, which is invite-only. You add it to Prowlarr yourself once you have an account.

### What You Finish By Hand in ReadMeABook

Unlike Shelfmark, ReadMeABook isn't configured for you. It keeps its settings in its own encrypted database, and the only way in is its first-run wizard. The folders already line up, so most steps are a paste and a "Test". Here's what to enter:

- Backend - Choose Audiobookshelf, and your Audible region. Pick the region carefully. Changing it later can re-request books you already have.
- Audiobookshelf - Address `http://audiobookshelf:13378`, plus an API token. In Audiobookshelf that's under Settings -> Users -> your user. Then pick your audiobook library.
- Prowlarr - Address `http://prowlarr:9696`, plus the API key from Prowlarr -> Settings -> General. Then choose which indexers it may search.
- qBittorrent - Address `http://gluetun:49156`, or `http://qbittorrent:49156` if you run without the VPN. Use your qBittorrent login.
- SABnzbd - Address `http://sabnzbd:8080`, plus its API key from SABnzbd -> Config -> General. The installer creates the `readmeabook` category for you.
- Paths - Leave the defaults. `/downloads` and `/media/audiobooks` are already the right folders.

Note: your Audiobookshelf library has to read from `/audiobooks`, which is where it sees `Media/Audiobooks`. ReadMeABook writes into that same folder.

If you use Plex for audiobooks, ReadMeABook needs that library on the Audnexus metadata agent. It matches books by the Audible ID that agent adds, and without it requests stay stuck at Downloaded.

ReadMeABook can also fetch the ebook of a book you requested. Its ebook sources include Anna's Archive, and it's off until you turn it on in its settings. Same as with Shelfmark, that's your call.

## Turning It On

They're toggles on the installer's Services screen, or set them by hand in `.env`:

```
ENABLE_KOMGA=true            # comics + manga reader
ENABLE_KAVITA=true           # ebook reader
ENABLE_MYLAR=true            # comic automation
ENABLE_SHELFMARK=true        # ebook and audiobook search
ENABLE_AUDIOBOOKSHELF=true   # audiobook and podcast player
ENABLE_READMEABOOK=true      # audiobook automation
```

Pick whichever you want. A reader with no automation is a perfectly normal setup, and so is automation feeding a library you read somewhere else.

Re-run the installer or `bash setup.sh` and they'll appear on your [Dashboard](Dashboard) under a Reading section.

On first launch each one asks you to create an admin account, then to add a library. Point Komga's libraries at `/comics` and `/manga`, and Kavita's at `/books`. Those are the paths as the containers see them, and they map to the folders above.

## Resource Notes

Kavita is light. Komga runs on Java, and we cap it at 512MB of heap inside a 1GB container, because left alone a JVM helps itself to a quarter of your NAS's total RAM. If you have a very large comic library and Komga feels sluggish during a scan, that cap is the first thing to raise in `docker-compose.yml`.
