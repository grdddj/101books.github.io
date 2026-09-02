# 101books Go reader

This repository holds 108 TeX Go booklets (`books/*.tex`) built from SGF problems
(`problems/<slug>/<section>/<problem>.sgf`) into PDFs, plus `reader/` - a web
reader that serves those same problems as a static, click-free board.

`README.md` documents the reader for a human. This file records what an agent
needs to know before changing or deploying it.

## The working tree IS production

The live service runs `uv run python -m reader.server` **directly out of this
checkout** as user `jirka`. There is no build step, no second copy, no
container - but there is now a `.venv`, built by `uv sync --frozen` from
`uv.lock`.

Consequences that matter more than they look:

- Editing `reader/static/*` changes the live site **immediately** - the server
  reads static files and the HTML shell from disk on every request.
- Editing `reader/server.py` or `reader/api.py` needs a restart to take effect.
- Changing `pyproject.toml` needs `sudo ./deploy/deploy.sh`, not a restart: the
  unit runs `uv run --no-sync` so that starting the service never touches the
  network, which also means it never installs anything.
- `git checkout`, `git stash`, or leaving a broken edit in the tree changes what
  visitors get. Never leave the tree in a non-working state.
- `reader-data/` inside the tree holds all solving progress and is gitignored.
  A `git clean -fdx` would delete it.

## Deployment

| What | Where |
|---|---|
| Public URL | `https://jirkuvserver.cz/tsumego/` |
| Local origin | `http://127.0.0.1:8123/tsumego/` |
| Unit | `tsumego.service` (systemd, user `jirka`) |
| Code | this checkout |
| Progress data | `reader-data/users/*.json` |
| Apache | `/etc/apache2/conf-available/tsumego.conf`, included from the `*:443` vhost of `jirkuvserver.cz-le-ssl.conf` |

```bash
sudo ./deploy/deploy.sh              # full install or re-deploy, idempotent (runs uv sync)
sudo ./deploy/deploy.sh --uninstall  # remove service + Apache wiring

sudo systemctl restart tsumego.service   # after any reader/server.py change
sudo journalctl -u tsumego.service -n 50 # logs
curl --fail http://127.0.0.1:8123/tsumego/healthz
```

`restart`, `start`, `stop` and `journalctl` for this unit run **without a
password** - installed by `deploy/enable-passwordless-restart.sh`, which writes
`/etc/sudoers.d/tsumego`. Nothing else is widened: `systemctl restart apache2`,
`systemctl daemon-reload` and everything else still prompt.

**Sudoers matches the command line literally.** The systemctl rules carry no
wildcard, so they only match with *no extra flags*:

```bash
sudo systemctl restart tsumego.service      # works
sudo systemctl restart tsumego              # works (both names are listed)
sudo systemctl restart tsumego.service --no-block   # REFUSED - extra argument
sudo journalctl -u tsumego.service -n 50    # works - this rule does take flags
```

The wildcard is omitted on purpose: `systemctl restart tsumego.service *` would
also match `systemctl restart tsumego.service apache2`, turning a single-unit
grant into control over every unit on the machine. Do not add one.

`systemctl status`, `is-active` and `show` need no sudo at all - run them
directly, with whatever flags you like.

**Startup takes about 10 seconds** - the server scans all 108 booklets before
listening. Never conclude the service is broken from a single failed request
right after a restart; poll `/healthz` in a loop instead. A `curl` returning
`000` means "not up yet", not "broken".

## Cloudflare sits in front

The public domain is proxied by Cloudflare. This has bitten us twice:

- Assets carry no content hash, so the server sends `Cache-Control: no-cache`
  and Cloudflare is set to **Respect Existing Headers**. Expect
  `cf-cache-status: REVALIDATED` on `/tsumego/app.js`. If it ever reads `HIT`
  with an `age`, the edge is serving stale code.
- After changing a static asset, verify what the **public** URL serves, not just
  the origin. They can disagree for hours.

```bash
curl -sI https://jirkuvserver.cz/tsumego/app.js | grep -iE 'cache-control|cf-cache-status'
```

Purging requires the Cloudflare dashboard (Caching -> Configuration -> Purge
Cache); there is no API token on this machine.

## Reader architecture

- **FastAPI on uvicorn, run through uv.** `reader/api.py` is the whole HTTP
  surface; `reader/server.py` owns the catalog, the SGF parsing, the progress
  store and the typer CLI, and knows nothing about HTTP beyond `ReaderServer`, a
  thin uvicorn wrapper that keeps `serve_forever` / `shutdown` / `server_address`
  for the tests.
- **The CLI is one typer command, deliberately.** With a single `@cli.command()`
  and no callback, typer collapses it, so `python -m reader.server --port 8123`
  keeps working with no subcommand to name - which is what the systemd unit and
  every documented invocation pass. Adding a second command would silently break
  all of them; `CommandLineTests` guards it. `reader/auth.py`, `reader/metrics.py` and `reader/admin.py` are
  still standard library only. Dependencies are pinned in `uv.lock`; keep the
  list short, because every one of them is something that can break a deploy.
