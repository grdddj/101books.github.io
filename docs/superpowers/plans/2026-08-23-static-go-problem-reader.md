# Static Go Problem Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, static web reader for the 200 problems in *200 Basic Go Problems*, with per-user persisted solved/revisit progress.

**Architecture:** A standard-library Python server parses the existing TeX source as the canonical problem ordering and serves only initial SGF positions plus a JSON progress API. A dependency-free single-page frontend renders a non-playable goban, navigates a single ordered problem at a time, and records status through the server while retaining the selected display name in browser localStorage.

**Tech Stack:** Python 3.10+, `http.server`, `unittest`, HTML, CSS, vanilla JavaScript, `uv`, Ruff.

## Global Constraints

- Use the ordered `\p{section}{problem-id}` entries in `books/200-basic-go-problems.tex`; never use filesystem order.
- The frontend must not receive, display, or allow play of SGF move sequences.
- Statuses are exactly `unseen`, `solved`, and `revisit`.
- Store display name only in browser localStorage and per-user progress only in `reader-data/progress.json`.
- Keep the feature dependency-free; use Python's standard library and browser-native APIs.
- Use atomic replacement for progress-file writes.

---

## File Structure

- `reader/server.py` — collection parsing, SGF initial-position parsing, JSON persistence, and HTTP routes.
- `reader/static/index.html` — the reader page structure and controls.
- `reader/static/app.css` — responsive, single-problem reader layout and goban appearance.
- `reader/static/app.js` — identity prompt, API requests, goban rendering, status state, and navigation.
- `tests/test_server.py` — unit and HTTP integration tests using temporary fixture repositories.
- `pyproject.toml` — Ruff configuration and Python-version declaration.
- `.gitignore` — ignores local runtime progress data.
- `README.md` — launch and usage instructions.

### Task 1: Define server-side collection and SGF parsing

**Files:**
- Create: `reader/server.py`
- Test: `tests/test_server.py`

**Interfaces:**
- Produces: `Problem` dataclass with `number: int`, `problem_id: str`, `black: list[str]`, and `white: list[str]`.
- Produces: `load_collection(repository_root: Path) -> list[Problem]`.
- Consumes: `books/200-basic-go-problems.tex` and `problems/200-basic-go-problems/<section>/<id>.sgf`.

- [ ] **Step 1: Write the failing parsing tests**

```python
def test_load_collection_uses_tex_order_and_initial_stones(self) -> None:
    fixture_root = self.make_fixture_collection()

    problems = load_collection(fixture_root)

    assert [(problem.number, problem.problem_id) for problem in problems] == [
        (1, "24176/174140"),
        (2, "24176/174139"),
    ]
    assert problems[0].black == ["aa"]
    assert problems[0].white == ["bb"]


def test_load_collection_rejects_missing_sgf(self) -> None:
    fixture_root = self.make_fixture_collection(tex="\\p{24176}{999999}%")

    with self.assertRaisesRegex(ValueError, "Missing SGF"):
        load_collection(fixture_root)
```

Put the tests in a `unittest.TestCase` with `TemporaryDirectory` cleanup and a
helper that writes the two minimal SGF fixtures under the expected paths.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run python -m unittest tests.test_server.CollectionTests -v`

Expected: FAIL because `reader.server` and `load_collection` do not exist.

- [ ] **Step 3: Implement the parser**

```python
@dataclass(frozen=True)
class Problem:
    number: int
    problem_id: str
    black: list[str]
    white: list[str]


def load_collection(repository_root: Path) -> list[Problem]:
    source = (repository_root / "books/200-basic-go-problems.tex").read_text()
    identifiers = re.findall(r"\\p\{(\d+)\}\{(\d+)\}", source)
    problems: list[Problem] = []
    for number, (section, problem) in enumerate(identifiers, start=1):
        sgf_path = repository_root / "problems/200-basic-go-problems" / section / f"{problem}.sgf"
        if not sgf_path.is_file():
            raise ValueError(f"Missing SGF: {sgf_path}")
        black, white = parse_initial_stones(sgf_path.read_text())
        problems.append(Problem(number, f"{section}/{problem}", black, white))
    return problems
