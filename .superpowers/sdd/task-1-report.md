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

The parser is intentionally small and does not attempt to implement a complete
SGF grammar. It handles bracketed values, escapes, and nested brackets needed
to avoid false setup stones in comments.

## Review fix

The original regex could mistake `AB[...]` or `AW[...]` text inside a comment
for setup stones. Regression coverage was added for comment text, escaped
brackets, multiple setup values, and invalid setup coordinates.

### Fix RED evidence

Command:

```text
uv run python -m unittest tests.test_server.CollectionTests.test_parse_initial_stones_ignores_comment_text_and_reads_multiple_values -v
```

Result: expected failure with `ValueError: Invalid SGF coordinate: tt`, as the
old regex incorrectly parsed the comment's `AB[tt]` text.

### Fix GREEN evidence

The regex was replaced with a minimal property-aware scanner. It consumes
bracketed values (including escaped and nested brackets), skips their contents,
and recognizes only actual uppercase SGF property identifiers. Commands:

```text
uv run python -m unittest tests.test_server.CollectionTests -v
uvx ruff check reader/server.py tests/test_server.py
```

Results: all 4 focused tests passed and Ruff reported `All checks passed!`.

## Second review fix

The scanner was treating an unescaped `[` inside a property value as a nested
delimiter. A regression test now covers ordinary unescaped `[` comment text
followed by a real `AB[aa]` property.

### Fix RED evidence

Command:

```text
uv run python -m unittest tests.test_server.CollectionTests.test_parse_initial_stones_treats_unescaped_open_bracket_as_comment_text -v
```

Result: expected failure with `ValueError: Unterminated SGF property value`.

### Fix GREEN evidence

The value scanner now ends at the first unescaped `]`; `[` is treated as
ordinary value text, while backslash escapes remain supported. Commands:

```text
uv run python -m unittest tests.test_server.CollectionTests -v
uvx ruff check reader/server.py tests/test_server.py
```

Results: all 5 focused tests passed and Ruff reported `All checks passed!`.
