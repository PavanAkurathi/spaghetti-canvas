# Changelog

## [0.1.0] — 2026-05-26

### Added
- **File canvas** — interactive infinite SVG canvas grouping files by module folder with bezier dependency curves
- **Syntax highlighting** — 8 languages via highlight.js (atom-one-dark palette) rendered in each file card
- **Branch canvas** — git branch timeline with parent-child connections inferred from `git merge-base`; branch cards show type, hash, age, commit message, and changed files
- **Files ↔ Branches mode toggle** in the top bar
- **VS Code active file tracking** — canvas auto-pans and pulses green on the currently open file
- **Auto-refresh on save** — graph re-scans 1.5s after saving, preserving pan/zoom
- **VS Code theme bridge** — CSS custom properties mapped to VS Code color variables
- **Open Beside** — clicking a file node opens it next to the canvas panel
- **Editor title button** for quick access
- **Configurable settings** — ignore dirs, allowed extensions, max preview lines via VS Code settings
- **Multi-root workspace** support for active file tracking
- **Standalone web mode** — browser app with CLI parsers for `codebase.json` / `git-graph.json`
- **Search + extension filter tabs** in files mode
- **Sidebar panel** — file details, size, incoming/outgoing imports on node click
