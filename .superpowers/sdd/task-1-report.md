# Task 1 report: server-side collection and SGF parsing

## RED evidence

Command:

```text
uv run python -m unittest tests.test_server.CollectionTests -v
```

Result: failed during test import with `ModuleNotFoundError: No module named
'reader'`, because `reader.server` did not exist yet.

## GREEN evidence

Command:

```text
uv run python -m unittest tests.test_server.CollectionTests -v
```

Result: two tests passed:

```text
Ran 2 tests in 0.004s
OK
```

Static quality check:

```text
uvx ruff check reader/server.py tests/test_server.py
```

Result: `All checks passed!`

## Files changed

- `reader/server.py`: added the immutable `Problem` dataclass, TeX-order
  collection loading, missing-SGF validation, and initial AB/AW coordinate
  parsing with `aa` through `ss` validation.
- `tests/test_server.py`: added temporary-fixture unittest coverage for TeX
  ordering, initial stones, and missing SGFs.

## Self-review

- Collection numbering is assigned from the order of `\\p{section}{problem}`
  identifiers in the canonical TeX source.
- SGF move properties (`B` and `W`) are not parsed as setup stones.
- Invalid setup coordinates raise `ValueError` rather than being silently
  accepted.
- No existing files or PDF assets were changed.

## Test results

The required focused suite passes. `python -m unittest discover -v` reports no
tests because this repository does not currently make `tests/` a discoverable
package; this is a repository layout limitation, not a failing test.

## Concerns

The parser is intentionally small and regex-based for this task. It assumes
normal SGF property syntax and does not attempt to implement a complete SGF
grammar (for example, unusual escaped property values).
