#!/usr/bin/env python3
"""
fix-plex-paths.py — Update Plex library folder paths before first boot

Directly edits the Plex SQLite database to update library folder paths.
Run this BEFORE starting the Plex container — Plex will boot with the
correct paths already in place, no API or rescan needed.

Any path stored under /volume1/Data/Media/ (the NAS host path from the
native Plex package) is rewritten to /media/... (the Docker container
path via the /media mount). All libraries are handled automatically —
no hardcoded list needed.

Usage:
    python3 fix-plex-paths.py           # dry run — shows what would change
    python3 fix-plex-paths.py --apply   # apply the changes
"""

import os
import shutil
import sqlite3
import sys
from datetime import datetime

# ── Config ────────────────────────────────────────────────────────────────────

DB_PATH = ("/volume1/docker/media/plex/config"
           "/Library/Application Support"
           "/Plex Media Server/Plug-in Support/Databases"
           "/com.plexapp.plugins.library.db")

# Any path under this NAS prefix is rewritten to the container mount prefix.
# Covers all libraries without needing a hardcoded list.
OLD_PREFIX = "/volume1/Data/Media"
NEW_PREFIX = "/media"

def remap(path):
    """Return the new path if it needs remapping, otherwise None."""
    # Match on a path-SEGMENT boundary so a sibling like /volume1/Data/MediaArchive
    # isn't rewritten as if it lived under /volume1/Data/Media.
    if path == OLD_PREFIX or path.startswith(OLD_PREFIX + '/'):
        return NEW_PREFIX + path[len(OLD_PREFIX):]
    return None

# ── Colours ───────────────────────────────────────────────────────────────────

GREEN  = "\033[32m"
RED    = "\033[31m"
YELLOW = "\033[33m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

def ok(msg):   print(f"  {GREEN}✔{RESET}  {msg}")
def fail(msg): print(f"  {RED}✘{RESET}  {msg}")
def info(msg): print(f"  {YELLOW}→{RESET}  {msg}")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    apply = "--apply" in sys.argv

    print(f"\n{BOLD}Plex Library Path Fix{RESET}")
    if not apply:
        print(f"  {YELLOW}Dry run — no changes will be made.{RESET}")
        print(f"  Run with --apply to apply.\n")
    else:
        print(f"  {GREEN}Applying changes.{RESET}\n")

    # ── Check database exists ─────────────────────────────────────────────────

    if not os.path.exists(DB_PATH):
        print(f"{RED}Error:{RESET} Plex database not found at:")
        print(f"  {DB_PATH}")
        print("\nMake sure Plex has started at least once to initialise its database.")
        sys.exit(1)

    # ── Backup before touching anything ──────────────────────────────────────

    if apply:
        backup = DB_PATH + ".bak." + datetime.now().strftime("%Y%m%d_%H%M%S")
        shutil.copy2(DB_PATH, backup)
        print(f"  Backup: {os.path.basename(backup)}")

    # ── Read current paths ────────────────────────────────────────────────────

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    # section_locations holds the folder path for each library
    cur.execute("SELECT id, root_path FROM section_locations")
    rows = cur.fetchall()

    changes_needed = 0
    changes_done   = 0

    print()
    for row_id, root_path in rows:
        new_path = remap(root_path)
        if new_path:
            changes_needed += 1
            info(f"{root_path}")
            print(f"       → {new_path}")
            if apply:
                cur.execute(
                    "UPDATE section_locations SET root_path = ? WHERE id = ?",
                    (new_path, row_id)
                )
                changes_done += 1
        else:
            print(f"  {root_path}  (no change)")

    print()

    if apply and changes_done > 0:
        con.commit()
    con.close()

    # ── Summary ───────────────────────────────────────────────────────────────

    if changes_needed == 0:
        print("All library paths are already correct — nothing to do.")
    elif not apply:
        print(f"{YELLOW}{changes_needed} path(s) would be updated.{RESET}  Run with --apply to apply.")
    else:
        ok(f"{changes_done} path(s) updated.")
        print()
        print("You can now start Plex:")
        print("  docker-compose up -d plex")


if __name__ == "__main__":
    main()
