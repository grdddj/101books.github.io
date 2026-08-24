# 101 Books Go Reader

The reader discovers all 108 TeX Go booklets in the repository and keeps
each booklet in the ordering used by its source PDF. It is intended for local
use by default and listens at `http://127.0.0.1:8000/`.

## Run locally

From the repository root:

```bash
python3 -m reader.server
python3 -m unittest -v
node --test tests/test_app.mjs tests/test_browser_grid.mjs tests/test_browser_collections.mjs
uvx ruff format --check reader tests
uvx ruff check reader tests
```

The reader depends only on the standard library, so no virtual environment or
dependency install is needed.

Open `http://127.0.0.1:8000/` after starting the server. Every booklet can also
be opened directly at `http://127.0.0.1:8000/collections/<slug>`; the root URL
restores the last booklet selected in that browser. The reader asks for a display
name once per browser. Use **Change collection** to browse the API-sorted booklet
catalog and switch collections. Use **Activity** to review the current profile's
recent solved and revisit actions with local timestamps and booklet/problem labels;
the view is read-only and never exposes moves or solutions. Progress is stored
in one JSON document per display name below `reader-data/users/`; this directory
is intentionally ignored by Git. Filenames are deterministic SHA-256 digests,
while each document retains the display name, current problem records, and the
append-only solved/revisit event history. Several unauthenticated browser-local
profiles can use the same process. Updates are synchronized per user within that
process, but the store does not provide cross-process coordination.

Progress records are scoped to the selected booklet and to repeated positions
within it. Their IDs use the form `<booklet-slug>:<section>/<problem>@<occurrence>`,
so solving a position in one booklet never marks another booklet's position
complete. During shared-file migration, valid legacy 200 Basic Go Problems IDs
are converted to their corresponding namespaced IDs. Each migrated current
status also becomes one initial activity event at its existing timestamp.

`GET /api/activity?user=<name>&limit=<count>` returns newest-first activity with
collection titles, problem numbers and, where recorded, how long the problem was
on screen before it was marked. The limit defaults to 50 and must be from 1
through 100. The endpoint exposes neither moves nor solutions.

`PUT /api/progress` accepts an optional integer `duration_seconds` from 0 to
3600. The reader measures it from when a problem is displayed until it is marked,
counting only time the page is actually visible so a locked phone does not
inflate it. Anything longer than an hour is treated as unmeasured and simply not
recorded; events written before timing existed carry no duration and display
without one.

The reader intentionally does not allow stone placement or reveal solutions. Each board is cropped to its initial stones plus a one-line margin, and successful Solved or Revisit actions open the next problem; after saving the final problem, it remains selected with its saved status.

## Install on a phone

The reader ships as a progressive web app, so it can be added to a phone's home
screen and opened without browser chrome. On Android use Chrome's **Install app**
/ **Add to Home screen**; on iOS use Safari's **Share -> Add to Home Screen**.
It requires HTTPS, which the production deployment already provides.

Every URL in [the manifest](reader/static/manifest.webmanifest) is relative, so
the same document works at the root during development and below `/tsumego/` in
production without substitution. [The service worker](reader/static/sw.js)
derives its own base from its script location; because it is served from the
reader root, its default scope is exactly the reader and nothing else on the
domain.

Offline the reader serves the cached shell and the last booklet you opened, so
you can keep paging through problems. Marking a problem solved needs the server;
it reports `You appear to be offline. Progress was not saved.` when the device
has no connection and `Could not reach the server. Progress was not saved.` when
the device is online but the service is down. There is no write queue, so the
action is refused rather than dropped silently. Only a rejected request is
translated this way; errors the server itself returns keep their own message.

Collection data reaches the cache once the worker controls the page, which is
from the second visit onwards. On a first visit followed immediately by going
offline the shell still renders and reports the connection error.

Static assets are served with `Cache-Control: no-cache` because they carry no
content hash. A shared cache in front of the reader would otherwise pin a stale
`app.js` for hours, and the service worker would then cache that stale copy too.
This matters here: the production domain sits behind Cloudflare, which caches
`.js` and `.css` for four hours by default when the origin sends no header. The
service worker still serves assets from Cache Storage first and refreshes them
in the background, so revalidating on every request costs nothing at launch.

