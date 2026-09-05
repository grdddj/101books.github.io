# All-Collections Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let local named users choose any level-sorted booklet, read its static SGF positions, and track isolated progress across every booklet.

**Architecture:** Generalize the Python server around a `Collection` metadata model parsed from existing TeX booklets and source SGFs. The browser retains its static cropped-goban reader but loads a saved collection and presents a level-sorted selection panel; progress IDs include a collection slug and migrate the existing 200 Basic Go Problems records once.

**Tech Stack:** Python 3.10+, standard-library HTTP server, `unittest`, HTML/CSS/vanilla JavaScript, Node built-in test runner, Chromium smoke test, `uv`, Ruff.

## Global Constraints

- Scan every `books/*.tex` except `header.tex`; TeX `\p{section}{problem}` order remains canonical.
- Derive the SGF source directory by removing a trailing `-part-N` from the booklet slug.
- Order catalog entries from weakest kyu to strongest kyu, then 1 dan upward; break ties by title and slug.
- New progress keys are exactly `<booklet-slug>:<section>/<problem>@<occurrence>`; occurrence is one-based in that booklet's TeX order, and bare source IDs are never new writes.
- Migrate only valid legacy 200 Basic Go Problems IDs to their first occurrence, preserving status/timestamp and rejecting malformed persisted data without a partial rewrite.
- The browser saves only user name and selected booklet in localStorage; server progress remains `reader-data/progress.json`.
- Keep the reader static: no SGF moves, solution data, stone placement, new dependencies, or public-service assumptions.

---

## File Structure

- `reader/server.py` — collection metadata/SGF loading, namespaced progress, migration, and catalog endpoints.
- `tests/test_server.py` — metadata, all-booklet resolution, progress migration, and HTTP endpoint tests.
- `reader/static/index.html` — collection-panel markup and accessible controls.
- `reader/static/app.js` — saved collection, catalog loading, selection panel, and active-collection progress loading.
- `reader/static/app.css` — level-sorted collection panel layout.
- `tests/test_app.mjs` — saved-collection and panel-selection frontend tests.
- `tests/test_browser_collections.mjs` — controlled Chromium library-panel smoke test.
- `README.md` — all-collection launch, migration, and selection behavior.

### Task 1: Generalize server collections and namespaced progress

**Files:**
- Modify: `reader/server.py`
- Modify: `tests/test_server.py`

**Interfaces:**
- Produces: `Collection(slug, title, category, level, rank, problems)`.
- Produces: `load_collections(repository_root: Path) -> list[Collection]`.
- Produces: `collection_problem_id(slug: str, source_id: str) -> str`.
- Consumes: current `ProgressStore` and `Problem` behavior.

- [ ] **Step 1: Write failing metadata/progress tests**

Create temporary TeX fixtures for a kyu booklet, a dan booklet, and a
part-numbered booklet. Assert source-root derivation and catalog order:

```python
collections = load_collections(fixture_root)
assert [collection.slug for collection in collections] == ["beginner", "advanced-part-1"]
assert collections[1].problems[0].problem_id == "advanced-part-1:7/42"
```

Seed valid legacy `24176/174139` progress for user `Ada`, request the 200
Basic collection, and assert it becomes `200-basic-go-problems:24176/174139`
with the identical status/timestamp and no bare key. Assert an unknown bare
legacy ID raises `StorageCorruptionError` rather than migrating.

- [ ] **Step 2: Verify RED**

Run: `uv run python -m unittest tests.test_server.CollectionTests tests.test_server.ProgressStoreTests -v`

Expected: FAIL because `Collection`, `load_collections`, namespaced IDs, and
migration do not exist.

- [ ] **Step 3: Implement metadata and migration**

Add:

```python
@dataclass(frozen=True)
class Collection:
    slug: str
    title: str
    category: str
    level: str
    rank: int
    problems: list[Problem]


def source_collection_slug(booklet_slug: str) -> str:
    return re.sub(r"-part-\d+$", "", booklet_slug)


def collection_problem_id(slug: str, source_id: str, occurrence: int) -> str:
    return f"{slug}:{source_id}@{occurrence}"
```

Parse title/category/level from each TeX source; normalize kyu/dan to an
integer rank where 20 kyu sorts before 1 kyu and 1 dan follows it. Load each
ordered SGF under `problems/<source-root>/<section>/<id>.sgf`, assign each
appearance its occurrence suffix, and fail startup on missing/strictly invalid
files. Give `ProgressStore` the complete namespaced ID set and a one-time
migration method for valid 200 Basic legacy records. First construct and
validate the complete migrated document, then atomically write it once; leave
the source bytes untouched if any record is malformed.

- [ ] **Step 4: Add catalog and collection endpoints**

Implement `GET /api/collections` returning slug/title/category/level/rank and
problem_count only. Implement `GET /api/collections/<slug>` returning that
collection's title, slug, and initial-only `number`, `id`, `black`, `white`
positions. Return structured 404 for an unknown slug. Retain no
`/api/collection` compatibility endpoint unless tests prove a transitional
frontend request needs it.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
uv run python -m unittest tests.test_server -v
uv run python -c 'from pathlib import Path; from reader.server import load_collections; collections = load_collections(Path(".")); print(len(collections), sum(len(item.problems) for item in collections))'
uvx ruff format --check reader tests
uvx ruff check reader tests
```

Expected: tests pass; output starts with `108 `; formatting and lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add reader/server.py tests/test_server.py
git commit -m "feat: load all Go problem collections"
```

