# Virtual test environment (fake NAS)

A throwaway **"NAS in a box"** you can run the installer + payload against for
real, so features can be verified in practice instead of only by reading the
code. Each fake NAS runs its **own Docker daemon** (Docker-in-Docker), so when
`setup.sh` runs `docker compose up` inside it, the stack actually starts —
fully isolated from your real machine. The simulated **NAS family** (Synology /
UGREEN / generic Linux) is layered on at start-up via marker files that mirror
exactly what the installer's `env-detector` probes for, so detection classifies
the box the way a real one would.

> **Requirement:** Docker on the machine running these, and the ability to run
> **privileged** containers (Docker Desktop and Linux Docker both support it).
> DinD needs `--privileged`.

## Two ways to use it

### 1. Automated payload test (no UI)

Drops the real `nas/` payload into a fake NAS, writes a test `.env`, runs
`setup.sh` for real, and asserts the stack came up:

```bash
bash test/run-e2e.sh --family ugreen              # smoke: Prowlarr+Flaresolverr only (fast)
bash test/run-e2e.sh --family synology --profile full   # the whole stack (slow, pulls GBs)
bash test/run-e2e.sh --family generic --keep      # leave it running to poke around
```

`--family` ∈ `synology | ugreen | generic`, `--profile` ∈ `smoke | full`.
Exit code is non-zero if `setup.sh` fails, so it drops straight into CI.

### 2. Drive the real Electron installer against it

Bring up the fleet and point the wizard at the SSH port for the family you want:

```bash
docker compose -f test/compose.yml --profile all up -d --build
```

| Family        | Connect the installer to | Credentials       |
|---------------|--------------------------|-------------------|
| Synology-sim  | `localhost:2201`         | `tester` / `tester` |
| UGREEN-sim    | `localhost:2202`         | `tester` / `tester` |
| generic Linux | `localhost:2203`         | `tester` / `tester` |

The `tester` user has passwordless sudo, so the install runs end-to-end. Tear
down (and wipe the throwaway DinD state) with:

```bash
docker compose -f test/compose.yml --profile all down -v
```

## What it covers / doesn't (yet)

- ✅ The full on-NAS pipeline: folder creation, `.env` parsing, `docker compose
  up`, the Python API configuration, and `post-deploy-validate.sh` — against a
  **real** Docker daemon, per simulated family.
- ✅ Detection: each family lays the exact markers `env-detector` keys on
  (`/etc/synoinfo.conf` for Synology; Debian + `/volume1` for UGREEN; nothing
  for generic), so you can confirm the wizard classifies + defaults correctly.
- ⚠️ It does **not** drive the Electron UI automatically — use path 2 for that.
  A Playwright harness pointed at these SSH ports is the natural next step.
- ⚠️ `sys_vendor`-based UGREEN detection can't be faked (it's read-only
  `/sys`), so the UGREEN sim relies on the `Debian + /volume1` heuristic — which
  is the same fallback that protects real units whose DMI strings are unusual.

## Adding an environment config

Add a `case` arm to `entrypoint.sh` (lay the marker files + storage paths a
real unit of that family has), a service block in `compose.yml` (new SSH port +
`NAS_FAMILY`), and a path mapping in `run-e2e.sh`. Keep the base image Debian
(glibc/GNU) — it matches every real NAS family the stack targets.
