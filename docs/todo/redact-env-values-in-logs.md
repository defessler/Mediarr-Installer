# Redact env secrets from the install log

## What

Pass the high-entropy `.env` values into the `secrets` array of `execStream`. Add a generic `KEY=secret` redaction in `appendInstallLog`.

## Why

Stream redaction still covers only the SSH and sudo passwords, not `.env` values. It is safe today, because `.env` goes over SFTP and is never echoed. It is fragile, though. Any future code that echoes a key would land it in the persistent install log that users attach to bug reports.

## Done when

An `.env` secret that appears in streamed output is scrubbed from the install log.

## Notes

Finding L6 in `docs/remediation-findings.md`, sized M, at `ssh-service.ts:627-628`. It was assessed as low value and purely preventive, since the real leak vector is already redacted.
