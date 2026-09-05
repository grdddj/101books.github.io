# All-Collections Reader Design

## Purpose

Expand the static Go reader from one hard-coded booklet to every booklet in
the repository, while preserving ordered training and separate named-user
progress for each booklet.

## Collection catalog

The Python server scans every `books/*.tex` except `header.tex`. For each
booklet it parses the existing filename slug, English title, category, level,
and ordered `\p{section}{problem}` entries. Its SGF source directory is the
booklet slug with a trailing `-part-N` removed; this matches the current source
layout, such as `bedtime-tsumego-part-2` -> `problems/bedtime-tsumego`.

The catalog exposes each booklet's stable slug, title, category, normalized
rank, display level, and problem count. It is ordered from weakest kyu level
to strongest kyu level, then from 1 dan upward; ties use title and slug for a
deterministic order.

## API and progress

`GET /api/collections` returns the catalog. `GET /api/collections/<slug>`
returns that booklet's initial positions in its TeX-defined order. Existing
progress routes continue to serve and update the active user's statuses, but
all new problem IDs are namespaced as
`<booklet-slug>:<section>/<problem>@<occurrence>`, where occurrence is the
one-based appearance of that source identifier within the booklet's TeX order.
This avoids collisions between source identifiers from distinct collections
and lets repeated appearances within a booklet retain independent progress.

When a user first loads `200-basic-go-problems`, the progress store migrates
that user's existing unnamespaced `section/problem` records to the namespaced
first-occurrence form, retaining status and timestamp. Migration preflights the
entire persisted document and writes only after the migrated document validates;
malformed, conflicting, or unrelated records remain storage errors without any
partial rewrite.

## Reader experience

The reader stores `static-go-reader-collection` in browser localStorage. On
load it opens the valid saved booklet; with no saved or invalid choice it uses
the first catalog entry. The existing per-booklet first-unseen/revisit rule
then selects the initial problem.

The header includes a Change collection control. It opens an accessible,
level-sorted collection panel with each booklet's category, level, problem
count, and current user's solved/revisit totals. Selecting a booklet persists
the choice, loads its collection/progress, closes the panel, and displays its
first pending problem. It does not expose solution lines or make the board
playable.

## Scope and verification

Server tests cover TeX metadata parsing, source-directory derivation, level
ordering, all-booklet SGF resolution, strict malformed-SGF rejection, slug
validation, occurrence-namespaced progress, and all-or-nothing migration.
Frontend tests cover stored-booklet recovery, collection-panel
selection, and reloading progress for the selected booklet. Browser checks
confirm a level-sorted panel, selection change, and independent progress
counts. README documents all-booklet support and the stable-ID/migration
behavior.
