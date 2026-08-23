# Static Go Problem Reader

## Purpose

Provide a local web reader for the complete *200 Basic Go Problems* collection.
It presents exactly one static Go problem at a time, in the order used by the
existing PDF, so that training stays visual and sequential rather than
interactive.

## Scope

- Serve all 200 positions listed by `books/200-basic-go-problems.tex`.
- Render each SGF's initial black and white stones on a responsive 19 by 19
  goban.
- Move through problems sequentially using controls, arrow keys, and the
  scroll wheel.
- Let a named local user mark a problem as `solved` or `revisit`; an untouched
  problem is `unseen`.
- Persist progress in a JSON file owned by the local Python server.

Out of scope: placing stones, move validation, showing SGF solution moves,
accounts, authentication, sharing progress, and deploying the reader.

## Architecture

The standard-library Python HTTP server has three responsibilities:

1. Parse the ordered `\p{section}{problem-id}` entries from the existing TeX
   source. This remains the canonical collection order.
2. Read the corresponding SGF files beneath `problems/200-basic-go-problems/`
   and return only their initial stones as JSON.
3. Read and atomically update `reader-data/progress.json` through a small
   progress API.

The static frontend is served by the same process. On first visit it asks for a
display name and saves it in browser `localStorage`. The name is sent with
progress requests and becomes the key in the server-side JSON document. The
frontend renders the goban itself and never receives or displays the SGF move
sequence, preventing accidental solution disclosure.

## API and persistence

`GET /api/collection` returns the title and ordered initial positions for all
200 problems. Each entry contains its one-based position, source identifiers,
and black/white coordinate arrays.

`GET /api/progress?user=<name>` returns that user's status map. `PUT
/api/progress` accepts a user, problem identifier, and one of `unseen`,
`solved`, or `revisit`; `unseen` removes an explicit status.

`reader-data/progress.json` uses this shape:

```json
{
  "users": {
    "Ada": {
      "problems": {
        "24176/174139": {"status": "solved", "updated_at": "2026-08-23T12:00:00Z"}
      }
    }
  }
}
```

Writes use a temporary file plus rename to avoid leaving a partial file after
an interrupted save. This is a trusted, local-user tool: display names are not
authentication.

## Reader behaviour

The reader initially selects the first problem whose status is `unseen` or
`revisit`; if none exists, it selects the first problem. A fixed status header
shows collection progress and current ordinal. The main view contains the
goban and a compact control row for previous, solved, revisit, and next.
Navigation does not alter status. Scroll-wheel navigation is debounced to one
problem per gesture, and button/key navigation remains available for users who
do not use a mouse.

## Error handling

The server responds with useful JSON errors for malformed user names, unknown
problem identifiers, invalid statuses, missing SGFs, and corrupted progress
data. The frontend keeps the current problem visible and reports failed saves
instead of pretending that progress was persisted.

## Verification

- Unit tests cover TeX ordering, SGF initial-stone parsing, progress validation,
  and JSON persistence.
- Integration tests start the HTTP server against a temporary progress path and
  exercise collection and progress endpoints.
- Static checks use `uvx ruff format --check` and `uvx ruff check` for the
  Python code.
- A manual browser check verifies all 200 positions can be navigated and a
  status persists across a page reload.

## Documentation and cleanup

The repository README will gain launch and usage instructions for the reader.
The prototype adds isolated reader files only; no existing PDF-generation code
is replaced or removed.
