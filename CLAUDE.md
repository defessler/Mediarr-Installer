# Mediarr Installer

An Electron wizard that installs a Docker Compose media stack onto a NAS over SSH. It
collects settings, renders a `.env`, uploads a payload of bash and Python, then runs
`setup.sh` on the NAS to bring up Plex or Jellyfin plus the Arr services.

## The Two Halves

`installer/` is the Electron app (TypeScript, React) and runs on your Windows machine.
`nas/` is the payload and runs on the NAS. A syntax error in the payload surfaces as a
failed install on someone else's hardware rather than as a red squiggle in your editor,
which is why the cross-language tests exist.

`site/` is the docs site, published to dougfessler.com/Mediarr-Installer. It's a
hand-rolled `build.mjs` with two deps (marked, highlight.js), no framework and no watch
server. Edit `site/content/*.md`. `docs/` holds dev-facing research notes and audits.
Those deliberately stay out of the published site.

Be straight about rough edges on a site page rather than papering over them. A page that
admits comic coverage is thinner than TV coverage is more useful than one that implies
parity and lets the reader find out on their own. `site/content/reading.md` does exactly
that today. Keep it that way.

## Commands

There is no root `package.json`. Every npm command runs from `installer/` or from
`site/`. The root `node_modules/` holds only a stray `.vite/` cache. Don't read it as a
workspace.

From `installer/`:

```
npm run dev:mock     # whole wizard end to end, no NAS needed
npm run dev          # same wizard against a real NAS
npm run test:run     # vitest, 202 tests across 22 files
npm run typecheck    # tsc over both tsconfigs
npm run copy-payload # refresh resources/nas-payload/ from nas/
npm run build:win    # the Windows artifact
```

`dev:mock` sets `INSTALLER_MOCK=1`, which swaps ssh-service, sftp-service, env-detector
and vpn-service for fakes that emit realistic streamed output.

From `site/`, `npm run build` exits non-zero on a dead internal link or a page missing
its frontmatter title. `npm run serve` previews locally.

From the repo root, to reproduce CI's shell lint:

```
shellcheck --severity=warning -e SC2086,SC2155 \
  nas/scripts/*.sh nas/scripts/playlistsync/*.sh nas/migration/*.sh
```

`bash -n` alone won't clear CI. SC2086 and SC2155 are suppressed stack-wide on purpose.
Don't "fix" them repo-wide. SC2164, SC2064, SC2178/SC2128 and SC2221/SC2222 still block
the merge.

## The Payload Snapshot

`installer/scripts/copy-nas-payload.mjs` wipes and rewrites
`installer/resources/nas-payload/` from the whole `nas/` tree before every build, which
is why `dev`, `dev:mock` and `build` all run `copy-payload` first. It skips `.env`,
`migration/`, `node_modules` and `__pycache__`, and stamps `.payload-sha` and
`stack-version` under `scripts/`.

IMPORTANT: `installer/resources/nas-payload/` is generated and gitignored. It's a
38-file duplicate of `nas/`. A plain `grep` over the repo returns every payload file
twice. An edit made in the nas-payload copy is thrown away by the next build. Always
edit `nas/`. Use `git grep` and the copy drops out on its own.

Two more consequences. `nas/migration/` never ships, even though CI still shellchecks
and py_compiles it. And the wizard uploads the payload from its own build. A fix
committed after a tag isn't in that release. Worth checking first when a fix "didn't
work" on a live run.

## Adding an Opt-In Service

The most common structural change and the easiest one to half-finish. A service touches
roughly 18 sites across `nas/`, `installer/` and `site/`. Missing one gives you a partial
install that looks fine until someone toggles the feature. New services check their flag
with `is_optin_enabled` (only an explicit `true`/`1`/`yes`/`on` counts), never
`is_enabled`, which treats a missing key as on. The full site list, the enable-check
helpers that all have to agree, and the key-parity tests are in
`docs/opt-in-checklist.md`.

## Testing

Two directories are named `test/` and they mean different things. `installer/test/` is
the vitest suite. The repo-root `test/` is a Docker fake-NAS harness (`Dockerfile`,
`classify.sh`, `run-e2e.sh`) driven by the `e2e-detect` job, which asserts synology,
ugreen, asustor, terramaster, zimaos and generic each classify correctly.

Inside `installer/test/`:

- `unit/` - ordinary unit tests over the TypeScript.
- `cross-lang/` - runs the REAL bash and Python from `nas/scripts/` and asserts the
  installer's TypeScript agrees with it. Nothing else catches the halves drifting.

