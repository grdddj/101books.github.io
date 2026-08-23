# Collection progress fill design

## Goal

Make the collection chooser visually distinguish untouched, started, partially
solved, and finished booklets without changing the reader's static training
experience.

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

## Testing and documentation

Frontend unit tests will cover untouched, revisit-only, partially solved, and
fully solved catalog rows, including the percentage data passed to styling.
Existing browser tests will continue to cover catalog selection and dialog
behaviour.  README changes are unnecessary because this is a visual refinement
of the documented collection chooser, not a new command or persistence model.
