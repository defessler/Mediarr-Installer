# Ko-fi post draft — v0.21.0

Paste into <https://ko-fi.com/dougfessler> → Posts → New Post. Ko-fi's editor
takes basic markdown, so headings and links should survive a paste. Nothing
here publishes itself.

This is the second draft in the repo. The first, `KOFI-POST-2026-07.md`,
announced the docs site and Librarian arriving at all. This one is about what
Librarian can now do. If you never posted the first, the two fold together
easily: keep that post's opening and drop this post's "Re-grabbing" section
into it.

**Suggested title:** Your NAS can now re-grab a 90 GB remux as something
sensible, and actually find it first

---

Mediarr Installer is a free, open-source wizard that sets up a whole
self-hosted media stack on your NAS. Plex or Jellyfin, the arr apps, download
clients behind a VPN kill-switch, subtitles, quality profiles, and a dashboard
tying it together. You point it at your NAS, pick what you want, and it builds
the lot over SSH. No command line.

**v0.21.0** is out, and it finishes something I left half-done.

## The problem with knowing

Last release added Librarian, which tells you what's eating your array. It
ranks by bytes per hour rather than raw size, because raw size only ever finds
your longest shows. Rate finds the 90 GB two-hour remux you didn't mean to
keep.

Which was useful right up to the point where you knew exactly what the problem
was and still had to go and fix it by hand, in another app, in the right order,
without getting the order wrong.

## Now it just does it

Select some items, pick a target quality, and press a button.

**Upgrade** sets a higher profile and searches. Nothing gets deleted, and your
current file stays put until something better actually imports. No gap.

**Shrink** sets a *lower* profile first, then deletes, then searches.

That order is the whole feature. Do it the other way round and the search
happily re-grabs the exact release you were trying to get rid of, because at
that moment the old profile still says it's the best thing available. It's an
easy mistake to make by hand and an annoying one to notice, because everything
looks like it worked.

## Finding the thing you meant

A library you can't navigate is a library you don't act on, so the search is
fuzzy. Type `rmx 216` and it finds Remux-2160p. Type `sev` and it finds
Severance. Several words all have to match, so `sonarr remux` is a way of
asking which of your TV shows are remuxes. It searches title, year, quality,
codec and which app owns the item, so `x265` works as a search too.

Press `/` to jump to it. Same matching on the command line if you prefer.

## About the delete button

Librarian has no login. Anyone who can reach it on your network can use
whatever it exposes, which is completely fine for a report and completely not
fine for a delete button.

So the actions are off by default, behind their own separate switch. Turning on
the report doesn't turn on the ability to change anything. Left alone it
behaves exactly as it did before: it can't edit a profile, trigger a search, or
delete a file.

When you do switch them on, deleting refuses outright unless your arr has a
Recycle Bin configured, so nothing is unrecoverable. Every action shows you the
exact plan and waits for a second confirmation. Runs are capped. Everything
applied is logged, including the paths of deleted files, so you can find them
again.

I'd rather ship a feature with a hand-brake than a feature that's quietly one
misclick from deleting your library.

## Also in this one

Containers that crash-loop now explain themselves. The old failure said
"never became reachable, check the logs, then re-run setup", which is a dead
end when the installer's log pane is the only thing you can see, and re-running
setup does nothing for a container failing for a reason setup can't change. The
failure now carries the exit code, restart count, OOM flag and the last 25 log
lines.

There's also a docs site now, with an architecture breakdown and diagrams of
how the whole stack actually fits together:
<https://dougfessler.com/Mediarr-Installer/>

## If you want to help

It's free and it stays free. If it's saved you an evening of wrestling with
Docker Compose and path mappings, a coffee is genuinely appreciated and goes
straight back into the time I spend on it.

Bugs and requests are just as welcome:
<https://github.com/defessler/Mediarr-Installer/issues>

Thanks for reading, and thanks to everyone who's already chipped in.
