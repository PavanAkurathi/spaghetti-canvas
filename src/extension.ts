import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Define structures for our visualizer graph (same as parser)
interface CodeNode {
  id: string;        // Relative file path (e.g., "src/main.ts")
  name: string;      // Basename of the file (e.g., "main.ts")
  dir: string;       // Directory relative path (e.g., "src")
  size: number;      // File size in bytes
  extension: string; // File extension (e.g., ".ts")
  preview: string[]; // First N lines of file content
}

interface CodeLink {
  source: string;    // Source node ID
  target: string;    // Target node ID
}

interface CodebaseGraph {
  nodes: CodeNode[];
  links: CodeLink[];
}

const DEFAULT_IGNORE_DIRS = [
  'node_modules', '.git', 'dist', 'build', '.svelte-kit', 'target', 'out',
  '.vercel', '.turbo', '.next', '.nuxt', 'coverage', '.nyc_output',
  'worktrees', '__pycache__', '.pytest_cache', 'vendor',
];
const DEFAULT_EXTENSIONS = ['.ts', '.js', '.svelte', '.json', '.html', '.css', '.rs', '.py', '.md'];

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('spaghetti');
  const ignoredDirs = new Set<string>(cfg.get<string[]>('ignoredDirectories') ?? DEFAULT_IGNORE_DIRS);
  const allowedExts = new Set<string>(cfg.get<string[]>('allowedExtensions') ?? DEFAULT_EXTENSIONS);
  const maxPreviewLines = cfg.get<number>('maxPreviewLines') ?? 20;
  return { ignoredDirs, allowedExts, maxPreviewLines };
}

// Use getter for backwards-compat with the static-scan helpers below
const IGNORE_DIRS = new Set(DEFAULT_IGNORE_DIRS);
const ALLOWED_EXTENSIONS = new Set(DEFAULT_EXTENSIONS);

// Recursively walks the directory and collects relative file paths
function scanDirectory(dirPath: string, rootDir: string, filesList: string[] = []): string[] {
  try {
    const items = fs.readdirSync(dirPath);

    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const relativePath = path.relative(rootDir, fullPath);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        if (!IGNORE_DIRS.has(item)) {
          scanDirectory(fullPath, rootDir, filesList);
        }
      } else if (stat.isFile()) {
        const ext = path.extname(item).toLowerCase();
        if (ALLOWED_EXTENSIONS.has(ext)) {
          filesList.push(relativePath);
        }
      }
    }
  } catch (err) {
    console.error('Error scanning folder:', err);
  }
  return filesList;
}

// Regex patterns to capture import statements
const JS_TS_IMPORT_REGEX = /(?:import|export)\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_REGEX = /require\(['"]([^'"]+)['"]\)/g;