`installer/test/helpers/shell.ts` is the seam every cross-language test goes through
(`REPO_ROOT`, `NAS_SCRIPTS`, `BASH`, `PYTHON`, `extractShellFunc`, `extractPythonFunc`,
`runBash`, `runPython`, `withEnvFile`). Start there when writing a new oracle. Those
tests extract a function out of the shipped script rather than importing the module,
since these scripts do real work at import time. Renaming a function then breaks the
test loudly instead of passing against nothing.

`describe.skipIf(!BASH)` and `!PYTHON` guard the suites so a dev box missing an
interpreter doesn't fail the run. Don't delete `_interpreters.test.ts`. It's the
sentinel that stops every skipIf suite going silently green under CI. It sits in its
own file on purpose so it can't be edited away as a side effect of touching one
oracle.

Note: the cross-lang suites spawn real bash and Python subprocesses. On Windows they can
flake under parallel load. A single red in a full run that passes when re-run on its own
is usually that (observed 2026-08-05 in optin-render-gate), not a real failure.

CI triggers are narrow. installer-ci.yml only fires on `installer/**`, `nas/**`,
`test/**` or its own file. A change touching only `site/` or `docs/` never runs the
suite.

## Verifying a Fix

Before a green check counts, say what would turn it red. If that answer doesn't name
what you just changed, it isn't verification. Prefer an executable oracle under
`installer/test/cross-lang/` over a note in a doc. Two worked cases from this tree, and
why 14 files live there, are in `docs/verifying-a-fix.md`.

## Log Levels and the Glyph Contract

The payload helpers share five levels. The distinction is a user-facing promise rather
than cosmetic.

ok - it worked.
skip - already configured, nothing to do.
info - FYI, not actionable.
warn - needs action, surfaced in the Issues panel.
fail - a stack-breaker, like Prowlarr being unreachable.

A single dead indexer is a `warn`, never a `fail`.

The glyph is the contract. `RunScreen.tsx` parses the cross mark as fail, the warning
triangle as warn and `!` as note, and deliberately does NOT match the information sign
(U+2139), because surfacing info made successful installs look broken. Python's
`warn()` emits `!` while bash's emits the triangle. The same word lands at two
severities. Change a glyph and the parser stops seeing the line.

## Provider and Indexer Catalogs

IMPORTANT: pruning our catalog must never prune a user's install.

The catalogs under `nas/scripts/indexers/` get trimmed as sources die. That's fine for
a fresh install. The dropped entry just stops being added. A re-run must never remove a
provider the user already has.

Bazarr makes this easy to get wrong. Its `enabled_providers` is an array key, which
makes the posted list authoritative. Posting only what we know about would delete the
rest. `enable_providers()` posts the union of enabled and pending, which
`test/cross-lang/provider-additive.test.ts` pins. The function also has to stay
form-encoded. An earlier JSON POST was silently dropped, because Bazarr's settings
endpoint reads `request.form` and `save_settings()` then wrote nothing.

## Releases

Tags must be prefixed `installer-v`. A bare `v0.31.2` tag builds and publishes nothing,
since installer-release.yml both triggers and gates its publish on that prefix.

```
git tag installer-v0.31.2 && git push origin installer-v0.31.2
```

The tagged commit's message IS the public release notes. The workflow feeds the subject
plus body straight into the GitHub release. Write version commits as clean changelogs.
Say what broke and what the user will see differently, not which files moved.

## Conventions

Measured across the tree at time of writing. There's no eslint, prettier or
editorconfig anywhere. `npm run typecheck` is the only automated gate that comes near
style.

- TypeScript - two-space indent, single quotes, no trailing semicolons. 5728 two-space
  lines and zero tabs across `installer/src`, and zero double-quoted imports.
- Python - four-space indent, PEP 8, `snake_case`. 5052 four-space lines, zero tabs.
  Targets whatever Python the NAS ships, so stay conservative with syntax.
- Bash - four-space indent, not the two spaces common in shell. 2453 four-space lines,
  zero tabs.
- Line endings - LF. `.gitattributes` forces it for `*.sh`, `*.py`, `*.yml`, `*.yaml`
  and `.env*` because those run on Linux. TypeScript, JSON and Markdown aren't covered
  and lean on `core.autocrlf=input`.

We comment heavily in the payload scripts. That's deliberate rather than clutter. A
comment there usually records a live failure that cost real debugging time. Write down
what the symptom looked like, not just what the fix does.

## Gotchas Worth Knowing Up Front

Twelve of them, most recording a live failure that cost real debugging time, in
`docs/gotchas.md`. Read it before touching `setup-arr-config.py`, the Prowlarr wiring,
Mylar3 or LazyLibrarian config, the Windows self-updater, or README's platform claim.
