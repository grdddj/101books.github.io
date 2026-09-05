# Collection progress fill design

## Goal

Make the collection chooser visually distinguish untouched, started, partially
solved, and finished booklets, and give each booklet a shareable URL without
changing the reader's static training experience.

## Progress rule

- Completion is `solved / problem_count`; `revisit` does not count as solved.
- An untouched collection has no `solved` or `revisit` status.
- A collection with one or more `revisit` records but no solved positions is
  started and receives a thin orange indicator.
- A collection with 1–99% solved positions receives an orange background fill
  spanning its solved percentage of the collection row.
- A collection with every position solved receives a full green row background.

## Frontend design

The existing collection button remains the interactive row.  Rendering assigns
semantic state classes and a CSS custom property for its solved percentage.
CSS draws the fill as an internal, non-interactive layer so the existing
button label, focus treatment, catalog order, and selection behaviour remain
unchanged.  Row text continues to state the solved and revisit counts, and
will add the solved percentage for non-visual users.

The selected collection is still selectable regardless of status.  The dialog
continues to trap focus and block background reader navigation.

## Collection URLs

- Each collection uses the canonical path `/collections/<slug>`.
- Selecting a collection fetches it successfully before `history.pushState`
  adds its canonical URL.  A failed selection leaves both the visible
  collection and current URL unchanged.
- Opening or refreshing a valid collection path serves the reader shell, then
  loads the slug from the path.  The local Python server must route this path
  to the static reader page rather than return a file-not-found response.
- A missing or unknown slug produces the reader's recoverable error state; it
  does not silently fall back to another collection.
- Browser Back and Forward handle `popstate`, load the collection represented
  by the new path, and do not create an additional history entry.
- The root reader URL continues to use the saved last collection from local
  storage.

## Testing and documentation

Frontend unit tests will cover untouched, revisit-only, partially solved, and
fully solved catalog rows, including the percentage data passed to styling.
They will also cover parsing valid and invalid collection paths, successful
selection URL updates, and history navigation without duplicate entries.
Server tests will cover serving the reader shell at a collection path while
preserving API routing. Existing browser tests will cover deep linking,
selection, and dialog behaviour. README will document the canonical collection
URLs because they are a new user-facing reader workflow.