```

`parse_initial_stones` must parse only `AB[...]` and `AW[...]` values, validate each coordinate is in `aa` through `ss`, and ignore all `;B[...]`/`;W[...]` moves.

- [ ] **Step 4: Run the focused tests**

Run: `uv run python -m unittest tests.test_server.CollectionTests -v`

Expected: PASS.

- [ ] **Step 5: Commit the parsing unit**

```bash
git add reader/server.py tests/test_server.py
git commit -m "feat: parse ordered static Go problems"
```

### Task 2: Add validated, atomic progress persistence

**Files:**
- Modify: `reader/server.py`
- Modify: `tests/test_server.py`

**Interfaces:**
- Produces: `ProgressStore(path: Path)`.
- Produces: `ProgressStore.get_user(user: str) -> dict[str, dict[str, str]]` and `ProgressStore.set_status(user: str, problem_id: str, status: str) -> dict[str, dict[str, str]]`.
- Consumes: valid problem IDs from `load_collection`.

- [ ] **Step 1: Write failing persistence tests**

```python
def test_progress_store_persists_a_solved_status(self) -> None:
    path = self.root / "reader-data/progress.json"
    store = ProgressStore(path, {"24176/174139"})

    result = store.set_status("Ada", "24176/174139", "solved")

    assert result["24176/174139"]["status"] == "solved"
    saved = json.loads(path.read_text())
    assert saved["users"]["Ada"]["problems"]["24176/174139"]["status"] == "solved"


def test_progress_store_rejects_invalid_status_and_unknown_problem(self) -> None:
    store = ProgressStore(self.root / "progress.json", {"24176/174139"})

    with self.assertRaisesRegex(ValueError, "Invalid status"):
        store.set_status("Ada", "24176/174139", "wrong")
    with self.assertRaisesRegex(ValueError, "Unknown problem"):
        store.set_status("Ada", "missing", "solved")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run python -m unittest tests.test_server.ProgressStoreTests -v`

Expected: FAIL because `ProgressStore` does not exist.

- [ ] **Step 3: Implement JSON storage**

Implement a `ProgressStore` that validates non-empty, trimmed display names of at most 80 characters; validates statuses against `{"unseen", "solved", "revisit"}`; and validates problem IDs against its constructor set. Store an ISO-8601 UTC `updated_at` with each explicit status. For `unseen`, remove the problem from the user's map. Write JSON to a same-directory `NamedTemporaryFile`, flush and `os.fsync`, then call `Path.replace()`.

- [ ] **Step 4: Run the focused tests**

Run: `uv run python -m unittest tests.test_server.ProgressStoreTests -v`

Expected: PASS.

- [ ] **Step 5: Commit the persistence unit**

```bash
git add reader/server.py tests/test_server.py
git commit -m "feat: persist local reader progress"
```

### Task 3: Expose the reader HTTP API and static assets

**Files:**
- Modify: `reader/server.py`
- Modify: `tests/test_server.py`
- Create: `reader/static/index.html`

**Interfaces:**
- Produces: `create_server(repository_root: Path, progress_path: Path) -> ThreadingHTTPServer`.
- Produces: `GET /api/collection`, `GET /api/progress?user=<name>`, and `PUT /api/progress`.
- Consumes: `Problem` and `ProgressStore` from Tasks 1–2.

- [ ] **Step 1: Write failing HTTP tests**

```python
def test_collection_endpoint_returns_initial_positions(self) -> None:
    response = self.get_json("/api/collection")

    self.assertEqual(response["title"], "200 Basic Go Problems")
    self.assertEqual(response["problems"][0]["id"], "24176/174140")
    self.assertNotIn("moves", response["problems"][0])


