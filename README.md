# 101 Books Go Reader

The local reader presents the 200 Basic Go Problems collection in the ordering
used by the source PDF. It is intended for local use only and listens at
`http://127.0.0.1:8000/` by default.

## Run locally

From the repository root:

```bash
uv run reader/server.py
uv run python -m unittest -v
uvx ruff format --check reader tests
uvx ruff check reader tests
```

Open `http://127.0.0.1:8000/` after starting the server. The reader asks for a
display name once per browser. Progress is stored locally in
`reader-data/progress.json`; this directory is intentionally ignored by Git.
The progress model is one process-local server and a JSON file, so it is not a
shared or multi-user service.

The reader intentionally does not allow stone placement or reveal solutions.
