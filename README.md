# 101 Books Go Reader

The reader discovers all 108 TeX Go booklets in the repository and keeps
each booklet in the ordering used by its source PDF. It is intended for local
use by default and listens at `http://127.0.0.1:8000/`.

## Run locally

From the repository root:

```bash
uv run python -m reader.server
uv run python -m unittest -v
node --test tests/test_app.mjs tests/test_browser_grid.mjs tests/test_browser_collections.mjs
uvx ruff format --check reader tests
uvx ruff check reader tests
```

The reader is a FastAPI application served by uvicorn, with pydantic validating
the two request bodies it accepts and typer providing the command line
(`uv run python -m reader.server --help`). `uv` builds the
environment from `uv.lock`; `uv run` creates it on first use, and
`uv sync --frozen` installs exactly what is locked without resolving anything.

Open `http://127.0.0.1:8000/` after starting the server. Every booklet can also
be opened directly at `http://127.0.0.1:8000/collections/<slug>`, and a single
problem at `http://127.0.0.1:8000/collections/<slug>/<problem-number>`; the root
URL restores the last booklet selected in that browser. The address bar always
names the problem on screen - paging through a booklet rewrites it in place - so
any position can be shared or reloaded. A booklet URL without a number opens the
first unsolved or flagged problem and is rewritten to that one. Progress belongs to a password-protected profile. The reader asks for a name and
password through its own dialog and shows the name in the header; selecting it
reopens the dialog to switch profile or sign out. Use **Change collection** to browse the API-sorted booklet
catalog and switch collections; the buttons above the list filter it by type
(tsumego, tesuji, endgame), several types can be on at once, **All types** clears
them again, and the choice is remembered in the browser. Use **Activity** to review the current profile's
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
complete.

## Profiles and passwords

There is no registration step: logging in with a name that nobody holds creates
that profile. Because a mistyped name would otherwise open an empty profile that
looks exactly like lost progress, creating one takes a deliberate second
confirmation - the first attempt reports `No profile called "..."` and offers to
create it.

Passwords are hashed with `hashlib.scrypt` and a **random 16-byte salt per
profile**, stored beside the hash in `reader-data/credentials/`. The salt is
never derived from the name: a name is public and predictable, so an attacker
could build tables for it before ever seeing the file, and reuse them across
every deployment. Repeated failures back off per name, because guessing a
friend's password is a likelier attack than cracking the file.

A successful login returns a token signed with a secret in
`reader-data/session-secret` (mode 0600). The token names the user, so the API
no longer takes a `user` parameter and one session cannot write to another
profile's progress. Deleting the secret signs everyone out.

A profile that already holds progress but has no password must be claimed
deliberately, or the first stranger to guess the name would inherit it:

```bash
uv run python -m reader.admin --data-dir reader-data list
uv run python -m reader.admin --data-dir reader-data set-password jirka
```

## Admins

A profile can be granted one extra thing: the **Usage** button beside Activity,
which opens the same numbers `reader-stats.sh` prints. Nobody has it by default.

```bash
uv run python -m reader.admin --data-dir reader-data grant-admin jirka
uv run python -m reader.admin --data-dir reader-data revoke-admin jirka
uv run python -m reader.admin --data-dir reader-data list   # marks the admins
```

Grants live in `reader-data/admins.json` and are read on every request, so they
take effect without restarting the service. The name is matched **exactly**:
`Magic` and `magic` are two different profiles anybody may create, so a
case-insensitive grant would hand one person's role to whoever registers the
other spelling. Granting a name no profile holds is allowed - it may be created
later - but the command says so, because it is usually a typo.

The panel reports the last 7 or 30 days: who was active with how much time and
their median, a per-day bar chart naming who was solving, the collections worked
on, a time-of-day histogram and all-time totals. It deliberately shows **no
sessions and no addresses** - sign-ins and refused logins stay in the terminal
report, which is read by somebody who can already read the files. The role is
asked of the server on every load rather than remembered in the browser, so a
revoked grant takes the button away at the next reload and a stored flag can
never leave a button that only answers 403.

