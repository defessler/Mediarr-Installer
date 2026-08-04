# Mediarr Installer

This page is meant as a quick reference on working in this repo and the conventions that apply here. It's aimed at Claude Code sessions, but it's just as useful for a human picking the project up.

Mediarr Installer is an Electron wizard that installs a Docker Compose media stack onto a NAS over SSH. The wizard collects settings, renders a `.env`, uploads a payload of bash and Python scripts, and runs them on the NAS. Almost every interesting bug lives in the seam between those two halves.

## The Two Halves

Understanding the split explains most of the layout:

- `installer/` - the Electron app (TypeScript, React). Runs on the user's Windows machine. Collects config, renders `.env`, drives the SSH session.
- `nas/scripts/` - the payload (bash, Python). Runs on the NAS. Everything here is uploaded and executed remotely, so a syntax error surfaces as a failed install on someone else's hardware rather than as a red squiggle in your editor.
- `site/` - the docs site (Hugo), published to dougfessler.com/Mediarr-Installer. This is canonical for user-facing docs. Edit `site/content/*.md`, not the old wiki.
- `docs/` - dev-facing docs and research notes. These stay in the repo.

The `installer/scripts/copy-nas-payload.mjs` step copies `nas/scripts/` into the app bundle at build time. That's why `npm run dev` and `npm run build` both run `copy-payload` first.

## Code Conventions

Measured from the tree, not assumed. Match what's already there:

- TypeScript - two-space indent, single quotes, no trailing semicolons, no tabs anywhere.
- Python - four-space indent, standard PEP 8. Targets whatever Python the NAS ships, so stay conservative with syntax.
- Bash - the payload runs under the NAS's `sh`/`bash`. `bash -n` it before you ship it.

We comment heavily in the payload scripts, and that's deliberate rather than clutter. A comment there usually records a live failure that cost real debugging time. When you fix something subtle, write down what the symptom looked like, not just what the fix does. The next person to read it is debugging at 1am against a NAS they can't attach a debugger to.

## Adding an Opt-In Service

This is the most common structural change, and it's the easiest one to half-finish. A new service touches roughly 18 wiring sites, and missing any single one produces a partial install that looks fine until someone toggles the feature.

The chain, in order:

1. `ENABLE_<SERVICE>` in `nas/scripts/.env.example`
2. A `profiles:` entry in `docker-compose.yml`
3. `COMPOSE_PROFILES` assembly in `setup.sh`
4. `boot-orchestrator.sh`, `setup-folders.sh`, `stop-all.sh`, `setup-firewall.sh` (the firewall one gets forgotten, and the service then works only from the NAS itself)
5. `post-deploy-validate.sh` and `relocate-stack.sh`
6. Homepage wiring in `setup-arr-config.py`
7. `env-schema.ts` and `env-render.ts` in the installer
8. `ConfigureScreen.tsx`, `DoneScreen.tsx`, and both embedded bash builders in `UpdateRunScreen.tsx`
9. `wizard.ts`, plus the affected test files

IMPORTANT: `UpdateRunScreen.tsx` contains two separate embedded bash builders. Missing them means enabling the service through Update appears to succeed and starts nothing.

### The Default-On Trap

There are two enable-check helpers and they have opposite defaults:

is_enabled - missing or empty counts as ENABLED. For services that have always been part of the stack.
is_optin_enabled - only an explicit `true`/`1`/`yes`/`on` counts. Everything new uses this.

An opt-in service checked with `is_enabled` turns itself on for every existing install that upgrades, because their `.env` has no such key. The same pair exists in four places and they all have to agree: `is_optin_enabled` in `setup.sh` and `setup-arr-config.py`, `isOptInEnabled()` in `env-render.ts`, and the explicit-true check in `env-schema.ts`.

### Key Parity

`.env.example`, `env-schema.ts`, and `env-render.ts` have to list the same keys. CI fails if they drift, which is the intended behavior. A new key needs registering in all three.

## Testing

Run the suite from `installer/`:

```
npm run test:run     # vitest, 197 tests across 20 files
npm run typecheck    # tsc on both tsconfigs
```

Two kinds of test live here, and the second is the interesting one:

