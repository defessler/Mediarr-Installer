---
title: "Storage & Re-grabbing"
description: "LibrARRian: find what is eating your disk, and re-grab releases at a different quality."
lede: "Find what's eating your array, then decide what to do about it."
group: "Using your stack"
order: 10
---
Every arr already knows how many bytes each movie, series, and artist takes and what quality it grabbed. Nothing ever put those on one screen, so working out where your disk went meant paging through Radarr's list view and doing the arithmetic yourself.

LibrARRian is that screen. It's opt-in and off by default. Added in v0.20.0.

> **In one sentence:** turn on LibrARRian, open it, and see exactly what's eating your array and whether it's worth keeping.

## What It Shows

**Disks** - free and used per mount, read from the arr's own view so it reports the filesystem your library actually lives on.

**Unaccounted bytes** - what the filesystem says is used, minus what the arrs claim. This is your orphan detector. Failed imports, extras, other shares on the same volume, and files the arrs no longer track all land here. It's a pointer, not an accusation.

**Biggest items** - ranked by bytes per hour as well as raw size.

**Space by quality** - bytes and counts grouped by tier, which is what you look at to decide whether dropping a collection from Remux to Bluray is worth the trouble.

**Upgrade backlog** - each arr's cutoff-unmet count, meaning items it already considers below your quality bar and would replace on the next search.

**Big and never played** - last-played and play count, pulled from Tautulli on Plex or from Jellyfin's own watch data. This is the view that actually decides things.

### Individual Files, Not Just Titles

A movie is one file, so the two are the same thing. A series isn't. Sixty episodes roll up into one row, and that row is an average, which is a good way to hide a bad file.

The case worth catching: a show sitting on a 1080p profile where somebody once hand-grabbed a single episode as a 40 GB remux. The series total looks large but plausible, its dominant quality still reads WEBDL-1080p because the other fifty-nine episodes outvote the one, and nothing on the page suggests anything is wrong.

So there are two file-level views:

**Files out of step with their show** compares each file against the median of its own siblings and lists the ones well clear of it. This is the useful signal, because raw size on its own says nothing. 40 GB is normal for a feature film and absurd for one episode of a comedy. Six times the rest of the same show is unambiguous either way. A series where *everything* is 30 GB is not flagged, because nothing about it is out of step.

**Largest individual files** is the plain version: every file ranked on its own, ignoring what owns it.

### Why Bytes Per Hour

Sorting by raw size only ever finds long shows. A 90 GB twelve-hour series is completely normal. A 90 GB two-hour film is a remux you probably didn't mean to keep.

Rate separates those two cases and raw size can't. Click the **Per hour** header to sort by it, or set a rate floor in the filter bar, and what's left is a list of things worth reclaiming.

## Turning It On

Enable **LibrARRian** on the installer's **Configure** screen and finish a run. It appears on port 8890 and gets a tile under Maintenance on your [dashboard](dashboard).

You can also skip the container entirely and run the same report over SSH:

```bash
# The full report
python3 scripts/librarian.py --report

# Faster on a big TV library, skips the per-series quality breakdown
python3 scripts/librarian.py --report --fast

# Machine-readable, if you want to post-process it
python3 scripts/librarian.py --json > library.json
```

Write mode is on out of the box, so the page can re-grab as well as report. If you'd rather it only ever read, untick **Allow re-grab actions** on the same Configure screen. Set that way it issues nothing but GETs, so it can't edit a profile, trigger a search, or delete a file. See [Turning Off Actions](#turning-off-actions) below.

Either way it needs no credentials of its own, takes no docker socket, and mounts the install directory read-only.

## Finding Things

The report is only useful if you can get to the item you're thinking of, so the search box is fuzzy. Type roughly what you mean and it narrows as you go.

Matching is subsequence-based with scoring, so `rmx 216` finds `Remux-2160p` and `sev` finds `Severance`. Several words all have to match, which makes `sonarr remux` a useful way to ask "which of my TV shows are remuxes". It searches title, year, quality, codec and which app owns the item, so `x265` and `radarr` work as searches too.

Press `/` anywhere on the page to jump to the box, and Escape to clear it.

Alongside it there are plain filters for app, minimum size, minimum rate and never-played. The rate floor is the one that catches a bloated ninety-minute film, because no size floor ever will. That film is smaller than any long series you own.

### Sorting

Every column header sorts. Click one to sort by it, click it again to flip the direction. Numbers sort on their real value rather than on the text, so 900 MB lands below 4 TB where it belongs, and number columns open on the big end because that's the end you came for.

A column you picked sticks while you type in the search box. Without one, the results re-order themselves by how well they match what you typed.

### On The Command Line

The same narrowing works there:

```bash
# Fuzzy, same matcher as the web UI
python3 scripts/librarian.py --report --filter "remux"

# Combine with plain filters
python3 scripts/librarian.py --report --arr radarr --min-size 20GB --unplayed

# Bytes per hour of runtime, which --min-size can't express
python3 scripts/librarian.py --report --min-rate 4GB
```

## Re-Grabbing At A Different Quality

Once you know what's oversized, the next question is what to do about it. Upgrading and downgrading are not symmetric, and that catches people out.

An arr will happily replace a file with a better one. It will never replace a file with a worse one. So the two paths differ.

LibrARRian can drive both for you, or you can do them by hand in the arr. The buttons are there by default. See [Turning Off Actions](#turning-off-actions) if you'd rather they weren't.

### Upgrading

Select the items, pick a higher quality profile, and press **Upgrade**.

That sets the profile and triggers a search. The arr keeps your current file until something better actually imports, so nothing goes missing in the meantime. This is the safe direction, and it's why the cutoff-unmet count is a to-do list rather than a warning.

By hand: Radarr or Sonarr → select → **Mass Editor** → set the profile → search.

### Shrinking To Reclaim Space

Select the items, pick a *lower* profile, and press **Shrink**. Order matters, and LibrARRian does it in this order for a reason:

1. Set the **lower** quality profile first.
2. Delete the existing files, through the arr so the Recycle Bin catches them.
3. Run a search.

Do it in the other order and the search re-grabs the same oversized release you were trying to get rid of, because at that moment the old profile still says it's the best thing available.

IMPORTANT: a shrink leaves the item unavailable until a new release lands, which might be minutes or might be never for something obscure. LibrARRian refuses to delete anything at all unless the arr has **Settings → Media Management → Recycle Bin** set, so deletions stay recoverable, but that safety net is only as good as the disk space you leave in the bin.

Shrinking isn't offered for Lidarr. There it would mean deleting every track file an artist owns, which is too blunt to sit behind one button.

### Replacing One File

Shrink works on whole items, which is the wrong tool for a single bad episode. Shrinking a series to fix one file deletes all sixty of them.

So files have their own action. Tick the files you want, press **Replace file(s)**, and LibrARRian deletes exactly those and searches for exactly what they covered. On Sonarr that means the affected episodes, not the series. The quality profile is left alone, because the point here is "this particular file is wrong", not "re-grade this show".

That distinction matters for the outlier case. The show's profile is already right. One file just doesn't match it, and re-searching under the existing profile is what fixes that.

Same rails as everything else: it refuses without a Recycle Bin, shows you the plan first, and logs what it deleted.

### Turning Off Actions

Actions are on by default and have their own switch, on the installer's **Configure** screen under Storage report, or `LIBRARIAN_ALLOW_ACTIONS=false` in `.env`.

The switch is separate from the report because LibrARRian has no login. Anyone who can reach port 8890 on your network can use whatever it exposes. On a LAN you don't fully trust, turning this off leaves you the report without the delete button.

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