## Logs

The server logs to stderr - so `journalctl -u tsumego.service` sees it - and to
a rotating `reader-data/logs/reader.log` (5 MB, five files kept), which is the
copy you can read without sudo and that survives a journal rotation. Both carry
uvicorn's request log and anything the reader itself reports.

An error nobody predicted answers with a plain
`{"error": "The reader failed to handle that request."}` and a 500 - the client
is told nothing more, because the message could contain anything - while the log
gets the traceback together with the method, path and address that produced it,
and the event log gets a `request.failed` entry.

```bash
tail -f reader-data/logs/reader.log
```

Failing to open the log file costs the log, never the request.

Log lines and event-log entries are stamped in Prague time with the offset
spelled out (`2026-09-02T14:19:42+0200`), because everybody using this reader is
in Czechia and a log you have to shift by two hours in your head is a log you
misread. The offset is kept rather than dropped so the hour that happens twice
when summer time ends is still unambiguous.

## Event log

Every action the server sees is appended to `reader-data/metrics/<date>.jsonl`,
one JSON object per line: sign-ins, sign-outs, rejected sign-ins *with the
reason*, unauthenticated requests, problems marked (with how long they took) and
activity views. Files are per day, so pruning is deleting whole files; nothing is
removed automatically. Both `<date>` and the timestamps inside are Prague time,
so an evening of solving is one file rather than two.

Passwords and tokens are never written, and a failure to record is swallowed -
losing a metric is always preferable to failing somebody's request.

The recorded address comes from `CF-Connecting-IP`, because the socket peer is
always Cloudflare and would otherwise make every event look local. That means
the log holds visitors' addresses, so `reader-data/` is now more sensitive than
progress alone and the directory is mode 0700.

Sign-out has its own route, `DELETE /api/session`. Tokens are stateless so there
is nothing to revoke; it exists so that signing out is visible at all, since it
would otherwise be a purely local change with no request to observe.

```bash
uv run python -m reader.admin --data-dir reader-data metrics
uv run python -m reader.admin --data-dir reader-data metrics --days 7
```

The report summarises events by type, sign-ins per profile, rejected sign-ins
grouped by address with their reasons, and median solving time.

## Usage statistics

`stats` answers "who used this, and how much" over a window ending today:

```bash
./tools/reader-stats.sh                    # last 7 days, from anywhere on the box
./tools/reader-stats.sh 1                  # today
uv run python -m reader.admin --data-dir reader-data stats --days 30
```

It prints, for the window: a per-profile table (problems solved, revisit flags,
time recorded, days active, median time per problem, last mark), a per-day bar
chart naming who was solving, the collections worked on, a time-of-day
histogram, sign-ins and refused sign-ins, and an all-time line per profile.

`--days 0` covers everything on disk rather than a fixed window, and `--profile`
narrows the report to one person - their sittings (runs of marks less than half
an hour apart), the problems they marked with the time each took, and their
sign-ins:

```bash
./tools/reader-stats.sh 0 --profile newdeal
```

The name is matched case-insensitively here, since reading a report is not
signing in; an unknown one lists the profiles that do exist and exits 1.

It reads two sources because neither covers the other: `reader-data/users/*.json`
holds every problem ever marked with its duration and reaches back before the
event log existed, while `reader-data/metrics/*.jsonl` is the only record of
sign-ins and refused logins. Both are opened read-only, so it is safe to run
while the service is up.

Days are bucketed in the machine's local zone, so a session that ends at 23:30
counts as that evening rather than as the next UTC morning; pass `--utc` to
bucket in UTC instead.

TLS terminates at Cloudflare, which therefore sees passwords in transit. This is
a tool for a handful of friends, not a secret store - do not reuse a password
that matters.

`GET /api/stats?days=<count>` returns that usage report as JSON for an admin,
and 403 for anybody else; `GET /api/session` answers who the caller is and
whether they hold the role. Both need a token, like every other private route.