- `test/unit/` - ordinary unit tests over the TypeScript.
- `test/cross-lang/` - runs the REAL bash and Python from `nas/scripts/` and asserts the installer's TypeScript agrees with it. These exist because the two halves are written in different languages against the same contract, and nothing else catches them drifting apart.

The cross-language tests extract a function out of the shipped script rather than importing the module, since these scripts do real work at import time. A nice side effect is that renaming a function breaks the test loudly instead of quietly passing against nothing.

`describe.skipIf(!PYTHON)` and `!BASH` guard the suites so a dev box without an interpreter on PATH doesn't fail the run. Don't delete `_interpreters.test.ts`, it's the guard that stops all the skipIf suites silently skipping in CI.

## Verifying a Fix

The house rule: before a green check counts, say what would turn it red. If that answer doesn't name what you just changed, it isn't verification.

In practice that means breaking the fix again and watching the test fail. Several bugs in this repo shipped with passing tests that couldn't have failed. The Prowlarr field-casing bug is the clearest example, since the test passed against camelCase either way and only a PascalCase case could ever have caught it.

Prefer an executable oracle over a note in a doc. A note gets read by whoever already knows to look. A test in `test/cross-lang/` meets the next session whether or not they thought to ask.

## Provider and Indexer Catalogs

IMPORTANT: pruning our catalog must never prune a user's install.

The catalogs in `setup-indexers.py` and `setup-bazarr-providers.py` get trimmed as sources die. That's fine for a fresh install, the dropped entry just stops being added. What must never happen is a re-run removing a provider the user has, whether they added it by hand or it came from an older catalog.

Bazarr makes this easy to get wrong. Its `enabled_providers` is an array key, so the posted list is authoritative and posting only what we know about would delete the rest. `enable_providers()` guards this by posting the union of enabled and pending. `test/cross-lang/provider-additive.test.ts` pins it, because the failure is silent and shows up months later on someone else's box as "my subtitle providers keep getting reset".

## Log Levels on the NAS

The payload scripts share a set of helpers, and the distinction is a user-facing promise rather than cosmetic:

ok - it worked.
skip - already configured, nothing to do.
info - FYI, not actionable. The wizard's issue parser ignores these.
warn - needs action, surfaced in the Issues panel. A dead or unconfigurable indexer belongs here.
fail - a stack-breaker. Reserved for things that genuinely stop the install, like Prowlarr being unreachable.

A single dead indexer is a `warn`, never a `fail`. Errors are for stack-breakers, and reddening a healthy install over one optional source misrepresents what happened.

## Releases

Release notes are generated from the tagged commit message, so write version commits as clean changelogs. Say what broke and what the user will see differently, not just which files moved.

The wizard uploads the payload from its own build. A fix committed after a tag isn't in that release, so an install running the older wizard still runs the older scripts. Worth checking when a fix "didn't work" on a live run.

## Gotchas Worth Knowing Up Front

- Prowlarr's schemas don't agree with themselves about field-name casing across implementations. Always match schema fields case-insensitively. Both `setup-indexers.py` and `setup-arr-config.py` have helpers for this, and each one exists because of a bug that presented as a connectivity failure.
- Prowlarr supports exactly seven application types. Manga has none, which is why there's no manga automation.
- Writing a config file under a running container mostly won't stick. Mylar3 and LazyLibrarian hold config in memory and write it back on shutdown, so a restart lands their save after ours. Stop, write, start.
- Both of those apps also lowercase every option name through their own writers. A case-sensitive lookup adds a second key beside the existing one, and their strict reader then raises `DuplicateOptionError` and refuses to start. That failure only appears on the second run, which is about as delayed as a bug gets.
- Generating bash from a Python heredoc eats backslashes. A literal `\n` in the output passes `bash -n` and then fails at runtime. Use `chr(92)`/`chr(10)`, or just use the Edit tool.
- `INSTALL_DIR` is not a module global in `setup-arr-config.py`. Resolve it as `env.get('INSTALL_DIR') or INSTALL_DIR_DEFAULT`, the way the rest of the file does.

## Writing

Docs and commit messages follow the `smartvoice` profile, which mostly comes down to plain words, contractions, no em dashes, and no semicolons in prose. Write like you're explaining it to a teammate.

Be straight about rough edges rather than papering over them. A doc that admits comic coverage is thinner than TV coverage is more useful than one that implies parity and leaves the reader to discover it.
