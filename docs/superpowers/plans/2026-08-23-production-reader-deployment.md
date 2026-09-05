# Production reader deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the reader safely behind Apache at a configurable subpath with per-user JSON progress histories and an activity view.

**Architecture:** Server route helpers use one normalized base path for static, API, health, and collection routes; frontend receives it from the served HTML. A per-user store replaces the shared store and maintains current records plus append-only events. Apache proxies one localhost process managed by systemd.

**Tech Stack:** Python 3.10 standard library, vanilla JavaScript/CSS, Apache mod_proxy, systemd, Node test runner, Chromium, Ruff.

## Global Constraints

- Support root and `--base-path /tsumego`; subpath paths, assets, APIs, health, and browser history must agree.
- Bind the deployment example only to `127.0.0.1:8123`; runtime data is external to the checkout.
- Browser-entered display names remain unauthenticated, but filenames must be safe and deterministic.
- Each solved/revisit action appends a UTC event; current statuses remain API-compatible.
- One-time legacy migration preflights data, creates a backup/marker, is restart-safe, and never overwrites target user files.
- Activity is read-only, accessible, and never exposes moves or solutions.

---

### Task 1: Base-path routes, health check, and deployment examples

**Files:** Modify `reader/server.py`, `reader/static/index.html`, `reader/static/app.js`, `tests/test_server.py`, `tests/test_app.mjs`, `tests/test_browser_collections.mjs`, `README.md`; create `deploy/apache/tsumego.conf.example` and `deploy/systemd/tsumego.service.example`.

- [ ] Write failing server/browser tests for `/tsumego/`, `/tsumego/collections/<slug>`, `/tsumego/api/collections`, `/tsumego/healthz`, and base-prefixed frontend fetch/history paths.
- [ ] Run focused tests and observe base-path failures.
- [ ] Add normalized base-path configuration, inject it into the reader shell, preserve root behavior, and implement health JSON without weakening API/static routing.
- [ ] Add Apache ProxyPass and systemd examples using `--host 127.0.0.1 --port 8123 --base-path /tsumego --data-dir /var/lib/tsumego`.
- [ ] Run focused tests and commit `feat: support subpath reader deployment` with why in the body.

### Task 2: Per-user stores, events, and legacy migration

**Files:** Modify `reader/server.py`, `tests/test_server.py`, `README.md`.

- [ ] Write failing tests for safe isolated user files, repeated action events, activity limits, invalid activity queries, legacy backup/migration, restart recovery, and existing target collision.
- [ ] Run focused Python tests and observe failures against shared progress storage.
- [ ] Replace shared storage with validated per-user documents containing user name, current problems, and events; preserve per-user locking and atomic writes.
- [ ] Implement preflighted, restart-safe legacy migration with marker and backup; add `/api/activity` response enriched from collections.
- [ ] Run Python tests and commit `feat: record per-user Go activity history` with why in the body.

### Task 3: Read-only activity view and final deployment documentation

**Files:** Modify `reader/static/index.html`, `reader/static/app.js`, `reader/static/app.css`, `tests/test_app.mjs`, `tests/test_browser_collections.mjs`, `README.md`.

- [ ] Write failing unit/browser tests for opening, loading, rendering, closing, and keyboard use of an activity dialog containing recent timestamped solved/revisit entries.
- [ ] Run focused tests and observe missing activity behavior.
- [ ] Implement accessible read-only activity UI using base-prefixed activity endpoint and existing modal patterns; format local timestamps and collection/problem labels.
- [ ] Complete README instructions for Apache enablement, systemd, first migration, backup of `/var/lib/tsumego`, health check, subpath URLs, and unauthenticated-name caveat.
- [ ] Run `uv run python -m unittest -q`, all Node/Chromium tests, Ruff format/check, and `git diff --check`; commit `feat: show reader activity history` with why in the body.

### Task 4: Final verification and review

**Files:** No product-file changes expected.

- [ ] Run the complete validation suite on the final tree and smoke-test a local server with `--base-path /tsumego` on an unused localhost port.
- [ ] Confirm deployment examples have no secrets and README matches actual CLI/API behavior.
- [ ] Request whole-branch review; fix every Critical/Important finding and repeat verification.
