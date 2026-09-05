# Final Review Fixes Report

## Scope and findings addressed

1. Root-only SGF setup parsing: `parse_initial_stones` now enters the first
   game tree's root node and stops at its node boundary. Escaped property-value
   characters are consumed as values, while only root `AB` and `AW` properties
   populate the board. The regression `(;AB[aa];B[bb]AB[cc])` returns only
   `black == ["aa"]`.
2. Complete progress schema validation: `ProgressStore._read` now verifies the
   full persisted structure before returning it: exact top-level and nested
   mapping shapes, normalized user keys, known problem IDs, exact record
   fields, explicit `solved`/`revisit` statuses only, and parseable UTC `Z`
   timestamps. `StorageCorruptionError` consistently classifies invalid JSON,
   invalid UTF-8, unreadable storage, and malformed schema as server failures.
3. Client identity recovery: browser names are trimmed and constrained to the
   same non-empty, 80-character maximum as the server. Invalid saved values
   are removed; a valid replacement is normalized before storage; invalid or
   cancelled prompts leave no stored value and surface a recoverable status
   message. A dependency-free Node VM/DOM harness covers both recovery paths.
4. Bounded request bodies: `MAX_PROGRESS_REQUEST_BODY_BYTES` is 16 KiB.
   `PUT /api/progress` requires one non-negative decimal `Content-Length`,
   returns structured 400 for missing/invalid/negative values and structured
   413 before reading oversized bodies. Raw-socket HTTP regressions cover the
   negative and oversized cases; the normal JSON PUT round trip remains green.
5. Minor review items: access logging now omits query strings, preventing
   progress display names from appearing in request logs. README wording now
   distinguishes multiple unauthenticated browser-local profiles from a shared
   or network service. `Cache-Control: no-store` was deliberately not added to
   keep this correction wave focused.

## TDD evidence

### RED

- `uv run python -m unittest tests.test_server -v` initially failed at import
  because `StorageCorruptionError` did not yet exist.
- `node --test tests/test_app.mjs` initially failed after the harness setup was
  completed: an 81-character whitespace saved name was returned unchanged and
  a cancelled replacement remained stored.
- After a schema self-review, `uv run python -m unittest
  tests.test_server.ProgressStoreTests.test_progress_store_rejects_corrupt_nested_schema
  -v` failed for the persisted user key `" "` with `ValueError: Invalid user`,
  demonstrating incorrect 400-classification instead of storage corruption.

### GREEN

- `uv run python -m unittest tests.test_server -v` — 24 tests passed.
- `node --test tests/test_app.mjs` — 2 tests passed.
- Final complete verification:

  ```text
  uv run python -m unittest -v                 # Ran 24 tests ... OK
  node --test tests/test_app.mjs                # 2 passed, 0 failed
  uvx ruff format --check reader tests          # 3 files already formatted
  uvx ruff check reader tests                   # All checks passed!
  git diff --check                              # no output, exit 0
  ```

## Files changed

- `reader/server.py`
- `reader/static/app.js`
- `tests/test_server.py`
- `tests/test_app.mjs`
- `README.md`
- `.superpowers/sdd/final-review-fixes-report.md`

## Self-review and limits

- Reviewed the final diff for root-node scope, escaped SGF values, all required
  persistence fields, HTTP status mapping, bounded reads, localStorage cleanup,
  query redaction, and README terminology.
- No PDF source, existing Go problem source, or project dependency was changed.
- The Node harness exercises the browser identity logic with a minimal fake DOM;
  no interactive browser session was used. The server and storage paths were
  exercised through temporary fixtures and raw local HTTP connections.
- The pre-existing untracked `uv.lock` was intentionally left untouched and is
  not part of the commit.
