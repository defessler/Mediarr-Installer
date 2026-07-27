---
title: "Storage & Re-grabbing"
description: "Librarian: find what is eating your disk, and re-grab releases at a different quality."
lede: "Find what's eating your array, then decide what to do about it."
group: "Using your stack"
order: 10
---
Every arr already knows how many bytes each movie, series, and artist takes and what quality it grabbed. Nothing ever put those on one screen, so working out where your disk went meant paging through Radarr's list view and doing the arithmetic yourself.

Librarian is that screen. It's opt-in and off by default. Added in v0.20.0.

> **In one sentence:** turn on Librarian, open it, and see exactly what's eating your array and whether it's worth keeping.

## What It Shows

**Disks** - free and used per mount, read from the arr's own view so it reports the filesystem your library actually lives on.

**Unaccounted bytes** - what the filesystem says is used, minus what the arrs claim. This is your orphan detector. Failed imports, extras, other shares on the same volume, and files the arrs no longer track all land here. It's a pointer, not an accusation.

**Biggest items** - ranked by bytes per hour as well as raw size.

**Space by quality** - bytes and counts grouped by tier, which is what you look at to decide whether dropping a collection from Remux to Bluray is worth the trouble.

**Upgrade backlog** - each arr's cutoff-unmet count, meaning items it already considers below your quality bar and would replace on the next search.

**Big and never played** - last-played and play count, pulled from Tautulli on Plex or from Jellyfin's own watch data. This is the view that actually decides things.

### Why Bytes Per Hour

Sorting by raw size only ever finds long shows. A 90 GB twelve-hour series is completely normal. A 90 GB two-hour film is a remux you probably didn't mean to keep.

Rate separates those two cases and raw size can't. It's the column to sort by when you're hunting for space to reclaim.

## Turning It On

Enable **Librarian** on the installer's **Configure** screen and finish a run. It appears on port 8890 and gets a tile under Maintenance on your [dashboard](dashboard).

You can also skip the container entirely and run the same report over SSH:

```bash
# The full report
python3 scripts/librarian.py --report

# Faster on a big TV library, skips the per-series quality breakdown
python3 scripts/librarian.py --report --fast

# Machine-readable, if you want to post-process it
python3 scripts/librarian.py --json > library.json
```

Librarian is read-only by construction rather than by promise. It issues nothing but GETs, so it can't edit a profile, trigger a search, or delete a file. It needs no credentials of its own, takes no docker socket, and mounts the install directory read-only. You can point it at a live library without thinking twice.

## Re-Grabbing At A Different Quality

Once you know what's oversized, the next question is what to do about it. Upgrading and downgrading are not symmetric, and that catches people out.

An arr will happily replace a file with a better one. It will never replace a file with a worse one. So the two paths differ:

### Upgrading

Open Radarr or Sonarr, select the items, use **Mass Editor** to set a higher quality profile, then run a search.

The arr keeps your current file until something better actually imports, so nothing goes missing in the meantime. This is the safe direction, and it's why the cutoff-unmet count is just a to-do list rather than a warning.

### Downgrading To Reclaim Space

Order matters here:

1. Set the **lower** quality profile first.
2. Delete the existing file.
3. Run a search.

Do it in the other order and the search re-grabs the same oversized release you were trying to get rid of, because at that moment the old profile still says it's the best available.

IMPORTANT: a downgrade leaves the item unavailable until the new release lands, which might be minutes or might be never for something obscure. Before deleting anything, check **Settings → Media Management → Recycle Bin** has a path set. With a Recycle Bin configured, a delete through the arr is recoverable. Without one, it isn't.

### Picking Targets

Librarian's report is the shortlist for both directions. Sort by bytes per hour to find what's worth shrinking, cross-reference against never-played to find what you won't miss, and read the cutoff-unmet counts to see what each arr already wants to upgrade on its own.

## Notes

- **Unaccounted bytes are normal.** Downloads in progress and extras live there too. A large number is worth a look, not an alarm.
- **Watch data needs Tautulli or Jellyfin.** On a Plex install without Tautulli, or when neither is reachable, the report degrades to size-only rather than failing.
- **Results are cached.** The page caches for ten minutes so a refresh doesn't re-scan every arr. There's a Rescan button when you want it fresh.
- **A short or empty panel means a source didn't answer.** Every failure shows as a warning line on the page rather than an error, so a single unreachable arr costs you one panel, not the whole report.
