# Mediarr — playlistsync image.
#
# Builds the "sockseek" downloader (formerly sldl / slsk-batchdl,
# https://github.com/fiso64/sockseek) from a PINNED source tag and lands it on
# a lean Alpine runtime alongside python3 + yt-dlp + ffmpeg + the three pipeline
# scripts (poll-xmplaylist.py, plex-upload.py, sync.sh).
#
# Why build from source instead of a published image:
#   • sockseek publishes NO multi-arch container image (only Windows/Linux zips,
#     and the Linux zips are glibc with no arm64 self-contained variant).
#   • The stack's rule is "no local build on the NAS" — so this image is built
#     ONCE in CI (.github/workflows/playlistsync-image.yml) and the NAS only
#     PULLS ghcr.io/defessler/mediarr-playlistsync:latest. The build cost lives
#     in CI, never on the user's box.
#
# Pinning: SOCKSEEK_REF defaults to the v2.6.0 release tag. We deliberately do
# NOT track `master` — master's csproj has begun a TargetFramework migration
# while its Dockerfile still pins dotnet6-sdk, so master is mid-flight and
# unsafe to build reproducibly. The tag is.
#
# Multi-arch: `docker buildx ... --platform linux/amd64,linux/arm64` drives
# TARGETARCH; stage 1 maps it to the matching .NET musl RID. Self-contained +
# single-file means the runtime stage needs NO .NET runtime package at all —
# just the handful of native libs a trimmed self-contained binary links.

# ── Stage 1: compile sockseek to a self-contained, single-file musl binary ──
# Mirrors upstream's proven toolchain (LinuxServer Alpine base + dotnet6-sdk +
# PublishSingleFile/self-contained). Pinned to $BUILDPLATFORM so the SDK always
# runs NATIVELY on the (amd64) runner and CROSS-publishes to the target RID —
# emulating dotnet under QEMU for arm64 is slow and OOM-prone in CI. We omit
# PublishTrimmed deliberately: trimming is the most fragile part of a cross-arch
# publish, and upstream needed trimmer-root config to stop it stripping
# reflection targets. A ~40 MB larger, fully-intact binary is the right trade
# for a once-pulled NAS image.
FROM --platform=$BUILDPLATFORM ghcr.io/linuxserver/baseimage-alpine:3.20 AS build

ARG SOCKSEEK_REF=v2.6.0
ARG TARGETARCH

# binutils-gold/openssl/zlib/libstdc++ are the native deps the .NET musl
# publish links against; git fetches the pinned source; dotnet6-sdk compiles it.
RUN apk add --no-cache \
        git \
        binutils-gold \
        openssl \
        zlib \
        libstdc++ \
        dotnet6-sdk

WORKDIR /src

# Shallow-clone exactly the pinned tag (fiso64/slsk-batchdl redirects here).
RUN git clone --depth 1 --branch "${SOCKSEEK_REF}" \
        https://github.com/fiso64/sockseek.git .

# Map Docker's TARGETARCH to the .NET musl RID, then publish. The .csproj path
# is DISCOVERED (not hard-coded) so the build survives the project's historical
# renames (slsk-batchdl.csproj → sldl → Sockseek.Cli/Sockseek.Cli.csproj). The
# produced binary is named `sockseek` (the project's AssemblyName); we normalise
# whatever single executable lands in /out to that name so the runtime stage has
# a stable path regardless of upstream naming.
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
        amd64) RID=linux-musl-x64 ;; \
        arm64) RID=linux-musl-arm64 ;; \
        *) echo "unsupported TARGETARCH '${TARGETARCH}'" >&2; exit 1 ;; \
    esac; \
    CSPROJ="$(find . -name 'Sockseek.Cli.csproj' \
                  -o -name 'slsk-batchdl.csproj' \
                  -o -name 'sldl.csproj' | head -n1)"; \
    test -n "${CSPROJ}" || { echo 'could not locate the CLI .csproj' >&2; exit 1; }; \
    echo "building ${CSPROJ} for ${RID}"; \
    dotnet publish "${CSPROJ}" \
        -c Release \
        -r "${RID}" \
        -p:PublishSingleFile=true \
        --self-contained=true \
        -o /out; \
    rm -f /out/*.pdb /out/*.xml; \
    BIN="$(find /out -maxdepth 1 -type f ! -name '*.so' ! -name '*.dat' \
                -perm -u+x | head -n1)"; \
    test -n "${BIN}" || { echo 'no executable produced in /out' >&2; ls -la /out >&2; exit 1; }; \
    if [ "${BIN}" != "/out/sockseek" ]; then cp "${BIN}" /out/sockseek; fi; \
    chmod +x /out/sockseek

# ── Stage 2: lean runtime ────────────────────────────────────────────────────
# Plain Alpine (musl, matches the build RID). NO dotnet runtime: the binary is
# self-contained. We add only what the binary links (libstdc++, icu-libs for
# .NET globalization, zlib/openssl, ca-certificates) plus the pipeline's tools.
FROM alpine:3.20

# yt-dlp + ffmpeg power sockseek's non-Soulseek fallback; python3 runs the two
# pipeline scripts; the rest are sockseek's runtime link/cert/timezone deps.
# yt-dlp comes from Alpine's community repo (no pip / no externally-managed-env
# dance), and is refreshed each time CI rebuilds the image.
RUN apk add --no-cache \
        python3 \
        yt-dlp \
        ffmpeg \
        libstdc++ \
        icu-libs \
        zlib \
        openssl \
        ca-certificates \
        tzdata \
        tini

COPY --from=build /out/sockseek /usr/local/bin/sockseek

WORKDIR /app
COPY poll-xmplaylist.py plex-upload.py jellyfin-upload.py vpn-reset.py sync.sh /app/
RUN chmod +x /app/sync.sh /app/poll-xmplaylist.py /app/plex-upload.py /app/jellyfin-upload.py /app/vpn-reset.py

# .NET on musl: keep its temp-extract dir inside the container's writable layer.
ENV DOTNET_BUNDLE_EXTRACT_BASE_DIR=/tmp/.net

# tini reaps zombies (crond spawns sync.sh which spawns sockseek/yt-dlp); sync.sh
# with no args runs the scheduler (installs the cron from PLAYLIST_SYNC_CRON and
# execs crond in the foreground). `sync.sh run` does a single pass.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/sync.sh"]
