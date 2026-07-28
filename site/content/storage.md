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

**One results table** - every title, or every file, sorted and filtered however you ask. See [Finding things](#finding-things).

**Space by quality** - bytes and counts grouped by tier, which is what you look at to decide whether dropping a collection from Remux to Bluray is worth the trouble.

**Upgrade backlog** - each arr's cutoff-unmet count, meaning items it already considers below your quality bar and would replace on the next search.

**Recycle bins** - what's waiting in each arr's bin, how big it is, and how long before that arr clears it. See [The Recycle Bin](#the-recycle-bin).

**Which version you're on** - the header line carries the Mediarr version and when the wizard last deployed to this NAS. The same pair shows up as a tile on your [dashboard](dashboard). It's the quick answer to "did that update actually land?", which previously took guessing from which features the page happened to show.

**Big and never played** - last-played and play count, pulled from Tautulli on Plex or from Jellyfin's own watch data. This is the view that actually decides things.

### Individual Files, Not Just Titles

A movie is one file, so the two are the same thing. A series isn't. Sixty episodes roll up into one row, and that row is an average, which is a good way to hide a bad file.

The case worth catching: a show sitting on a 1080p profile where somebody once hand-grabbed a single episode as a 40 GB remux. The series total looks large but plausible, its dominant quality still reads WEBDL-1080p because the other fifty-nine episodes outvote the one, and nothing on the page suggests anything is wrong.

That's what the **Files** scope is for. Every file on its own, ranked however you sort it, ignoring what owns it.

Its **vs siblings** column is the signal that matters, because raw size on its own says nothing. 40 GB is normal for a feature film and absurd for one episode of a comedy. Six times the rest of the same show is unambiguous either way. Each file is compared against the median of its own siblings, so a series where *everything* is 30 GB is never flagged. Nothing about it is out of step.

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

There's **one results table**, not a stack of them. It used to be five separate cards (biggest, most bloated, never played, largest files, files out of step), which meant the same title appeared three times and you had to know which card answered your question. Those orderings are now just what the sort headers and the quick views do.

**Titles** and **Files** are two scopes of that one table, picked with the tabs above it. They stay separate because they're different rows with different actions: a title has a runtime and a play count, a file has neither. Controls that only mean something for a title hide themselves when you switch to Files, rather than sitting there doing nothing.

**Quick views** are one-click presets. *Biggest*, *Most bloated*, *Never played*, and *Out of step* each set the scope, clear the filters, and sort the right column. They're the fastest way in, and everything they do you can also do by hand.

The search box is fuzzy. Type roughly what you mean and it narrows as you go.

Matching is subsequence-based with scoring, so `rmx 216` finds `Remux-2160p` and `sev` finds `Severance`. Several words all have to match, which makes `sonarr remux` a useful way to ask "which of my TV shows are remuxes". It searches title, year, quality, codec and which app owns the item, so `x265` and `radarr` work as searches too.

Press `/` anywhere on the page to jump to the box, and Escape to clear it.

Alongside it there are plain filters for app, quality tier, minimum size, minimum rate, and never-played. Any filter that's actually narrowing the list turns cyan, so a short result set always explains itself. The rate floor is the one that catches a bloated ninety-minute film, because no size floor ever will. That film is smaller than any long series you own.

### Sorting

Every column header sorts, which is what lets one table replace five. Click a header to sort by it, click it again to flip the direction. Numbers sort on their real value rather than on the text, so 900 MB lands below 4 TB where it belongs, and number columns open on the big end because that's the end you came for.

A column you picked sticks while you type in the search box. Without one, the results re-order themselves by how well they match what you typed.

### Paging

One table with your whole library in it needs paging, so there is some. **Rows per page** is an input you set to whatever suits your screen, and it's remembered for next time. **Show all** drops the limit entirely.

Every matching row stays in the page regardless, which is what lets the filters be honest: they're filtering everything you have, not just what's currently on screen. Paging only decides how much is rendered at once.

Two behaviours worth knowing. Narrowing the filters or changing the sort puts you back on page one, since staying on page nine of a result set that just became three rows long shows you nothing. And **a selection survives paging**. Ticking something on page one and paging away doesn't quietly untick it, unlike filtering it out, which does.

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

### Changing Quality

Select the items, pick the profile you want, and press the button. There's one button, not two. Upgrade versus shrink was never really a choice you make, it's a consequence of the profile you picked compared with what each item already has, so the page works it out instead of asking.

It tells you which way it went before you commit. Pick something higher and it reads **Upgrade 3 items**, plain, with "nothing is deleted" beside it. Pick something lower and it turns red and reads **Shrink 3 items**. Select a mix and it says so: *1 of them shrink, the rest just upgrade*.

That last case is the one two buttons handled badly. A selection can be above the target for some items and below it for others, and the right answer is different per item. Only the ones actually above the target lose their files.

**Upgrading** sets the profile and triggers a search. The arr keeps your current file until something better actually imports, so nothing goes missing in the meantime. This is the safe direction, and it's why the cutoff-unmet count is a to-do list rather than a warning.

By hand: Radarr or Sonarr → select → **Mass Editor** → set the profile → search.

**Shrinking** has to delete first, and order matters. LibrARRian does it in this order for a reason:

1. Set the **lower** quality profile first.
2. Delete the existing files, through the arr so the Recycle Bin catches them.
3. Run a search.

Do it in the other order and the search re-grabs the same oversized release you were trying to get rid of, because at that moment the old profile still says it's the best thing available.

IMPORTANT: a shrink leaves the item unavailable until a new release lands, which might be minutes or might be never for something obscure. LibrARRian refuses to delete anything at all unless the arr has **Settings → Media Management → Recycle Bin** set, so deletions stay recoverable, but that safety net is only as good as the disk space you leave in the bin.

Shrinking isn't offered for Lidarr. There it would mean deleting every track file an artist owns, which is too blunt to sit behind one button. Picking a lower profile for a Lidarr artist is refused with an explanation rather than silently doing something drastic. Upgrading works normally.

One safety note on how the direction is decided: profiles are ranked by the best quality they allow, read from the arr itself. If that can't be read for some reason, the item is treated as an upgrade. Guessing wrong that way costs a re-download. Guessing wrong the other way costs the file.

### Replacing One File

Shrink works on whole items, which is the wrong tool for a single bad episode. Shrinking a series to fix one file deletes all sixty of them.

So files have their own action. Tick the files you want, press **Replace file(s)**, and LibrARRian deletes exactly those and searches for exactly what they covered. On Sonarr that means the affected episodes, not the series. The quality profile is left alone, because the point here is "this particular file is wrong", not "re-grade this show".

That distinction matters for the outlier case. The show's profile is already right. One file just doesn't match it, and re-searching under the existing profile is what fixes that.

Same rails as everything else: it refuses without a Recycle Bin, shows you the plan first, and logs what it deleted.

### The Recycle Bin

Every delete here goes through the arr, which means it lands in that arr's Recycle Bin rather than disappearing. The installer sets one up per app at `${DATA_ROOT}/.recycle/<arr>` and keeps things for **30 days**, which is more generous than the arr default of 7. After that the arr clears it on its own schedule.

There's a catch worth understanding before you shrink anything: **the bin is on the same filesystem as your media**. Deleting doesn't free space, it moves it sideways. And since a shrink also downloads a replacement, your disk usage goes *up* until the bin is cleared. On a nearly-full array that's the difference between reclaiming space and running out of it.

So LibrARRian shows you the bins directly: the path, how long each keeps things, how many files are in there, and how much space that is. A bin set to keep things forever gets called out, because an arr will never clear that one by itself.

**Empty now** deletes the contents immediately and gives the space straight back.

IMPORTANT: this is the one action here with no undo. Everything else is recoverable *because* it goes to the recycle bin first, and this is the recycle bin. It shows you the exact size and file count and asks a second time before doing anything, and what it removed goes to the audit log, but nothing catches it afterwards.

The bin folders themselves are always left in place. The arrs validate that the path exists and reject their entire media management config if it's missing, so removing them would break the next wizard run in a way that looks nothing like its cause.

Prefer not to have the button at all? It follows the same switch as everything else, see below.

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