`GET /api/activity?limit=<count>` returns newest-first activity with
collection titles, problem numbers and, where recorded, how long the problem was
on screen before it was marked. The limit defaults to 50 and must be from 1
through 100. The endpoint exposes neither moves nor solutions.

`PUT /api/progress` accepts an optional integer `duration_seconds` from 0 to
3600. The reader measures it from when a problem is displayed until it is marked,
counting only time the page is actually visible so a locked phone does not
inflate it. Anything longer than an hour is treated as unmeasured and simply not
recorded; events written before timing existed carry no duration and display
without one.

The reader does not allow stone placement, and each board is cropped to its
initial stones. A side whose nearest stone is within three lines of the board's
edge is shown flush with that edge - a crop that stops just short of one reads
as an edge that is not there, and hides the very lines a capturing race is
counted on. Every other side stops two lines past the last stone and its grid
lines run off the diagram rather than closing it, the way a Go book shows that
the board continues; without that, a cropped side and a real edge look the same
and the position seems to span the whole width of the board. **Show solution** plays the recorded
sequence onto the board as numbered stones, alternating black and white from
move 1; the crop widens to fit them only at that point, and the solution is put
away again as soon as you move to another problem. The 199 problems with no
recorded sequence leave the button disabled.

The diagram follows the convention Go books use rather than the rules of the
game: captures are not replayed, because removing stones would erase the numbers
that make the sequence readable. Where a later move is played on the point of an
earlier one - it captured that stone first - the earlier number stays on the
board and the later one is captioned beneath it as `9 at 5`.

Successful Solved or Revisit actions open the next problem; after saving the final problem, it remains selected with its saved status. Returning to a problem already marked solved shows **Already solved** in place of the Solved button, and it cannot be recorded twice.

Opening a booklet resumes at the first problem you have never seen. **Revisit**
flags a problem without costing you that place: flagged problems only decide
where you land once nothing in the booklet is unseen, at which point re-opening
it starts at the first flag and the booklet becomes a drill list. Flagging is
therefore free during a pass, which it was not when a flag pulled you back to it
every time.

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

Collection data reaches the cache once the worker controls the page. Signing in
takes several requests, by which point it does, so one visit is enough for the
reader to keep working offline afterwards.

The service worker is network-first for everything and keeps a single cache.
Both parts are deliberate. An install-time shell cache plus a runtime cache
meant `caches.match()` kept returning the first copy it found, so a deployed
`app.css` never reached a browser again; and a plain `fetch()` inside the worker
was still answered from the browser HTTP cache, so the worker refetches with
`cache: "reload"`. `tests/test_browser_service_worker.mjs` drives a real browser
to hold both properties - a deploy is visible on the next launch, and the reader
still works with the server unreachable.

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
before reloading, and finally checks the public URL. It also runs
`uv sync --frozen` so that the environment is built at deploy time; the unit
then starts the server with `uv run --frozen --no-sync`, which never resolves or
installs anything and so never needs the network at boot.

The equivalent process command is:

```bash
uv run python -m reader.server \
  --host 127.0.0.1 \
  --port 8123 \
  --base-path /tsumego \
  --data-dir reader-data
```

`--base-path` accepts a path with or without its leading or trailing slash and
normalizes it to one canonical prefix. `--data-dir` selects the directory holding
profiles, credentials, the event log and the log file.

Static files and the HTML shell are read from disk on every request, so editing
`reader/static/` takes effect immediately. Changing `reader/server.py` or
`reader/api.py` needs a restart, and changing the dependencies needs another
`sudo ./deploy/deploy.sh`:

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

To bulk-import already-solved problems, drive `PUT /api/progress` against the
running server rather than editing the JSON, which the process holds in memory.

Profiles are password-protected, so reaching the URL is no longer enough to open
somebody else's progress. Anyone who reaches it can still create a profile of
their own; `deploy/deploy.sh` writes a commented-out Basic authentication block
into the Apache fragment if you would rather gate the whole site.

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
