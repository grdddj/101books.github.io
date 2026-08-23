# Production reader deployment design

## Goal

Make the reader easy to run as one local Python service behind Apache at a subpath such as `https://jirkuvserver.cz/tsumego/`, while storing durable per-user progress and activity history in local JSON files.

## Deployment topology

Apache terminates public HTTP(S) and reverse-proxies `/tsumego/` to one reader process bound only to `127.0.0.1:8123`. The reader accepts a normalized `--base-path /tsumego` argument and applies it to static assets, APIs, collection URLs, History API paths, and health checks. It continues to run at the root path when no base path is configured.

The repository provides example Apache and systemd units plus documented installation, start, health-check, backup, and upgrade commands. Runtime data lives in a configurable external directory such as `/var/lib/tsumego`, not in the checkout. A `/healthz` JSON endpoint verifies the running process.

## Per-user progress and events

Each browser-entered display name maps to one safely derived filename under `<data-dir>/users/`; the display name is stored in that file. A file contains the current problem status map and an append-only `events` list. Every `solved` or `revisit` action appends an event with the canonical problem ID, status, and UTC timestamp, including repeated actions. Current statuses keep their own updated timestamps for existing reader behavior.

The server retains lightweight per-user locks internally so simultaneous requests for the same display name cannot lose events. Different users never block each other, and no cross-process coordination is claimed. Browser names remain intentionally unauthenticated as requested; API validation and safe filename derivation prevent path traversal but cannot prevent impersonation.

## Migration and API

On first startup with a legacy shared `progress.json`, migration validates all data before writing. It copies the original file to a timestamped backup, creates one user file per legacy user, and turns each saved current status into one initial event at its existing `updated_at` timestamp. A durable migration marker and deterministic target paths make restart after interruption safe and prevent duplicate events. Existing per-user target files cause a clear error rather than being overwritten.

Progress API responses remain current-status compatible. A new user activity endpoint returns that user’s latest events with collection/problem context, bounded by a validated limit. All base-path-prefixed routes behave exactly as their root-path equivalents.

## Activity UI

The reader includes a non-interactive Activity control/panel for the current user. It displays recent solved/revisit entries with local timestamp, collection title, and problem number. It contains no moves, solutions, or play controls, and uses the existing dialog accessibility patterns.

## Verification and documentation

Tests cover base-path server and browser routing, health checks, safe per-user-file isolation, appended repeated events, restart-safe migration, activity API validation, and activity rendering. README documents the deployment configuration, Apache proxy, systemd service, health check, and backup/migration behavior. Deployment examples contain no credentials.