function extractImports(filePath: string, content: string): string[] {
  const imports: string[] = [];
  const ext = path.extname(filePath).toLowerCase();

  // JavaScript, TypeScript, Svelte imports
  if (['.js', '.ts', '.svelte'].includes(ext)) {
    let match;
    JS_TS_IMPORT_REGEX.lastIndex = 0;
    REQUIRE_REGEX.lastIndex = 0;

    while ((match = JS_TS_IMPORT_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
    while ((match = REQUIRE_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
  } else if (ext === '.rs') {
    // Rust crate level imports
    const RUST_IMPORT_REGEX = /use\s+crate::([a-zA-Z0-9_:]+)/g;
    let match;
    while ((match = RUST_IMPORT_REGEX.exec(content)) !== null) {
      imports.push(`crate::${match[1]}`);
    }
  }

  return imports;
}

// Resolve imported paths to actual files in the codebase
function resolveImportPath(
  importerRelativePath: string, 
  importString: string, 
  allFiles: Set<string>
): string | null {
  // If it's a Rust crate import
  if (importString.startsWith('crate::')) {
    const cleanPath = importString.substring(7);
    const parts = cleanPath.split('::');

    for (let i = 1; i <= parts.length; i++) {
      const subparts = parts.slice(0, i);
      const possiblePaths = [
        path.join('src', ...subparts) + '.rs',
        path.join('src', ...subparts, 'mod.rs')
      ];

      for (const p of possiblePaths) {
        if (allFiles.has(p)) {
          return p;
        }
      }
    }
  }

  // If it's a relative import (starts with . or ..)
  if (importString.startsWith('.')) {
    const importerDir = path.dirname(importerRelativePath);
    const resolvedPath = path.join(importerDir, importString);

    if (allFiles.has(resolvedPath)) return resolvedPath;

    const possibleExtensions = ['.ts', '.js', '.svelte', '.json'];
    for (const ext of possibleExtensions) {
      const pathWithExt = resolvedPath + ext;
      if (allFiles.has(pathWithExt)) return pathWithExt;
    }

    for (const ext of possibleExtensions) {
      const indexPathWithExt = path.join(resolvedPath, `index${ext}`);
      if (allFiles.has(indexPathWithExt)) return indexPathWithExt;
    }
  }

  return null;
}

function generateGraph(rootDir: string): CodebaseGraph {
  const relativeFilePaths = scanDirectory(rootDir, rootDir);
  const allFilesSet = new Set(relativeFilePaths);

  const nodes: CodeNode[] = [];
  const links: CodeLink[] = [];

  for (const relPath of relativeFilePaths) {
    const fullPath = path.join(rootDir, relPath);
    try {
      const stat = fs.statSync(fullPath);
      const content = fs.readFileSync(fullPath, 'utf-8');

      const preview = content.split('\n').slice(0, 20).map(l => l.slice(0, 80));

      nodes.push({
        id: relPath,
        name: path.basename(relPath),
        dir: path.dirname(relPath) === '.' ? '' : path.dirname(relPath),
        size: stat.size,
        extension: path.extname(relPath).toLowerCase(),
        preview,
      });

      const rawImports = extractImports(relPath, content);
      for (const rawImport of rawImports) {
        const resolved = resolveImportPath(relPath, rawImport, allFilesSet);
        if (resolved) {
          links.push({
            source: relPath,
            target: resolved,
          });
        }
      }
    } catch (e) {
      console.error(`Error reading ${relPath}:`, e);
    }
  }

  return { nodes, links };
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Spaghetti extension is now active!');

  let disposable = vscode.commands.registerCommand('spaghetti.visualize', () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('Please open a folder in VS Code to use Spaghetti visualizer.');
      return;
    }

    // Use the first workspace folder but respect all roots for active-file detection
    const rootPath = workspaceFolders[0].uri.fsPath;
    const allRoots = workspaceFolders.map(f => f.uri.fsPath);

    // Create and show Webview Panel
    const panel = vscode.window.createWebviewPanel(
      'spaghettiVisualizer',
      'Spaghetti Visualizer',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist')
        ]
      }
    );

    // Set Webview HTML content
    panel.webview.html = getWebviewHtml(context, panel.webview);

    // --- Debounced graph refresh on file save ---
    let refreshDebounce: ReturnType<typeof setTimeout> | undefined;
    const refreshGraph = () => {
      if (refreshDebounce) clearTimeout(refreshDebounce);
      refreshDebounce = setTimeout(() => {
        try {
          const graph = generateGraph(rootPath);
          panel.webview.postMessage({ command: 'refreshGraph', data: graph });
        } catch (err: any) {
          console.error('Spaghetti: graph refresh failed:', err.message);
        }
      }, 1500);
    };

    // Watch file saves inside the workspace
    const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!panel.visible) return;
      const rel = path.relative(rootPath, doc.uri.fsPath);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        refreshGraph();
      }
    });
    context.subscriptions.push(saveListener);

    // --- Active file tracking (works across all workspace roots) ---
    const sendActiveFile = (editor: vscode.TextEditor | undefined) => {
      if (!editor || !panel.visible) return;
      const filePath = editor.document.uri.fsPath;
      // Find which root this file belongs to
      for (const root of allRoots) {
        const rel = path.relative(root, filePath);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          panel.webview.postMessage({ command: 'activeFile', path: rel });
          return;
        }
      }
    };

    // Fire immediately for whichever file is already open
    sendActiveFile(vscode.window.activeTextEditor);

    const editorListener = vscode.window.onDidChangeActiveTextEditor(sendActiveFile);
    context.subscriptions.push(editorListener);

    // Clean up timer when panel closes
    panel.onDidDispose(() => {
      if (refreshDebounce) clearTimeout(refreshDebounce);
    });

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'ready': {
            // Webview requested graph data — scan using current settings
            try {
              const graph = generateGraph(rootPath);
              panel.webview.postMessage({ command: 'setGraphData', data: graph });
              // Tell webview which settings are active
              const { maxPreviewLines } = getConfig();
              panel.webview.postMessage({ command: 'settings', maxPreviewLines });
              // Also tell the webview which file is currently active
              sendActiveFile(vscode.window.activeTextEditor);
            } catch (err: any) {
              vscode.window.showErrorMessage(`Failed to scan codebase: ${err.message}`);
            }
            break;
          }
          case 'openFile': {
            // Open clicked node in VS Code editor
            const filePath = path.join(rootPath, message.path);
            const fileUri = vscode.Uri.file(filePath);
            try {
              const doc = await vscode.workspace.openTextDocument(fileUri);
              await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
            } catch (err: any) {
              vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
            }
            break;
          }
        }
      },
      undefined,
      context.subscriptions
    );
  });

  context.subscriptions.push(disposable);
}

function getWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  // Load built index.html from dist/web/index.html
  const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'web', 'index.html');
  
  if (!fs.existsSync(htmlPath.fsPath)) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"></head>
      <body style="padding: 20px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background);">
        <h2>Spaghetti visualizer assets not found.</h2>
        <p>Please run <code>bun run build</code> in the extension folder to build the frontend assets first.</p>
      </body>
      </html>
    `;
  }

  let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');

  // Convert absolute Vite build paths to Webview URIs.
  // Replace references like src="/assets/index-xxx.js" with the corresponding Webview URI.
  htmlContent = htmlContent.replace(/(src|href)="\/assets\/([^"]+)"/g, (_match, attr, fileName) => {
    const assetUri = vscode.Uri.joinPath(context.extensionUri, 'dist', 'web', 'assets', fileName);
    const webviewUri = webview.asWebviewUri(assetUri);
    return `${attr}="${webviewUri.toString()}"`;
  });

  // Inject VS Code theme bridge: maps our CSS custom properties to VS Code variables,
  // and marks <body> so the app can apply vscode-specific overrides.
  const themeBridge = `
  <style id="vscode-theme-bridge">
    :root {
      --app-canvas-bg:     var(--vscode-editor-background, #0b0f19);
      --app-surface:       var(--vscode-sideBar-background, #0d1324);
      --app-border:        var(--vscode-panel-border, #1f2937);
      --app-text-primary:  var(--vscode-editor-foreground, #f3f4f6);
      --app-text-muted:    var(--vscode-descriptionForeground, #94a3b8);
      --app-accent:        var(--vscode-focusBorder, #6366f1);
      --app-input-bg:      var(--vscode-input-background, #111827);
    }
  </style>
  <script>document.body.setAttribute('data-vscode','true');</script>`;

  htmlContent = htmlContent.replace('</head>', themeBridge + '\n</head>');

  return htmlContent;
}

export function deactivate() {}