- **Requests are validated by pydantic, responses are written by hand.**
  `SessionRequest` and `ProgressRequest` are `strict=True`, so `"1"` is not read
  as `1` and `"yes"` is not read as `true`; strictness is also what rejects a
  bool where an int is wanted, which the hand-written checks had to special-case
  because bool subclasses int. Unknown keys stay ignored so an older client
  keeps working. Bodies are read manually and then `model_validate`d rather than
  bound as a FastAPI parameter, because the 16 KB cap has to be enforced from
  `Content-Length` *before* the body is read, and because FastAPI's automatic
  422 is not the `{"error": ...}` shape the client handles.
  `validation_message()` builds the reply from the field and the reason only -
  pydantic's own rendering includes the offending value, and one of those bodies
  carries a password.
  There is deliberately no `response_model` and no `/docs`: `response_model`
  filters fields silently, and the client was built against exact bodies with
  `no-store` on anything user-specific and `no-cache` on the unversioned assets.
  `@app.get` answers GET only, so read routes are registered through the local
  `readable()` helper to keep HEAD working.
- **Base path.** `--base-path /tsumego` prefixes pages, assets, API routes and
  history entries. `reader/static/index.html` is templated: the server
  substitutes `__READER_BASE_PATH__` when serving the shell. Client code reads
  `window.READER_BASE_PATH` and goes through `readerPath()`. Any new URL must
  use it. Root behaviour (no prefix) must keep working - `BasePathHttpApiTests`
  re-runs the whole HTTP suite under `/tsumego` to enforce this.
- **Problem IDs** are `<booklet-slug>:<section>/<problem>@<occurrence>`, so the
  same position in two booklets tracks separately.
- **`firstPendingIndex` never goes backwards.** Pending means "no record at
  all"; a `revisit` flag is deliberately *not* pending. It used to be, so
  flagging a problem cost you your place in the booklet and the feature went
  unused - 145 activity events with zero revisits. Flags now only decide where
  you land once nothing is unseen, turning a finished booklet into a drill list.
  Do not fold them back into the first branch.
- **The URL names the displayed problem**: `/collections/<slug>/<number>`, with
  `<number>` the one-based problem number. Every move between problems rewrites
  it with `replaceState`, so the address bar is always shareable and Back still
  steps between booklets rather than between problems. A booklet URL with no
  number opens the first pending problem and is rewritten to it. Because the
  document no longer sits at a fixed depth, **a relative URL in the page resolves
  differently per problem** - build every URL through `readerPath()`.
- **PWA.** Every URL in `reader/static/manifest.webmanifest` is *relative* so
  one document works at both `/` and `/tsumego/`; do not hardcode a base path
  into it. `reader/static/sw.js` derives its scope from its own location. Icons
  are regenerated by `./tools/generate-icons.sh` (needs ImageMagick).
- **The collection chooser filters by type, and no selection means every type.**
  The booklet's `%<category>` line (tsumego, tesuji, endgame) already reaches the
  client through `/api/collections`, so the filter buttons are built from the
  catalog rather than from a hardcoded list - a fourth category appears on its
  own. An empty selection shows the whole shelf, which is what **All types**
  reports and restores; treating it as "show nothing" would open the panel
  empty. The choice is stored in `static-go-reader-categories` and a stored type
  the catalog no longer offers is dropped on render, because it would otherwise
  hide collections with no pressed button on screen to explain why.
- **The reader never places stones, and reveals a solution only on request.**
  Boards are cropped to the initial position plus one line of margin, and stay
  that way until **Show solution** is pressed - widening the crop for the moves
  up front would tell you which way they run. The solution is put away again
  whenever the problem changes; nothing about it survives navigation.
- **A crop that comes within `BOARD_EDGE_REACH` (2) lines of a side is pulled
  out to it.** Nothing marks the outermost line of a crop as the board's edge,
  so a crop stopping one line short reads as an edge that isn't there: in
  capturing races 33 the wall on column `d` looked like it stood on the first
  line, with columns `a` and `b` hidden, which changes every liberty count. Each
  side is pulled out on its own, so an edge position shows its edge and a corner
  one shows its corner. The gap distribution justifies the threshold - stones
  sit either within two lines of a side or five-plus away - so a centre problem
  never pays for it. Widening from the *initial* stones only leaks nothing about
  the solution; do not key it off the moves.
- **Solution diagrams follow the book convention, not the rules of Go.** The
  numbered moves are laid over the opening position and captures are *not*
  replayed: the point is to show the sequence, and removing stones would erase
  the numbers that make it readable. The first move played at a point is the one
  drawn; a later move on the same point captured it first and is captioned
  "N at M" under the board (12.8% of problems). A move landing on an opening
  stone takes that point over, since the stone was captured on the way there.
- **The board sizes itself from a height budget.** Stones are laid out by a CSS
  grid that fills the board box; the lines are an SVG stretched over the same
  box. They only agree while the box keeps the crop's aspect ratio, so `.goban`
  derives its width from `--board-available-height` times columns/rows. A
  `max-height` that clamps an independently chosen width silently squashes the
  cells and slides every stone off its line - that was a real bug on square
  crops. `--board-available-height` is a hand-tuned guess at the chrome around
  the board; re-measure it if the header or controls change height.