def test_progress_endpoint_round_trip(self) -> None:
    self.put_json("/api/progress", {"user": "Ada", "problem_id": "24176/174140", "status": "revisit"})

    response = self.get_json("/api/progress?user=Ada")

    self.assertEqual(response["problems"]["24176/174140"]["status"], "revisit")
```

Start `create_server` on port `0` in `setUp`, issue requests with
`urllib.request`, and shut it down in `tearDown`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run python -m unittest tests.test_server.HttpApiTests -v`

Expected: FAIL because `create_server` and routes do not exist.

- [ ] **Step 3: Implement routes and executable entry point**

Make a `SimpleHTTPRequestHandler` subclass that serves `reader/static`, emits `application/json; charset=utf-8`, and returns structured `{"error": "..."}` JSON with 400 for malformed requests, 404 for unknown routes, and 500 for unreadable/corrupt storage. `GET /api/collection` returns `{ "title": "200 Basic Go Problems", "problems": [...] }`; each problem contains `number`, `id`, `black`, and `white` only. Add `main()` with `--host`, `--port`, and `--progress-file` arguments, defaulting to `127.0.0.1`, `8000`, and `<repo>/reader-data/progress.json`.

- [ ] **Step 4: Run the focused tests**

Run: `uv run python -m unittest tests.test_server.HttpApiTests -v`

Expected: PASS.

- [ ] **Step 5: Commit the API unit**

```bash
git add reader/server.py reader/static/index.html tests/test_server.py
git commit -m "feat: serve static Go reader API"
```

### Task 4: Build the non-interactive reader frontend

**Files:**
- Modify: `reader/static/index.html`
- Create: `reader/static/app.css`
- Create: `reader/static/app.js`

**Interfaces:**
- Consumes: the Task 3 API responses.
- Produces: a one-problem-at-a-time reader with local identity and manual status controls.

- [ ] **Step 1: Add the static page structure**

Create semantic elements for a collection heading, progress summary, current-problem ordinal, an empty goban container, status feedback, and buttons with IDs `previous`, `solved`, `revisit`, and `next`. Include `app.css` and deferred `app.js`; do not include any SGF client parser, stone-placement event handlers, solution action, or script dependencies.

- [ ] **Step 2: Implement CSS for a responsive static goban**

Use CSS grid for 19 rows and 19 columns. Draw the grid with container gradients and use positioned round `.stone.black`/`.stone.white` elements with `pointer-events: none`. Keep the header visible, constrain the board to the viewport, and provide clear focus/selected-status styles for keyboard navigation.

- [ ] **Step 3: Implement frontend state and rendering**

Implement these functions in `app.js`:

```javascript
async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function getOrPromptUser() {
  const key = "static-go-reader-user";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const name = window.prompt("Your name for local progress:", "")?.trim();
  if (!name) throw new Error("A name is required to track progress.");
  localStorage.setItem(key, name);
  return name;
}

function firstPendingIndex(problems, statuses) {
  const index = problems.findIndex(({ id }) => !statuses[id] || statuses[id].status === "revisit");
  return index === -1 ? 0 : index;
}

function renderBoard(problem) {
  board.replaceChildren();
  for (const [color, coordinates] of [["black", problem.black], ["white", problem.white]]) {
    for (const coordinate of coordinates) {
      const stone = document.createElement("span");
      stone.className = `stone ${color}`;
      stone.style.gridColumn = coordinate.charCodeAt(0) - 96;
      stone.style.gridRow = coordinate.charCodeAt(1) - 96;
      board.append(stone);
    }
  }
}

function navigate(delta) {
  currentIndex = Math.max(0, Math.min(collection.problems.length - 1, currentIndex + delta));
  renderReader();
}
```

Define `renderReader` to update ordinal/progress/button state then call
`renderBoard`; define `setCurrentStatus` to PUT `{user, problem_id, status}`
with JSON headers, update `statuses`, and call `renderReader`. Both functions
must catch errors and put the message into the status-feedback element.

