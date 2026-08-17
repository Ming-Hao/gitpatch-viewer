# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A pill on any file row opened on part of its diff, giving the hunks rendered so far and filling in proportion as further batches land.

### Changed

- An opened file now renders its hunks in batches of roughly 300 lines, with a footer offering the next batch or the whole remainder.

### Security

- The build workflow now declares read-only repository permissions, so its token no longer inherits whatever the repository defaults grant.
- Deployed responses now carry a content security policy that permits only same-origin scripts and styles, along with `X-Content-Type-Options` and `Referrer-Policy`.

## [1.1.0] - 2026-08-16

### Added

- A coloured rule down the left of each file row, shared by files in the same directory; hovering a row thickens its own directory's rules and fades the others back.
- A bar behind each row sized by that file's share of the largest change in the patch, on a linear or logarithmic scale.
- Controls in the summary bar for the bar scale and the hover fade, each with a tooltip describing the current setting and the effect of switching, and each remembered between visits.

### Changed

- A loaded patch now opens as a list of file rows; the diff is built only when a row is opened, and discarded when it is closed.
- Files are ordered by directory, then by change kind within each directory.

### Fixed

- The paste box now has a visible border; the previous one fell below the minimum contrast against its fill.

## [1.0.0] - 2026-08-15

### Added

- Unified and side-by-side views for unified diff patches, switchable from the toolbar.
- Word-level highlighting within changed lines, computed once and shared by both views.
- Three ways to load a patch: drag and drop, file picker, and pasted text.
- Light and dark themes, following the system preference until one is chosen explicitly.
- Collapsible per-file sections showing the change kind and added or removed line counts.
- Explicit notes for patches with no hunks, covering binary, rename, copy, and mode-only changes.
