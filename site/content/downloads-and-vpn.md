---
title: "Downloads & VPN"
description: "qBittorrent, SABnzbd, and the kill-switch that has no race to lose."
lede: "qBittorrent, SABnzbd, and the kill-switch that has no race to lose."
group: "Using your stack"
order: 6
---
This guide explains how downloading actually works in the stack, and what the VPN
is doing. You normally never need to touch any of this directly, but it's good to
understand when something looks stuck.

> **In one sentence:** Sonarr and Radarr send download jobs here automatically, and
> when the VPN is enabled, all torrent traffic travels through it. You just watch
> the queue.

> New to the stack? Requests flow in from [Requesting Movies & TV](Requesting-Movies-and-TV).
> To understand what Sonarr and Radarr are doing on the other side, see
> [Movies & TV](Movies-and-TV). VPN credentials are entered during
> [Installation](Installation).

## You probably don't need to be here

The installer wires Sonarr, Radarr, and Lidarr directly to qBittorrent and
SABnzbd, including category folders, import paths, and hardlink settings. Once
the stack is running, downloads happen silently in the background. The only
reasons to open these UIs are to check a stuck queue or confirm something is
downloading.

## qBittorrent: torrents (port :49156)

qBittorrent is the torrent client. Open it from its tile on your
[Homepage dashboard](Dashboard) or at **`http://<NAS-IP>:49156`**.

When the VPN is enabled, **qBittorrent runs entirely inside the Gluetun VPN
container.** Every byte of torrent traffic goes through your VPN. If the VPN
drops, the kill-switch fires and downloads stop. They do not leak your real IP.
This also means qBittorrent has no internet connection unless Gluetun is
connected first. The VPN is opt-in (`VPN_ENABLED=false` by default). Without it
qBittorrent runs on the regular network and your real IP is visible to peers.

When an import finishes, the original download stays in
`/data/Downloads/Torrents/Completed` and continues seeding. Sonarr/Radarr
hardlink the file into `/data/Media/...` so you're seeding from the same copy
without using extra disk space.

## SABnzbd: usenet (port :49155)

SABnzbd is the usenet client. Open it from your [Homepage dashboard](Dashboard)
or at **`http://<NAS-IP>:49155`**. Usenet is used when you have a usenet provider
and usenet indexers configured in [Prowlarr](Indexers).

Usenet is fast and **does not need the VPN**, so it runs outside Gluetun. To add a
provider, enter it during the wizard's Configure screen or go directly to
SABnzbd's **Config → Servers**. Completed files land in `/data/Downloads/Usenet/complete`
and the arrs import them the same way as torrents.

## Gluetun: the VPN container

Gluetun is the VPN container that wraps qBittorrent (and Soulseek, if you have
it enabled). You configure your VPN provider and credentials once in the
installer wizard. Gluetun supports most major providers.

One thing worth knowing: **NordVPN does not support port forwarding through
Gluetun.** Port forwarding lets peers connect back to you, which improves seeding
and torrent health. If you want better seeding, use a provider that supports it,
**ProtonVPN**, **PIA**, or **PrivateVPN** are the common picks. This is purely
optional, and downloading still works fine without port forwarding.

## Where files go

| Stage | Path |
|---|---|
| Torrent downloads | `/data/Downloads/Torrents/Completed` |
| Usenet downloads | `/data/Downloads/Usenet/complete` |
| Imported movies | `/data/Media/Movies` |
| Imported TV | `/data/Media/TV Shows` |
| Imported music | `/data/Media/Music` |

The `/data` folder is a single shared mount, so hardlinking between Downloads
and Media costs no extra disk space.

## Tips

- **All torrents stalled?** The most common cause is Gluetun not being connected.
  Check the Gluetun tile on your [Homepage dashboard](Dashboard). It should show
  a connected status and your VPN IP. You can also run `docker logs gluetun` to
  see what it's doing.
- **Restart order matters.** If you restart qBittorrent by itself it loses the
  VPN network namespace and can't connect. Always restart the whole stack with
  `docker compose down && docker compose up -d` (not `docker compose restart`,
  which brings containers up simultaneously and breaks the dependency order).
- **Queue looks healthy but nothing imports?** Check the arrs' **Activity →
  Queue** screens. Sonarr (:49152) and Radarr (:49151) show import errors there.
  A [quality profile](Quality-Profiles) mismatch or a missing [indexer](Indexers)
  are the usual causes.
- **SABnzbd not downloading?** Confirm you have at least one usenet provider
  added under SABnzbd **Config → Servers**, and that a usenet indexer is enabled
  in [Prowlarr](Indexers).
- For VPN provider setup and credentials, see the [Installation](Installation) guide.
