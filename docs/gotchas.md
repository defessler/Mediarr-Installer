# Gotchas Worth Knowing Up Front

Moved out of `CLAUDE.md` on 2026-08-16 to keep the standing load small. Every line
number below was re-checked against the tree that day.

- Prowlarr's schemas don't agree with themselves about field-name casing. Always match
  schema fields case-insensitively. Both `indexers/setup-indexers.py` and
  `setup-arr-config.py` have helpers for this. The bug behind them presented as a
  connectivity failure, which sent someone hunting container networking that was fine.
- Prowlarr supports exactly seven application types (LazyLibrarian, Lidarr, Mylar,
  Radarr, Readarr, Sonarr, Whisparr). Manga has none, which is why there's no manga
  automation. Shelfmark, ReadMeABook and ROMarr aren't on the list either. They're
  Prowlarr clients, so the link is written into them and nothing is added to Prowlarr.
- Writing a config file under a running container mostly won't stick. Mylar3 (and
  LazyLibrarian, until v0.33.0 removed it) holds config in memory and writes it back on
  shutdown. A restart lands its save after ours. Stop, write, start. Shelfmark is the
  exception: it only writes a settings file when someone saves in its UI, so write and
  restart is enough there.
- Mylar3 also lowercases every option name through its own writer. A case-sensitive
  lookup adds a second key beside the existing one, its strict reader raises
  `DuplicateOptionError`, and the app refuses to start. It only shows up on the second
  run.
- An env var that is set but empty isn't the same as unset. Shelfmark treats
  `PROWLARR_API_KEY=` as a value and locks the field in its UI, and ROMarr seeds from env
  once and never again. Both would store Prowlarr's key blank on a fresh install, where it
  doesn't exist yet at `compose up`. Neither gets its links from compose env for that
  reason.
- A service that leaves the stack keeps running. `compose up -d` never touches a
  container whose service is gone from the file. `stop_disabled_services` in `setup.sh`
  reaps LazyLibrarian by name, and `stop-all.sh` and `relocate-stack.sh` still list it.
  The Update path doesn't run `setup.sh`, so an install updated that way keeps the old
  container until a full re-run.
- Generating bash out of a Python string eats backslashes. The result still passes
  `bash -n` before it fails on a live NAS. The live example is
  `_TAG_BY_INDEXER_TEMPLATE` at `setup-arr-config.py:2789`, a plain triple-quoted (not
  raw) Python string holding a whole `/bin/sh` script through line 2854. Every shell
  line continuation inside it is written `\\` for that reason, including the curl and
  grep pipeline at 2835-2838 and the tag POST at 2850-2852. Halve one of those and the
  generated script parses fine and then breaks at runtime. Reach for `chr(92)`/`chr(10)`
  when you have to build shell text in Python, or edit the template directly with the
  Edit tool. The `@@TOKEN@@` placeholder scheme, explained in the comment just above the
  template, is there for the sibling problem of f-string brace escaping.
- `INSTALL_DIR` is not a module global in `setup-arr-config.py`. Resolve it as
  `env.get('INSTALL_DIR') or INSTALL_DIR_DEFAULT`, the way the rest of the file does.
- Komga's config dir has to be created and owned up front. Kavita is a linuxserver
  image that self-chowns `/config`. Komga is a plain JVM image with no chown safety net,
  which is why it boots and then fails to open its database. Audiobookshelf is the same.
- The payload can't assume a host Python. `setup.sh` runs Python on the host's
  `python3` when present, else inside a throwaway `python:3-alpine` container with the
  docker socket mounted. Only Docker is guaranteed.
- In `relocate-stack.sh`, gluetun is last in `STACK_CONTAINERS` on purpose. Docker
  refuses to remove it while its namespace-sharers are still up.
- The Windows self-update helper must not inherit `installDir` as its working directory
  (`updater-service.ts`). Windows won't rename a directory that is any live process's
  CWD, which is the confirmed reason a v0.16.2 self-update went through the motions,
  never applied, and never relaunched.
- Blocks stamped "AUTO-GENERATED" in `setup-arr-config.py` and the sidecar
  `playlistsync/sync.sh` rewrites on every start get overwritten. Change the generator.
  Mind the backslash rule above when that generator is a Python string.
- README.md claims the installer runs on "Windows / macOS / Linux". That's wrong.
  `installer/package.json` only has `build:win`. installer-release.yml builds on
  `windows-latest`.