Regenerate the icons after changing the artwork:

```bash
./tools/generate-icons.sh   # needs ImageMagick
```

## Deploy below `/tsumego/`

The production process listens only on loopback while Apache publishes it at
`https://jirkuvserver.cz/tsumego/`. The base path is part of the application
configuration: it prefixes reader pages, static assets, API requests, direct
collection links, and browser Back/Forward history. Root behavior remains the
default when `--base-path` is omitted.

[`deploy/deploy.sh`](deploy/deploy.sh) performs the whole deployment and is safe
to re-run:

```bash
sudo ./deploy/deploy.sh              # install or restart
sudo ./deploy/deploy.sh --uninstall  # remove the service and Apache wiring
```

It installs a `tsumego.service` unit that runs as the invoking user directly out
of this checkout, waits for the local health endpoint, enables Apache's proxy
modules, writes `/etc/apache2/conf-available/tsumego.conf`, includes it from the
`*:443` virtual host (backing that file up first), validates the configuration
before reloading, and finally checks the public URL. The reader depends only on
the standard library, so the unit runs `python3` directly and no virtual
environment is created.

The equivalent process command is:

```bash
python3 -m reader.server \
  --host 127.0.0.1 \
  --port 8123 \
  --base-path /tsumego \
  --data-dir reader-data
```

`--base-path` accepts a path with or without its leading or trailing slash and
normalizes it to one canonical prefix. `--data-dir` selects the progress
directory; it cannot be combined with the compatibility option
`--progress-file`.

Static files and the HTML shell are read from disk on every request, so editing
`reader/static/` takes effect immediately. Changing `reader/server.py` needs a
restart:

```bash
sudo systemctl restart tsumego.service
curl --fail http://127.0.0.1:8123/tsumego/healthz
```

Because the service runs from the working tree, that tree is production:
switching branches or leaving a broken edit in place will break the live site on
the next restart.

### Progress data and backups

Progress is stored in one JSON document per display name below `reader-data/`,
which is ignored by Git. Back it up before every upgrade, stopping the service so
the set of per-user files is a consistent snapshot:

```bash
backup=~/tsumego-backups/data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
mkdir -p ~/tsumego-backups
sudo systemctl stop tsumego.service
tar --create --gzip --file "$backup" --directory reader-data .
sudo systemctl start tsumego.service
tar --list --gzip --file "$backup" >/dev/null
```

On the first start with a legacy shared `progress.json` in the data directory,
the server validates the complete document before writing, creates a timestamped
byte-for-byte backup, and migrates each profile into `users/`.
`progress-migration.json` records the restart-safe migration state. An interrupted
migration resumes without duplicating events; an existing target, missing completed
target, corrupt source, or corrupt backup stops startup instead of overwriting or
silently dropping progress.

To bulk-import already-solved problems, drive `PUT /api/progress` against the
running server rather than editing the JSON, which the process holds in memory.

The reader does not authenticate browser-entered display names. Publish it only
to trusted users or add access control at Apache; anyone who can reach the site
can select another person's display name. `deploy/deploy.sh` writes a
commented-out Basic authentication block into the Apache fragment for that.

### Restarting without a password

Changing `reader/server.py` requires a restart, which normally prompts for a
sudo password and so cannot run unattended. To grant just that:

```bash
sudo ./deploy/enable-passwordless-restart.sh              # install
sudo ./deploy/enable-passwordless-restart.sh --remove     # undo
```

It writes `/etc/sudoers.d/tsumego` allowing `systemctl start|stop|restart` and
`journalctl` for `tsumego.service` only, after validating the file with
`visudo`. Sudo is not widened for anything else. The systemctl rules take no
extra arguments, because a trailing wildcard would also match a second unit
name and grant control over every service on the machine. `systemctl status`
is not included since it does not need root.

The trade-off is real though: anything running as that user can now stop or
restart the reader without the password gate.
