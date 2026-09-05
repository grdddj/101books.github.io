# Cropped Static Goban Design

## Purpose

Make each static training position visually compact and advance immediately
after an explicit training outcome is saved.

## Board crop

For every problem, the frontend derives the smallest inclusive SGF-coordinate
rectangle containing all initial black and white stones. It then expands that
rectangle by one grid line on each side and clamps the result to the 19 by 19
board.

The goban renders only this cropped grid. Stone positions are converted from
their original SGF coordinates into positions relative to the crop, so the
orientation remains unchanged: `aa` is top-left, the first coordinate is the
column, and the second is the row. The crop includes all initial stones and
one line of immediate empty context where the board has room; no moves or
solution information are added.

## Status navigation

After the server successfully persists `solved` or `revisit` for the current
problem, the reader advances one problem. At the last problem it remains on
problem 200 while displaying the saved status. If saving fails, it retains the
current problem and shows the existing error feedback; it does not advance.

## Scope and verification

Only `reader/static/app.js`, `reader/static/app.css`, and the versioned
frontend test harness change. The server API, SGF source data, ordering, and
progress-file schema are unchanged.

Automated frontend tests cover corner, edge, and centre crop bounds; relative
stone placement; one-line margin clamping; status-driven advance; last-problem
behavior; and no advance after a failed save. The Python suite and Ruff checks
remain green. A browser smoke check confirms the visible cropped grid and one
step advance after each successful status action.