### Task 2: Add saved collection selection to the static reader

**Files:**
- Modify: `reader/static/index.html`
- Modify: `reader/static/app.js`
- Modify: `reader/static/app.css`
- Modify: `tests/test_app.mjs`
- Create: `tests/test_browser_collections.mjs`

**Interfaces:**
- Consumes: `GET /api/collections` and `GET /api/collections/<slug>`.
- Produces: `getSavedCollection`, `selectCollection`, `loadActiveCollection`, and an accessible selection panel.

- [ ] **Step 1: Write failing frontend tests**

Extend the fake API and DOM harness to assert that a valid
`static-go-reader-collection` is loaded first; an invalid saved slug falls
back to catalog entry zero and replaces localStorage; and selecting a panel
item persists the chosen slug, closes the panel, loads that collection and its
progress, and selects its first revisit/unseen problem. Assert the panel list
is already level-sorted from its API response and does not carry SGF moves.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/test_app.mjs`

Expected: FAIL because the catalog request, selected-booklet storage, panel,
and selection functions do not exist.

- [ ] **Step 3: Implement the panel and active collection loading**

Add a header `Change collection` button and a hidden dialog/panel containing a
semantic list of catalog buttons. Add:

```javascript
const COLLECTION_STORAGE_KEY = "static-go-reader-collection";
function getSavedCollection(catalog) {
  const saved = localStorage.getItem(COLLECTION_STORAGE_KEY);
  return catalog.some(({ slug }) => slug === saved) ? saved : catalog[0].slug;
}
async function loadActiveCollection(slug) {
  collection = await fetchJson(`/api/collections/${encodeURIComponent(slug)}`);
  statuses = (await fetchJson(`/api/progress?user=${encodeURIComponent(user)}`)).problems;
  currentIndex = firstPendingIndex(collection.problems, statuses);
  renderReader();
}
async function selectCollection(slug) {
  localStorage.setItem(COLLECTION_STORAGE_KEY, slug);
  collectionPanel.hidden = true;
  await loadActiveCollection(slug);
}
```

Fetch catalog before selecting a collection. Render each item with title,
level, category, count, and solved/revisit totals calculated from the active
user's progress map. While selection is loading, disable reader and selection
controls; retain error feedback if it fails. Use the existing static cropped
board/status interaction unchanged.

- [ ] **Step 4: Add controlled browser coverage**

Use local Chromium with a temporary server/progress path to assert the panel
opens, catalog order is visible, selecting a second collection updates the
header and localStorage, and its progress count is independent from the first
collection. Do not rely on a manual prompt: seed a valid localStorage user.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
node --test tests/test_app.mjs tests/test_browser_grid.mjs tests/test_browser_collections.mjs
uv run python -m unittest -v
uvx ruff format --check reader tests
uvx ruff check reader tests
```

Expected: all Node/browser tests and all Python tests pass.

- [ ] **Step 6: Commit**

```bash
git add reader/static/index.html reader/static/app.js reader/static/app.css tests/test_app.mjs tests/test_browser_collections.mjs
git commit -m "feat: let readers select any Go booklet"
```

### Task 3: Document and verify every collection end-to-end

**Files:**
- Modify: `README.md`
- Modify only if verification finds a reader defect: files from Tasks 1–2.

**Interfaces:**
- Consumes: completed catalog, namespaced progress, selection UI, and test suites.
- Produces: reproducible all-collection launch and validation evidence.

- [ ] **Step 1: Update documentation**

Document that the reader discovers all 108 TeX booklets, reopens the saved
booklet, offers Change collection, keeps per-booklet progress under
namespaced IDs, and migrates valid legacy 200 Basic progress on first load.
Add the complete Node test command:

```bash
node --test tests/test_app.mjs tests/test_browser_grid.mjs tests/test_browser_collections.mjs
```

- [ ] **Step 2: Run full quality and corpus checks**

Run:

```bash
uv run python -m unittest -v
node --test tests/test_app.mjs tests/test_browser_grid.mjs tests/test_browser_collections.mjs
uvx ruff format --check reader tests
uvx ruff check reader tests
uv run python -c 'from pathlib import Path; from reader.server import load_collections; collections = load_collections(Path(".")); assert len(collections) == 108; assert all(item.problems for item in collections); print(sum(len(item.problems) for item in collections))'
git diff --check
git status --short
```

Expected: all checks exit 0; the corpus command prints the total number of
loadable booklet positions; no generated progress/cache/temp data is tracked.

- [ ] **Step 3: Live API verification**

Start the server on port 8766 with the explicit temporary progress path
`/tmp/all-collections-reader-progress.json`. Verify `GET /api/collections`
returns 108 ordered entries, `GET /api/collections/200-basic-go-problems`
returns 200 initial-only positions, and a second booklet returns a different
namespaced ID prefix. Stop only this server and remove only that exact
temporary progress file if created.

- [ ] **Step 4: Commit documentation or a verification correction**

```bash
git add README.md
git commit -m "docs: explain all-collections Go reader"
```

If verification required a reader fix, include only that fix and its tests in
the same or a separate reasoned commit.
