# Collection progress and links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shareable collection URLs and coloured solved-progress fills to the collection chooser.

**Architecture:** The Python HTTP handler serves the existing reader shell for `/collections/<slug>` while preserving API routes. The frontend parses canonical paths, uses the History API only after successful collection loads, responds to `popstate`, and decorates existing collection buttons with CSS state classes and a solved-percentage custom property.

**Tech Stack:** Python 3.10 standard-library HTTP server, vanilla JavaScript History API, CSS custom properties, Node built-in test runner, Chromium browser tests, Ruff.

## Global Constraints

- Canonical collection URL: `/collections/<slug>`.
- Root URL continues to use saved last collection; unknown collection slugs show a recoverable error without a silent fallback.
- Push a history entry only after the requested collection loads; Back and Forward must not add entries.
- Completion equals solved positions divided by `problem_count`; revisits never count as solved.
- Revisit-only rows have a thin orange indicator; partial solved rows have an orange fill; 100%-solved rows are green.
- Retain one accessible button per collection, keyboard modal behavior, static board-only training, and no solutions/moves.
- Update README for the new shareable URLs; remove no unrelated code.

---

### Task 1: Serve and test collection deep-link paths

**Files:**

- Modify: `reader/server.py`
- Modify: `tests/test_server.py`

**Interfaces:**

- Consumes: `GET /collections/<slug>` and existing `ReaderRequestHandler` static-file handling.
- Produces: HTTP 200 reader `index.html` for a single collection path; existing `/api/*` endpoints retain their responses.

- [ ] **Step 1: Write failing server tests**

Add HTTP tests that request `/collections/200-basic-go-problems` and assert status 200 with the reader shell's `id="collection-list"`. Add a test that `/api/collections` remains JSON and that a malformed collection path such as `/collections/one/two` is not treated as a reader route.

- [ ] **Step 2: Run focused server tests to verify failure**

Run `uv run python -m unittest tests.test_server.HttpApiTests -v`. Expected: the deep-link test fails with 404 because the static handler looks for a matching file.

- [ ] **Step 3: Add a minimal reader-shell fallback**

In `ReaderRequestHandler`, recognize only a path matching `/collections/` followed by exactly one non-empty segment. Route it to `reader/static/index.html` using the same safe file-serving mechanism as `/`; do not inspect the slug against the catalog in the server route. Leave malformed nested paths and every `/api/` path to normal routing.

- [ ] **Step 4: Run focused server tests to verify success**

Run `uv run python -m unittest tests.test_server.HttpApiTests -v`. Expected: all endpoint tests pass, including deep-link and API-preservation coverage.

- [ ] **Step 5: Commit Task 1**

Run `git add reader/server.py tests/test_server.py && git commit -m "feat: serve collection reader links" -m "Allow direct collection URLs to load the static reader shell."`.

### Task 2: Add history-aware collection selection and test it

**Files:**

- Modify: `reader/static/app.js`
- Modify: `tests/test_app.mjs`
- Modify: `tests/test_browser_collections.mjs`

**Interfaces:**

- Consumes: `window.location.pathname`, `window.history.pushState`, `window.popstate`, and `GET /api/collections/<slug>`.
- Produces: `collectionPath(slug)`, `getCollectionSlugFromPath()`, and collection loads that distinguish a user navigation from a history navigation.

- [ ] **Step 1: Write failing frontend unit tests**

Extend the DOM harness with `window.location`, `window.history.pushState`, and a captured `popstate` listener. Assert that `/collections/test-collection` selects that catalog entry on startup, an unknown URL produces an error without loading the first collection, a successful dialog selection pushes `/collections/<slug>`, and firing `popstate` loads the URL's collection without calling `pushState`.

- [ ] **Step 2: Run focused frontend tests to verify failure**

Run `node --test tests/test_app.mjs`. Expected: deep-link and history assertions fail because startup always uses local storage and selection never updates browser history.

- [ ] **Step 3: Implement minimal path and history helpers**

Add a `collectionPath(slug)` helper returning `/collections/${encodeURIComponent(slug)}`. Parse only the root path and exactly one `/collections/<slug>` segment. Make startup prefer a valid path slug over local storage. Add an explicit `historyMode` argument to collection loading: user selection calls `history.pushState` after fetches succeed; startup and `popstate` do not. Register one `popstate` handler that loads the current pathname, preserving URL/display consistency on request errors.

- [ ] **Step 4: Add a Chromium browser test**

Start the real local reader at `/collections/200-basic-go-problems`, assert the requested title loads, select another collection, assert the location pathname changes, then invoke browser back and assert the original collection title returns.

- [ ] **Step 5: Run focused frontend and browser tests**

Run `node --test tests/test_app.mjs tests/test_browser_collections.mjs`. Expected: all unit and Chromium tests pass.

- [ ] **Step 6: Commit Task 2**

Run `git add reader/static/app.js tests/test_app.mjs tests/test_browser_collections.mjs && git commit -m "feat: navigate collections with shareable URLs" -m "Keep selected booklets addressable and synchronize browser history."`.

### Task 3: Render collection progress fills, document, and validate

**Files:**

- Modify: `reader/static/app.js`
- Modify: `reader/static/app.css`
- Modify: `tests/test_app.mjs`
- Modify: `README.md`

**Interfaces:**

- Consumes: `getCatalogStatusTotals(slug) -> { solved: number, revisit: number }` and catalog `problem_count`.
- Produces: option classes `collection-option--started`, `collection-option--partial`, `collection-option--complete`, plus the `--collection-progress` style property.

- [ ] **Step 1: Write failing progress-state tests**

Add four catalog entries and matching statuses. Assert untouched rows have no state class, revisit-only rows have `collection-option--started` and `0%`, 25%-solved rows have `collection-option--partial` and `25%`, and fully-solved rows have `collection-option--complete` and `100%`. Assert button labels include `Solved: <count> (<percentage>%)`, and CSS contains `var(--collection-progress)` plus selectors for each state.

- [ ] **Step 2: Run focused test to verify failure**

Run `node --test tests/test_app.mjs`. Expected: state class, percentage, and styling assertions fail.

- [ ] **Step 3: Implement the smallest row decoration**

In `renderCollectionList()`, calculate the solved percentage from `totals.solved / item.problem_count * 100`. Apply complete when solved equals count, partial when solved is positive, started when revisits are positive and solved is zero, otherwise no state. Set `--collection-progress` to the percentage. CSS uses a non-interactive pseudo-element for the orange partial fill, a thin orange inset for started rows, and a green complete background; label and focus states remain above the fill.

- [ ] **Step 4: Document deep links**

Update README's collection-switcher paragraph to state that every booklet can be opened at `/collections/<slug>` and that the root URL restores the last selected booklet.

- [ ] **Step 5: Run complete validation**

Run `uv run python -m unittest -q`, `node --test tests/test_app.mjs tests/test_browser_grid.mjs tests/test_browser_collections.mjs`, `uvx ruff format --check reader tests`, `uvx ruff check reader tests`, and `git diff --check`. Expected: all Python, Node/Chromium, formatting, lint, and whitespace checks pass.

- [ ] **Step 6: Cleanup and commit Task 3**

Confirm no existing files became unused; none should be removed. Run `git add reader/static/app.js reader/static/app.css tests/test_app.mjs README.md && git commit -m "feat: show collection completion progress" -m "Make started, partial, and completed booklets scannable in the collection chooser."`.
