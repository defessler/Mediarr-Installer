# Check the VPN for leaks on a schedule

## What

Add a periodic leak check to `nas/scripts/qbit-guardian.sh`. It compares the tunnel's exit IP with the host's IP and pauses qBittorrent (`docker pause qbittorrent`) on a match or an unhealthy tunnel. Make the install-time check retry harder before it calls a result inconclusive.

## Why

The only true leak detection runs once, at install time, in `post-deploy-validate.sh`. The five-minute guardian checks liveness and the network namespace but never compares IPs. A qBittorrent welded to a gluetun whose tunnel failed open is reported healthy. The install-time check is also skipped with a warning when the host IP lookup blips, so a flaky-network install can finish green unverified. The Done screen can re-check a leak, but the guardian still doesn't.

## Done when

The guardian compares the exit IP with the host IP on each pass and fail-closes qBittorrent on a match. It has been validated against a real tunnel, so a false positive can't pause a healthy client.

## Notes

Effort M. Finding H5 in `docs/remediation-findings.md`, with evidence at `post-deploy-validate.sh:469-488` and `qbit-guardian.sh:149-205`. A false positive would pause a healthy torrent client, so this wants a real tunnel to test against first.