- **Profiles are password-protected.** `reader/auth.py` holds scrypt hashing
  (random per-profile salt, never derived from the name) and HMAC-signed session
  tokens. Identity comes from the token, so API routes take no `user`
  parameter - never reintroduce one. A profile holding progress but no password
  is refused at login until claimed with
  `uv run python -m reader.admin set-password <name>`.
- **The service worker rebuilds requests** to force revalidation, so it must
  copy their headers across; forgetting that stripped `Authorization` and made
  every API call 401. `tests/test_browser_service_worker.mjs` guards it.

## Logs

`reader/logs.py` points the root logger at stderr *and* at a rotating
`reader-data/logs/reader.log` (5 MB x 5). uvicorn runs with `log_config=None`
precisely so that its access and error loggers keep propagating to the root and
land in that file too; restoring uvicorn's own logging config would silently
empty it.

Unhandled exceptions go through `UnhandledErrorMiddleware`, which logs the
traceback with the request that caused it, records a `request.failed` event, and
answers `{"error": "The reader failed to handle that request."}` with a 500. The
client is deliberately told nothing else: the message could contain anything.
A plain `@app.exception_handler(Exception)` was not enough - Starlette re-raises
after calling it, so the traceback is logged a second time *after* the response
has gone out, which makes the log racy to read.

```bash
tail -f reader-data/logs/reader.log
```

Opening the file is best effort: a data directory that cannot be written costs
the log, never the request.

## Event log

`reader/metrics.py` appends one JSON object per line to
`reader-data/metrics/<date>.jsonl` for everything the server observes. Recording
is best effort and must stay that way: it is wrapped so an `OSError` can never
turn into a failed request.

- **Timestamps are Prague time, not UTC**, here and in `reader/logs.py`, via
  `reader/clock.py`; the offset is always written out so the repeated autumn
  hour stays unambiguous. The daily file name follows the Prague day. Files
  written before this change carry `Z` and everything that reads them handles
  both - `datetime.fromisoformat` parses either, so never compare these strings
  lexicographically to order events across the change.
  `reader-data/users/*.json` deliberately stayed UTC: that format is validated
  on the way in by `ProgressStore._is_utc_timestamp` and never shown raw, so
  moving it would be a migration of every stored event for nothing visible.
- **Never log passwords or tokens.** A test asserts neither appears in the file.
- Addresses come from `CF-Connecting-IP`; the socket peer is always Cloudflare.
- Client-only actions (navigation, dialog opens, problem views) are **not**
  recorded - there is no client events endpoint by design. `DELETE /api/session`
  is the one exception, and exists solely so sign-out is observable.
- Read it with `uv run python -m reader.admin metrics [--days N]`.

`reader/stats.py` (`reader.admin stats`, or `./tools/reader-stats.sh [days]`)
answers the usage question on top of both stores: the event log alone cannot,
because progress predating it lives only in `users/*.json`, and that file alone
knows nothing about sign-ins. It is read-only and buckets days in the local zone
(`--utc` to override), so an evening session is not split across two days.

## Progress data

Never hand-edit `reader-data/users/*.json`: the running process holds the
document in memory and will overwrite your change on its next save. Import
through the API instead:

```bash
curl -X PUT http://127.0.0.1:8123/tsumego/api/progress \
  -H 'Content-Type: application/json' \
  -d '{"user":"jirka","problem_id":"200-basic-go-problems:24176/174139@1","status":"solved"}'
```

`PUT /api/progress` sets one problem at a time and appends an activity event
stamped `now` - there is no way to backdate an import. Before any bulk change,
copy the user's JSON file somewhere outside the tree.

## Checks before committing

```bash
uv run python -m unittest                              # server + storage
node --test tests/test_app.mjs tests/test_browser_grid.mjs tests/test_browser_collections.mjs
node --test tests/test_browser_service_worker.mjs      # slow, needs playwright
uvx ruff format --check reader tests
uvx ruff check reader tests
```

`uv run`, not `python3`: the server needs the `.venv` that `uv sync` builds. The
service-worker test spawns `.venv/bin/python` directly for the same reason.

The browser tests skip themselves when they cannot find Chromium, and a skipped
test is how a board-rendering regression reached production. `tests/chromium.mjs`
now falls back to Playwright's own download, so they should actually run - check
the output says `pass`, not `SKIP`.

The `tests/test_app.mjs` harness runs `app.js` inside a `vm` sandbox, which is a
**different realm**: `instanceof` and `assert.deepEqual` fail across it. Compare
scalars, and duck-type with `error.name === "TypeError"` rather than
`instanceof TypeError`.

## Verifying behaviour in a browser

Playwright is available. Two traps found the hard way:

- The reader calls `prompt()` for a display name on first load, which blocks
  `domcontentloaded`. Register a dialog handler before navigating.
- **`context.setOffline(true)` does not block a service worker's own `fetch()`.**
  An offline test using it will pass while still hitting the network. To test
  offline for real, start a second reader on a spare port and kill it.
