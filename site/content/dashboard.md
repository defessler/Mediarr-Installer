---
title: "Dashboard"
description: "Your one bookmark: a live status tile for every service in the stack."
lede: "Your one bookmark: a live status tile for every service in the stack."
group: "Using your stack"
order: 1
---
Homepage is a single web page that shows every service in your stack as a clickable status tile. One bookmark that gets you anywhere.

> **In one sentence:** open Homepage, see all your services at a glance, and click any tile to jump straight to it.

> The most common day-to-day destination from here is the request portal. See [Requesting Movies and TV](Requesting-Movies-and-TV) to start watching something new.

## What it is

Homepage is the front door to your media stack. Every service you enabled during the install (Plex, Sonarr, Radarr, Prowlarr, qBittorrent, Seerr, Bazarr, and the rest) gets its own tile. Each tile shows whether the service is running and some tiles display live stats (downloads in progress, queue size, and so on). There's nothing to configure. The installer builds it for you.

## Finding it

The installer shows the Homepage URL on the **Done** screen after install. Open it in your browser and **bookmark it**. It's the one link you need to remember.

The URL is `http://<your-NAS-IP>:<Homepage-port>` (the exact port is shown on the Done screen).

## What the tiles do

- **Click any tile** to open that service in a new tab.
- The tile color tells you at a glance whether the service is **up** (green) or unreachable.
- Some tiles show live stats - for example, qBittorrent shows active downloads and speeds.
- The **Recyclarr** tile links to the sync trigger UI (port 8889) where you can kick off a manual TRaSH Guide sync. The tile description shows which quality profiles are currently applied to Sonarr and Radarr.

## Keeping it up to date

Homepage is auto-generated from the services you enabled. If you add or remove a service later, the tiles won't update on their own. To regenerate it:

1. Open the installer and choose **Update**.
2. Select **Refresh dashboard**.
3. Reload Homepage in your browser.

## Tips

- **Start here every time.** Every guide in these docs tells you to open a service. Find it on Homepage instead of remembering port numbers.
- **Seerr is your daily driver.** For requesting a movie or show, click the Seerr tile. See [Requesting Movies and TV](Requesting-Movies-and-TV) for the full walkthrough.
- **A gray tile usually means the service is still starting up**, not broken, especially right after an install or NAS reboot. Give it a minute and refresh.
- **Lost the URL?** Re-run the installer. The Done screen always shows it.
