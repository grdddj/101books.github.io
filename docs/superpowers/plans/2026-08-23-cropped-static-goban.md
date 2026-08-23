# Cropped Static Goban Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render each static Go problem as its tight initial-position crop with a one-line margin, and advance after a successful solved/revisit save.

**Architecture:** Keep crop calculation and relative stone placement entirely in the dependency-free frontend. The existing collection API continues to supply original SGF coordinates and the existing progress API remains the persistence authority; the status action advances only after that API confirms a save.

**Tech Stack:** Vanilla JavaScript, CSS grid, Node built-in test runner, Python 3.10+, Ruff, `uv`.

## Global Constraints

- Derive the smallest inclusive rectangle containing every initial black and white stone.
- Expand the rectangle by one grid line on every side and clamp it to the 19 by 19 board.
- Preserve SGF orientation: `aa` is top-left, coordinate one is the column, coordinate two is the row.
- Do not add moves, solution information, stone placement, dependencies, or server/API/progress-schema changes.
- Advance only after a successful `solved` or `revisit` persistence response; keep the last problem selected and do not advance after a failed save.

---

## File Structure

- `reader/static/app.js` — crop calculation, relative board rendering, and post-save navigation.
- `reader/static/app.css` — make grid dimensions respond to the computed crop.
- `tests/test_app.mjs` — Node/DOM harness coverage for crop and status navigation.
- `README.md` — note compact cropped-board framing and automatic post-status advance.

### Task 1: Render cropped static boards and advance after saving

**Files:**
- Modify: `reader/static/app.js`
- Modify: `reader/static/app.css`
- Modify: `tests/test_app.mjs`
- Modify: `README.md`

**Interfaces:**
- Produces: `getBoardCrop(problem) -> { minColumn, maxColumn, minRow, maxRow, columns, rows }`.
- Produces: `renderBoard(problem)` that uses only `problem.black` and `problem.white` and returns the crop.
- Consumes: `setCurrentStatus(status)` and the existing `PUT /api/progress` response shape `{ problems }`.

- [ ] **Step 1: Write failing frontend tests**

Add a test-only export containing `getBoardCrop`, `renderBoard`, and
`setCurrentStatus`. Extend the fake DOM element with a `style` object and an
`append` recorder. Add these assertions:

```javascript
assert.deepEqual(
  cropFor({ black: ["aa"], white: ["bb"] }),
  { minColumn: 0, maxColumn: 2, minRow: 0, maxRow: 2, columns: 3, rows: 3 },
);
assert.deepEqual(
  cropFor({ black: ["jr"], white: ["ks"] }),
  { minColumn: 8, maxColumn: 11, minRow: 16, maxRow: 18, columns: 4, rows: 3 },
);
```

For a crop whose top-left original coordinate is `cp`, assert stone `dq` is
rendered at CSS grid column `2` and row `2`. Mock a successful progress PUT,
set `currentIndex` to 4, call `setCurrentStatus("solved")`, and assert it
becomes 5. Then set the index to the final problem and assert a successful
`revisit` remains at that final index; make the PUT reject and assert the
index does not change.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/test_app.mjs`

Expected: FAIL because crop helpers/test exports and post-save navigation do
not exist.

- [ ] **Step 3: Implement crop calculation and relative rendering**

Add a coordinate conversion helper and this crop algorithm:

```javascript
function getBoardCrop(problem) {
  const stones = [...problem.black, ...problem.white];
  const columns = stones.map((coordinate) => coordinate.charCodeAt(0) - 97);
  const rows = stones.map((coordinate) => coordinate.charCodeAt(1) - 97);
  const minColumn = Math.max(0, Math.min(...columns) - 1);
  const maxColumn = Math.min(18, Math.max(...columns) + 1);
  const minRow = Math.max(0, Math.min(...rows) - 1);
  const maxRow = Math.min(18, Math.max(...rows) + 1);
  return { minColumn, maxColumn, minRow, maxRow, columns: maxColumn - minColumn + 1, rows: maxRow - minRow + 1 };
}
```

In `renderBoard`, set `board.style.setProperty("--board-columns", crop.columns)`
and `--board-rows`; place each stone with one-based relative positions
`originalColumn - crop.minColumn + 1` and `originalRow - crop.minRow + 1`.
Change the CSS grid repeats to `repeat(var(--board-columns), ...)` and
`repeat(var(--board-rows), ...)`, and derive grid-line background sizing from
the crop dimensions. Retain stones’ `pointer-events: none`.

After a successful PUT and `renderReader`, call `navigate(1)` only when the
current index is below the last index. Do this before setting success feedback
so feedback identifies the saved problem while the next board is visible. Do
not navigate in the catch branch.

- [ ] **Step 4: Run focused tests and quality checks**

Run:

```bash
node --test tests/test_app.mjs
uv run python -m unittest -v
uvx ruff format --check reader tests
uvx ruff check reader tests
```

Expected: Node crop/navigation tests pass, 24 Python tests pass, and both Ruff
commands exit 0.

- [ ] **Step 5: Update documentation and manually smoke-check**

Add one README sentence stating that each board is cropped to its initial
stones plus a one-line margin and that successful Solved/Revisit actions open
the next problem. Start the local server, confirm a corner problem is cropped,
and confirm a successful status action advances exactly one problem.

- [ ] **Step 6: Commit the refinement**

```bash
git add reader/static/app.js reader/static/app.css tests/test_app.mjs README.md
git commit -m "feat: crop static Go positions"
```
