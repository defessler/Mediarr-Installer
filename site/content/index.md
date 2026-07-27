---
title: "Mediarr Installer"
description: "A GUI wizard that sets up a complete self-hosted media stack on your NAS. Plex or Jellyfin, the arr apps, a VPN kill-switch, and no command line."
layout: home
nav: Home
navOrder: 1
---
<div class="hero">
  <h1>Mediarr Installer</h1>
  <p class="headline">a whole media stack on your NAS, without the command line</p>
  <p class="hero-lede">
    Point the wizard at your NAS, pick what you want, and it builds the lot over SSH.
    Plex or Jellyfin, the arr apps, download clients behind a VPN kill-switch,
    subtitles, quality profiles, and a dashboard tying it together. You request a
    movie, show, or album. The stack finds it, downloads it, organises it, and
    streams it to anything on your network.
  </p>
  <div class="hero-cta">
    <a class="btn-cta btn-cta-primary" href="https://github.com/defessler/Mediarr-Installer/releases/latest">download</a>
    <a class="btn-cta" href="installation/">install guide</a>
    <a class="btn-cta" href="architecture/">how it works</a>
    <a class="btn-cta" href="https://github.com/defessler/Mediarr-Installer">source</a>
  </div>
</div>

<div class="home-section">
<h2>what it sets up</h2>

<div class="card-grid">
  <div class="card">
    <div class="card-meta">media server</div>
    <h3>Plex or Jellyfin</h3>
    <p>Your pick. Libraries, remote access, and a request portal so other people in the house can ask for things without asking you.</p>
  </div>
  <div class="card">
    <div class="card-meta">automation</div>
    <h3>Sonarr · Radarr · Lidarr</h3>
    <p>TV, movies, and music. Add a title once and they track it, grab it at the quality you asked for, and rename it properly.</p>
  </div>
  <div class="card">
    <div class="card-meta">indexers</div>
    <h3>Prowlarr</h3>
    <p>One place to manage every tracker and usenet indexer. Add it once and Prowlarr pushes it into all three arrs.</p>
  </div>
  <div class="card">
    <div class="card-meta">downloads</div>
    <h3>qBittorrent · SABnzbd</h3>
    <p>Torrents run inside the VPN container's own network stack, so there's no kill-switch race to lose. Usenet runs alongside.</p>
  </div>
  <div class="card">
    <div class="card-meta">quality</div>
    <h3>Recyclarr · Bazarr</h3>
    <p>TRaSH Guide quality profiles synced in, and subtitles fetched automatically in whichever languages you want.</p>
  </div>
  <div class="card">
    <div class="card-meta">dashboard</div>
    <h3>Homepage</h3>
    <p>One bookmark. Every service as a live status tile, generated from whatever you actually chose to install.</p>
  </div>
</div>
</div>

<div class="home-section">
<h2>opt-in extras</h2>

<div class="card-grid">
  <div class="card">
    <div class="card-meta">off by default</div>
    <h3>Live TV &amp; DVR <span class="tag tag-optin">opt-in</span></h3>
    <p>Around 2,300 free ad-supported channels with a full guide, presented to your media server as a tuner. Records without a Plex Pass. <a href="live-tv/">read more</a></p>
  </div>
  <div class="card">
    <div class="card-meta">off by default</div>
    <h3>Storage report <span class="tag tag-optin">opt-in</span></h3>
    <p>What's eating your array, ranked by bytes per hour rather than raw size, and what you've never once played. <a href="storage/">read more</a></p>
  </div>
  <div class="card">
    <div class="card-meta">off by default</div>
    <h3>Soulseek for music <span class="tag tag-optin">opt-in</span></h3>
    <p>slskd wired into Lidarr, so wanted albums get found on the network that actually has them. <a href="music-setup/">read more</a></p>
  </div>
  <div class="card">
    <div class="card-meta">off by default</div>
    <h3>Playlist Sync <span class="tag tag-optin">opt-in</span></h3>
    <p>SiriusXM channels mirrored into your library as real playlists, refreshed daily, with permanent monthly archives. <a href="playlist-sync/">read more</a></p>
  </div>
</div>
</div>

<div class="home-section">
<h2>getting started</h2>

<div class="card-grid">
  <div class="card">
    <div class="card-meta">start here</div>
    <h3>Installation</h3>
    <p>The beginner's walkthrough, from turning on SSH to watching your first download land. <a href="installation/">open the guide</a></p>
  </div>
  <div class="card">
    <div class="card-meta">learn it</div>
    <h3>Build it yourself</h3>
    <p>Eleven chapters building the same stack by hand, so you understand every layer rather than trusting a wizard. <a href="tutorial/">open the tutorial</a></p>
  </div>
  <div class="card">
    <div class="card-meta">reference</div>
    <h3>Architecture</h3>
    <p>The finished thing taken apart. Containers, the VPN namespace, hardlinks, and what the installer actually does. <a href="architecture/">open the breakdown</a></p>
  </div>
</div>
</div>

<div class="home-section">
<h2>what you need</h2>

<p class="hero-lede">
  A NAS that runs Docker, an SSH login for it, and a Windows PC to run the wizard from.
  Synology is the best-tested target, and it also runs on UGREEN, QNAP, Unraid, TrueNAS,
  and plain Linux. A VPN subscription is optional but recommended if you plan to torrent.
  Everything else the wizard sets up for you.
</p>
</div>
