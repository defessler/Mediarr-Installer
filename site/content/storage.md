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

Left alone, Librarian is read-only by construction rather than by promise. It issues nothing but GETs, so it can't edit a profile, trigger a search, or delete a file. It needs no credentials of its own, takes no docker socket, and mounts the install directory read-only. You can point it at a live library without thinking twice.

If you want it to *act* as well as report, that's a separate switch. See [Re-grabbing](#re-grabbing-at-a-different-quality) below.

## Finding Things

The report is only useful if you can get to the item you're thinking of, so the search box is fuzzy. Type roughly what you mean and it narrows as you go.

Matching is subsequence-based with scoring, so `rmx 216` finds `Remux-2160p` and `sev` finds `Severance`. Several words all have to match, which makes `sonarr remux` a useful way to ask "which of my TV shows are remuxes". It searches title, year, quality, codec and which app owns the item, so `x265` and `radarr` work as searches too.

Press `/` anywhere on the page to jump to the box, and Escape to clear it.

Alongside it there are plain filters for app, minimum size and never-played, and the same narrowing works on the command line:

```bash
# Fuzzy, same matcher as the web UI
python3 scripts/librarian.py --report --filter "remux"

# Combine with plain filters
python3 scripts/librarian.py --report --arr radarr --min-size 20GB --unplayed
```

## Re-Grabbing At A Different Quality

Once you know what's oversized, the next question is what to do about it. Upgrading and downgrading are not symmetric, and that catches people out.

An arr will happily replace a file with a better one. It will never replace a file with a worse one. So the two paths differ.

Librarian can drive both for you, or you can do them by hand in the arr. The actions are off by default. See [Turning on actions](#turning-on-actions) below.

### Upgrading

Select the items, pick a higher quality profile, and press **Upgrade**.

That sets the profile and triggers a search. The arr keeps your current file until something better actually imports, so nothing goes missing in the meantime. This is the safe direction, and it's why the cutoff-unmet count is a to-do list rather than a warning.

By hand: Radarr or Sonarr → select → **Mass Editor** → set the profile → search.

### Shrinking To Reclaim Space

Select the items, pick a *lower* profile, and press **Shrink**. Order matters, and Librarian does it in this order for a reason:

1. Set the **lower** quality profile first.
2. Delete the existing files, through the arr so the Recycle Bin catches them.
3. Run a search.

Do it in the other order and the search re-grabs the same oversized release you were trying to get rid of, because at that moment the old profile still says it's the best thing available.

IMPORTANT: a shrink leaves the item unavailable until a new release lands, which might be minutes or might be never for something obscure. Librarian refuses to delete anything at all unless the arr has **Settings → Media Management → Recycle Bin** set, so deletions stay recoverable, but that safety net is only as good as the disk space you leave in the bin.

Shrinking isn't offered for Lidarr. There it would mean deleting every track file an artist owns, which is too blunt to sit behind one button.

### Turning On Actions

Actions are a separate switch from the report, on the installer's **Configure** screen under Storage report, or `LIBRARIAN_ALLOW_ACTIONS=true` in `.env`.

They're separate because Librarian has no login. Anyone who can reach port 8890 on your network can use whatever it exposes, so enabling a read-only report deliberately does not also hand out a delete button.

With actions on, the guard rails are:

- Every action shows you the exact plan first, listing the items and what will happen, and waits for a second confirmation. That confirmation is single-use.
- Deletes go through the arr's API, so the Recycle Bin applies, and refuse outright without one configured.
- One run touches at most 25 items by default (`LIBRARIAN_MAX_BATCH`).
- Everything applied is appended to `librarian/actions.log` in your install directory, including the paths of deleted files, which is what makes a Recycle Bin restore possible later.
- Selection is per-app. You can't mix Radarr and Sonarr items in one action.

### Picking Targets

The report is the shortlist for both directions. Sort by bytes per hour to find what's worth shrinking, cross-reference against never-played to find what you won't miss, and read the cutoff-unmet counts to see what each arr already wants to upgrade on its own.

## Notes

- **Unaccounted bytes are normal.** Downloads in progress and extras live there too. A large number is worth a look, not an alarm.
- **Watch data needs Tautulli or Jellyfin.** On a Plex install without Tautulli, or when neither is reachable, the report degrades to size-only rather than failing.
- **Results are cached.** The page caches for ten minutes so a refresh doesn't re-scan every arr. There's a Rescan button when you want it fresh.
- **A short or empty panel means a source didn't answer.** Every failure shows as a warning line on the page rather than an error, so a single unreachable arr costs you one panel, not the whole report.
