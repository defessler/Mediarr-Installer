# Adding an Opt-In Service

Moved out of `CLAUDE.md` on 2026-08-16 to keep the standing load small. Every line
number below was re-checked against the tree that day.

The most common structural change and the easiest one to half-finish. Taking
`ENABLE_KAVITA` as the probe, a service touches roughly 18 sites. Missing one gives you
a partial install that looks fine until someone toggles the feature.

1. `ENABLE_<SERVICE>` in `nas/scripts/.env.example`
2. A `profiles:` entry in `nas/scripts/docker-compose.yml`
3. `COMPOSE_PROFILES` assembly in `setup.sh`
4. `boot-orchestrator.sh`, `setup-folders.sh`, `stop-all.sh`, `setup-firewall.sh` (the
   firewall one gets forgotten, leaving the service reachable only from the NAS itself)
5. `post-deploy-validate.sh` and `relocate-stack.sh`
6. Homepage wiring in `setup-arr-config.py`
7. `env-schema.ts` and `env-render.ts` under `installer/src/shared/`
8. `ConfigureScreen.tsx`, `DoneScreen.tsx`, and both embedded bash builders in
   `UpdateRunScreen.tsx`
9. `wizard.ts` under `installer/src/renderer/store/`, plus the affected tests
10. A `site/content/*.md` page

Two traps in that list. Grepping for your new `ENABLE_<SERVICE>` key won't turn up
`setup-folders.sh`, `stop-all.sh` or `relocate-stack.sh`, because each hardcodes a
service-name list instead of reading the flag. Go straight to those lists:
`stop-all.sh`'s `PROFILES` array (line 106) and the leftover-container loop below it
(line 144), `relocate-stack.sh`'s `SERVICE_DIRS` and `STACK_CONTAINERS` (lines 106 and
110), and `setup-folders.sh`'s `CONFIG_DIRS` (lines 81-137). A plain `ENABLE_` grep is
misleading here rather than empty, since `setup-folders.sh` does mention
`ENABLE_QBITTORRENT` four times and `stop-all.sh` names `ENABLE_*` in two comments.

The second trap is `UpdateRunScreen.tsx`, which has two separate embedded bash builders
around lines 549 and 765. Miss those and enabling the service through Update appears to
succeed while starting nothing.

Each service also answers to three spellings that don't interchange. Mylar3 is
`ENABLE_MYLAR` as the env key, `mylar` as the compose profile, and `mylar3` as the
container and config dir. The wrong one silently no-ops rather than erroring.

## The Default-On Trap

Two enable-check helpers with opposite defaults:

is_enabled - a missing or empty key counts as ENABLED. For services that have always
been part of the stack.
is_optin_enabled - only an explicit `true`/`1`/`yes`/`on` counts. Everything new uses
this.

An opt-in service checked with `is_enabled` turns itself on for every existing install
that upgrades, because their `.env` has no such key. That check lives in eight named
helpers plus a set of inline case guards. All of them have to agree:

- `setup.sh:377` and `post-deploy-validate.sh:60`, both `is_optin_enabled()`
- `install-boot-resilience.sh:50`, a one-line `is_optin()`
- `setup-arr-config.py:4598`, `def is_optin_enabled(env, key)`
- `setup-dispatcharr.py:228`, `def is_optin(v)`
- `env-render.ts:485`, `isOptInEnabled`
- `UpdateRunScreen.tsx:549` and `:765`, `is_optin()` in embedded bash
- `boot-orchestrator.sh` skips the helper and inlines the same semantics as seven
  `case ... in true|1|yes|on)` guards, at lines 213, 222, 229, 232, 236, 239 and 242
- `restart-qbit.sh:176` and `:189`, the same inline shape for `ENABLE_SOULSEEK` and
  `ENABLE_PLAYLIST_SYNC`

`env-schema.ts` also inlines the accepted-value array three more times (lines 351, 376,
420) rather than calling a helper.

Only one pair on that list is machine-checked.
`test/cross-lang/enable-agreement.test.ts` pins bash `setup.sh` against TypeScript
`env-render.ts` token for token. Everything else is eyeball-enforced.
`boot-orchestrator.sh` is the one to be careful with, since it's what brings opted-in
services back after a reboot. Work down the list of helpers to widen the accepted-value
set and you'll leave the reboot path disagreeing.

## Key Parity

`.env.example`, `env-schema.ts` and `env-render.ts` have to list the same keys. The
indexer Python reads that same file. `test/cross-lang/key-parity.test.ts` and
`test/unit/env-schema-parity.test.ts` fail when they drift, which is intended.

