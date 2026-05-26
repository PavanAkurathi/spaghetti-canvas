# 🍝 Spaghetti Canvas

> An interactive infinite canvas for VS Code that visualizes your codebase as a dependency graph and git branches as a connected timeline — with syntax-highlighted file previews.

---

## Features

### 📁 File Canvas
- Every file rendered as a **syntax-highlighted card** (TypeScript, JavaScript, Svelte, Rust, Python, CSS, JSON, Markdown)
- Files grouped by module folder in an **infinite pan/zoom canvas**
- **Bezier dependency curves** connecting files based on import statements
- **Hover** a node to highlight all its imports and importers
- **Search** to filter files by name; **filter tabs** by extension
- Click any card to open the file in the editor and see full details in a sidebar

### 🌿 Branch Canvas
- Every local git branch rendered as a card showing: branch type, commit hash, age, commit message, and changed files
- **Parent → child connections** inferred from `git merge-base` — shows your stacked-branch timeline
- Color-coded by branch type: `feat` (indigo), `bugfix` (red), `refactor` (amber), `chore` (violet), `main` (emerald)

### 🔗 VS Code Integration
- **Active file tracking** — switch tabs and the canvas auto-pans to highlight the open file with a green pulse ring
- **Auto-refresh on save** — graph re-scans 1.5s after you save a file, preserving your pan/zoom position
- **Open Beside** — clicking a node opens the file next to the canvas panel
- **Theme bridge** — respects your VS Code color theme (background, sidebar, borders) via CSS custom properties
- **Editor title button** — ⊞ icon in the editor title bar to open the canvas

---

## Installation

### From the Marketplace
Search **"Spaghetti Canvas"** in the VS Code Extensions view, or:
```
ext install spaghetti-team.spaghetti-canvas
```

### From `.vsix` (local)
```bash
bun install
bun run build
bun run package        # produces spaghetti-canvas-0.1.0.vsix
code --install-extension spaghetti-canvas-0.1.0.vsix
```

---

## Usage

1. Open a folder in VS Code
2. Run **`Spaghetti: Visualize Codebase`** from the Command Palette (`⌘⇧P`)  
   — or click the **⊞** icon in the editor title bar
3. The canvas loads with the **Files** view by default
4. Switch to **Branches** (top bar) to see your git branch timeline
5. **Pan**: drag the canvas background  
   **Zoom**: scroll wheel  
   **Reset**: click *Reset View*

---

## Standalone Web App

The parser scripts can generate JSON for the browser standalone mode:

```bash
# Generate codebase graph for /path/to/your-project
bun src/parser/graph.ts /path/to/your-project public/codebase.json

# Generate git branch graph
bun src/parser/git-graph.ts /path/to/your-project public/git-graph.json

# Start the dev server
bun run dev
# → open http://localhost:5180
```

---

## Configuration

Open **Settings** → search `Spaghetti` to configure:

| Setting | Default | Description |
|---|---|---|
| `spaghetti.ignoredDirectories` | `["node_modules", ".git", ...]` | Directories to skip during scan |
| `spaghetti.allowedExtensions` | `[".ts", ".js", ".svelte", ...]` | File types to include |
| `spaghetti.maxPreviewLines` | `20` | Lines of code shown per card |

---

## Works on VS Code Forks

Built on the standard VS Code Extension API — works on:
- **Cursor** ✅
- **Windsurf** ✅
- **VSCodium** ✅
- **GitHub Codespaces** ✅
- **Gitpod** ✅

---

## Development

```bash
bun install
bun run dev           # web dev server → http://localhost:5180
bun run build         # build web + extension
bun run check         # svelte-check
bun run icon          # regenerate icon.png from icon.svg
bun run package       # package .vsix
```

### Project Structure

```
src/
  App.svelte          # Full canvas UI (files + branches, pan/zoom, highlights)
  extension.ts        # VS Code extension host (scan, watch, message bridge)
  main.ts             # Browser entry point
  parser/
    graph.ts          # CLI: codebase → codebase.json
    git-graph.ts      # CLI: git branches → git-graph.json
public/               # Sample data (chai-reader project)
icon.svg / icon.png   # Extension icon
generate-icon.ts      # SVG → PNG converter
```

---

## License

MIT
