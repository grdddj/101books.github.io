# 101 Books Go Reader

The local reader discovers all 108 TeX Go booklets in the repository and keeps
each booklet in the ordering used by its source PDF. It is intended for local
use only and listens at `http://127.0.0.1:8000/` by default.

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
catalog and switch collections. Progress is stored locally in `reader-data/progress.json`;
this directory is intentionally ignored by Git. Several unauthenticated
browser-local profiles can use the same local process, but the progress model
is not a shared or network service.

Progress records are scoped to the selected booklet and to repeated positions
within it. Their IDs use the form `<booklet-slug>:<section>/<problem>@<occurrence>`,
so solving a position in one booklet never marks another booklet's position
complete. On the first read of an existing progress file, valid legacy 200
Basic Go Problems records are migrated to the corresponding namespaced IDs.

The reader intentionally does not allow stone placement or reveal solutions. Each board is cropped to its initial stones plus a one-line margin, and successful Solved or Revisit actions open the next problem; after saving the final problem, it remains selected with its saved status.
