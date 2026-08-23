# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A change-type menu at the head of the filter bar, narrowing the file list to the kinds selected (modified, added, deleted, renamed); only the kinds the current patch contains are listed, several selected kinds read as "any of these", and the selection narrows what the name filter beside it already left rather than replacing it.

## [1.2.2] - 2026-08-22

### Added

- A filter bar above the file list, filtering by filename substring or by extension (`*.ts` / `.ts`); extension chips are generated from the current patch and collapse into "+N more" as the window narrows.

### Changed

- A build not sitting on its version's tag now marks the version `+dev` rather than `-dev`, since such a build follows the release rather than preceding it.

### Fixed

- A narrow window no longer breaks toolbar labels mid-phrase; as it closes the left cluster stacks, the controls fall back to shorter labels, and the commit hash steps out.

## [1.2.1] - 2026-08-18

### Added

- The toolbar now carries the version, the commit it was built from, a GitHub link to that same point, and a note that the site runs on Cloudflare Workers; a build not sitting on its version's tag marks the version `-dev`.

### Changed

- The product name in the toolbar is set two points larger than the controls beside it.

## [1.2.0] - 2026-08-17

### Added

- A pill on any file row opened on part of its diff, giving the hunks rendered so far and filling in proportion as further batches land.

### Changed

- Hovering a file row now pushes the other directories back by their text as well as their paint, and lifts the pointed-at directory with a wash of its own.
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

[Unreleased]: https://github.com/Ming-Hao/gitpatch-viewer/compare/v1.2.2...HEAD
[1.2.2]: https://github.com/Ming-Hao/gitpatch-viewer/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/Ming-Hao/gitpatch-viewer/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Ming-Hao/gitpatch-viewer/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Ming-Hao/gitpatch-viewer/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Ming-Hao/gitpatch-viewer/tree/v1.0.0
