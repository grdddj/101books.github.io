# 101 Books Go Reader

The reader discovers all 108 TeX Go booklets in the repository and keeps
each booklet in the ordering used by its source PDF. It is intended for local
use by default and listens at `http://127.0.0.1:8000/`.

## Run locally

From the repository root:

```bash
uv run reader/server.py
uv run python -m unittest -v
node --test tests/test_app.mjs tests/test_browser_grid.mjs tests/test_browser_collections.mjs
uvx ruff format --check reader tests
uvx ruff check reader tests
```

Open `http://127.0.0.1:8000/` after starting the server. Every booklet can also
be opened directly at `http://127.0.0.1:8000/collections/<slug>`; the root URL
restores the last booklet selected in that browser. The reader asks for a display
name once per browser. Use **Change collection** to browse the API-sorted booklet
catalog and switch collections. Progress is stored in one JSON document per
display name below `reader-data/users/`; this directory is intentionally ignored
by Git. Filenames are deterministic SHA-256 digests, while each document retains
the display name, current problem records, and the append-only solved/revisit
event history. Several unauthenticated browser-local profiles can use the same
process. Updates are synchronized per user within that process, but the store
does not provide cross-process coordination.

Progress records are scoped to the selected booklet and to repeated positions
within it. Their IDs use the form `<booklet-slug>:<section>/<problem>@<occurrence>`,
so solving a position in one booklet never marks another booklet's position
complete. During shared-file migration, valid legacy 200 Basic Go Problems IDs
are converted to their corresponding namespaced IDs. Each migrated current
status also becomes one initial activity event at its existing timestamp.

`GET /api/activity?user=<name>&limit=<count>` returns newest-first activity with
collection titles and problem numbers. The limit defaults to 50 and must be from
1 through 100. The endpoint exposes neither moves nor solutions.

The reader intentionally does not allow stone placement or reveal solutions. Each board is cropped to its initial stones plus a one-line margin, and successful Solved or Revisit actions open the next problem; after saving the final problem, it remains selected with its saved status.

## Deploy below `/tsumego/`

The production process can listen only on loopback while Apache publishes it at
`https://jirkuvserver.cz/tsumego/`. The base path is part of the application
configuration: it prefixes reader pages, static assets, API requests, direct
collection links, and browser Back/Forward history. Root behavior remains the
default when `--base-path` is omitted.

1. Install `uv`, clone the repository to `/opt/101books.github.io`, and create a
   dedicated service account and writable data directory:

   ```bash
   sudo useradd --system --home /var/lib/tsumego --shell /usr/sbin/nologin tsumego
   sudo install -d -o tsumego -g tsumego -m 0750 /var/lib/tsumego
   ```

2. Copy [the systemd example](deploy/systemd/tsumego.service.example) to
   `/etc/systemd/system/tsumego.service`. Adjust `WorkingDirectory` and the
   service `PATH` if the checkout or `uv` installation differs. The unit keeps
   uv's environment and cache below `/var/lib/tsumego`, so the service does not
   need to write to the protected checkout. Then start it:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now tsumego.service
   curl --fail http://127.0.0.1:8123/tsumego/healthz
   ```

3. Enable Apache's proxy modules and add
   [the Apache example](deploy/apache/tsumego.conf.example) inside the HTTPS
   virtual host. Reload Apache after validating its configuration:

   ```bash
   sudo a2enmod proxy proxy_http
   sudo apachectl configtest
   sudo systemctl reload apache2
   curl --fail https://jirkuvserver.cz/tsumego/healthz
   ```

The equivalent process command is:

```bash
uv run --frozen python -m reader.server \
  --host 127.0.0.1 \
  --port 8123 \
  --base-path /tsumego \
  --data-dir /var/lib/tsumego
```

`--base-path` accepts a path with or without its leading or trailing slash and
normalizes it to one canonical prefix. `--data-dir` stores the progress data
outside the checkout; it cannot be combined with the compatibility option
`--progress-file`.

On the first start where the data directory contains the legacy shared
`progress.json`, the server validates the complete document before writing,
creates a timestamped byte-for-byte backup, and migrates each profile into
`users/`. `progress-migration.json` records the restart-safe migration state. An
interrupted migration resumes without duplicating events; an existing target,
missing completed target, corrupt source, or corrupt backup stops startup instead
of overwriting or silently dropping progress.

Back up all JSON application data in `/var/lib/tsumego`, including `users/`, the
legacy backup, and the migration marker, and restore it with ownership retained
by the `tsumego` service account. Exclude the reproducible `.venv` and `.cache`
directories from backups.

Production uses `uv run --frozen` so a stale or missing lockfile fails startup
instead of changing the deployed dependency set.

The reader does not authenticate browser-entered display names. Publish it only
to trusted users or add access control at Apache; anyone who can reach the site
can select another person's display name.
