# Task 2 report: validated, atomic progress persistence

## Work completed

- Added `ProgressStore(path, problem_ids)` to `reader/server.py`.
- Added `get_user` and `set_status` with trimmed, non-empty user names capped at 80 characters.
- Validated the three supported statuses (`unseen`, `solved`, and `revisit`) and constructor-provided problem IDs.
- Persisted explicit statuses with UTC ISO-8601 `updated_at` values.
- Made `unseen` remove the problem entry.
- Implemented same-directory temporary JSON writes with flush, `os.fsync`, and `Path.replace` for atomic replacement; temporary files are cleaned up on failure.
- Added focused persistence tests, including reload, timestamp, validation, and removal behavior.

## TDD evidence

RED command:

```text
$ uv run python -m unittest tests.test_server.ProgressStoreTests -v
ImportError: cannot import name 'ProgressStore' from 'reader.server'
```

After implementation, focused GREEN command:

```text
$ uv run python -m unittest tests.test_server.ProgressStoreTests -v
Ran 5 tests in 0.023s
OK
```

## Verification

```text
$ uv run python -m unittest discover -s tests -v
Ran 10 tests in 0.023s
OK

$ uvx ruff check reader/server.py tests/test_server.py
All checks passed!
```

## Self-review and concerns

The implementation is limited to the requested persistence unit and does not add HTTP routes or alter collection parsing. Missing progress files initialize as an empty user collection, and parent directories are created when first writing. Existing malformed JSON or unsupported progress structures raise an error rather than being silently overwritten; route-level handling is left to Task 3.