On startup, fetch collection and named-user progress, choose the first pending problem, and render it. Bind arrow keys and explicit buttons to `navigate`; mark buttons call `setCurrentStatus`. Bind a passive-wheel timer that moves one problem only after a threshold and cooldown, avoiding multi-problem jumps. If a save fails, retain the page state and show an error in the status-feedback element.

- [ ] **Step 4: Manually verify the browser behaviour**

Run: `uv run reader/server.py`

Open: `http://127.0.0.1:8000/`

Expected: a name prompt appears once; a static board renders; no click places a stone; all four navigation/status controls work; a reload retains the selected name and saved status.

- [ ] **Step 5: Commit the frontend unit**

```bash
git add reader/static/index.html reader/static/app.css reader/static/app.js
git commit -m "feat: add static one-problem Go reader"
```

### Task 5: Add tooling, documentation, and runtime-data hygiene

**Files:**
- Create: `pyproject.toml`
- Modify: `.gitignore`
- Create: `README.md`

**Interfaces:**
- Consumes: the executable command from Task 3.
- Produces: reproducible local launch, test, and lint instructions.

- [ ] **Step 1: Add minimal project configuration**

Create `pyproject.toml` declaring `requires-python = ">=3.10"` and Ruff's `target-version = "py310"`, line length `100`, and `src = ["reader", "tests"]`. Append `reader-data/` to `.gitignore` so local user progress cannot be committed.

- [ ] **Step 2: Document use and limitations**

Create `README.md` with these exact commands:

```bash
uv run reader/server.py
uv run python -m unittest -v
uvx ruff format --check reader tests
uvx ruff check reader tests
```

Explain that the reader is local-only at `http://127.0.0.1:8000/`, asks for a display name once per browser, writes progress to `reader-data/progress.json`, uses the source PDF's ordering, and intentionally does not allow stone placement or reveal solutions.

- [ ] **Step 3: Run static quality checks**

Run:

```bash
uvx ruff format --check reader tests
uvx ruff check reader tests
```

Expected: both commands exit 0. Apply `uvx ruff format reader tests` if format check reports changes, then rerun both commands.

- [ ] **Step 4: Commit tooling and documentation**

```bash
git add pyproject.toml .gitignore README.md
git commit -m "docs: explain local Go reader usage"
```

### Task 6: Verify the complete collection and clean the change

**Files:**
- Modify only if verification exposes a reader-related defect: files from Tasks 1–5.

**Interfaces:**
- Consumes: completed reader and test suite.
- Produces: evidence that the complete 200-problem source collection is usable.

- [ ] **Step 1: Run the complete automated suite**

Run: `uv run python -m unittest -v`

Expected: all parser, persistence, and HTTP tests pass.

- [ ] **Step 2: Verify the actual collection length**

Run:

```bash
uv run python -c 'from pathlib import Path; from reader.server import load_collection; print(len(load_collection(Path("."))))'
```

Expected: `200`.

- [ ] **Step 3: Verify the production API without creating repository data**

Run:

```bash
uv run reader/server.py --port 8765 --progress-file /tmp/static-go-reader-progress.json
curl --fail http://127.0.0.1:8765/api/collection
```

Expected: successful JSON containing 200 problem entries, each with `black` and `white` but no `moves` key. Stop the foreground server after the request; remove only the explicitly named `/tmp/static-go-reader-progress.json` if it was created.

- [ ] **Step 4: Review cleanup and documentation**

Run:

```bash
git diff --check HEAD~1..HEAD
git status --short
```

Expected: no whitespace errors and no generated runtime data tracked. Confirm `README.md` contains the launch, usage, persistence, and non-interactivity constraints.

- [ ] **Step 5: Commit any verification-driven correction**

If a reader-related correction was needed, commit only that correction with a message that states its reason. Otherwise no commit is required.
