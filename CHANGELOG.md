# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-08-15

### Added

- Unified and side-by-side views for unified diff patches, switchable from the toolbar.
- Word-level highlighting within changed lines, computed once and shared by both views.
- Three ways to load a patch: drag and drop, file picker, and pasted text.
- Light and dark themes, following the system preference until one is chosen explicitly.
- Collapsible per-file sections showing the change kind and added or removed line counts.
- Explicit notes for patches with no hunks, covering binary, rename, copy, and mode-only changes.
