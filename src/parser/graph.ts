import * as fs from 'fs';
import * as path from 'path';

// Define structures for our visualizer graph
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

// Ignore list for scanning
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.svelte-kit', 'target', 'out',
  '.vercel', '.turbo', '.next', '.nuxt', 'coverage', '.nyc_output',
  'worktrees', '__pycache__', '.pytest_cache', 'vendor',
]);
const ALLOWED_EXTENSIONS = new Set(['.ts', '.js', '.svelte', '.json', '.html', '.css', '.rs', '.py', '.md']);

// The scanner collects all files first
function scanDirectory(dirPath: string, rootDir: string, filesList: string[] = []): string[] {
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

  return filesList;
}

// Regex patterns to capture import statements from various languages
const JS_TS_IMPORT_REGEX = /(?:import|export)\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_REGEX = /require\(['"]([^'"]+)['"]\)/g;

function extractImports(filePath: string, content: string): string[] {
  const imports: string[] = [];
  const ext = path.extname(filePath).toLowerCase();

  // JavaScript, TypeScript, Svelte imports
  if (['.js', '.ts', '.svelte'].includes(ext)) {
    let match;
    // Reset regex indices
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
    const cleanPath = importString.substring(7); // remove 'crate::'
    const parts = cleanPath.split('::');

    // Rust maps crate to "src"
    // Try incrementally deeper parts to match a file.
    // e.g. use crate::resolution::mod::Resolver;
    // parts = ['resolution', 'mod', 'Resolver']
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

    // Try matches:
    // 1. Exact match (e.g. `./App.svelte`)
    if (allFiles.has(resolvedPath)) return resolvedPath;

    // 2. Extensionless resolution (e.g. `./utils` -> `./utils.ts`, `./utils.js`)
    const possibleExtensions = ['.ts', '.js', '.svelte', '.json'];
    for (const ext of possibleExtensions) {
      const pathWithExt = resolvedPath + ext;
      if (allFiles.has(pathWithExt)) return pathWithExt;
    }

    // 3. Index resolution (e.g. `./parser` -> `./parser/index.ts`, `./parser/index.js`)
    for (const ext of possibleExtensions) {
      const indexPathWithExt = path.join(resolvedPath, `index${ext}`);
      if (allFiles.has(indexPathWithExt)) return indexPathWithExt;
    }
  }

  return null;
}

function generateGraph(targetDir: string): CodebaseGraph {
  const rootDir = path.resolve(targetDir);
  console.log(`Scanning codebase at: ${rootDir}`);

  const relativeFilePaths = scanDirectory(rootDir, rootDir);
  const allFilesSet = new Set(relativeFilePaths);

  const nodes: CodeNode[] = [];
  const links: CodeLink[] = [];

  for (const relPath of relativeFilePaths) {
    const fullPath = path.join(rootDir, relPath);
    const stat = fs.statSync(fullPath);
    const content = fs.readFileSync(fullPath, 'utf-8');

    const preview = content.split('\n').slice(0, 20).map(l => l.slice(0, 80));

    // Create node
    nodes.push({
      id: relPath,
      name: path.basename(relPath),
      dir: path.dirname(relPath) === '.' ? '' : path.dirname(relPath),
      size: stat.size,
      extension: path.extname(relPath).toLowerCase(),
      preview,
    });

    // Find links
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
  }

  return { nodes, links };
}

// CLI Execution Support
const targetDir = process.argv[2] || '.';
const outputFile = process.argv[3] || 'public/codebase.json';

try {
  const graph = generateGraph(targetDir);

  // Ensure output directory exists
  const outDir = path.dirname(outputFile);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(outputFile, JSON.stringify(graph, null, 2), 'utf-8');
  console.log(`Successfully generated graph data!`);
  console.log(`Nodes (Files): ${graph.nodes.length}`);
  console.log(`Links (Imports): ${graph.links.length}`);
  console.log(`Saved result to: ${outputFile}`);
} catch (error) {
  console.error(`Error generating codebase graph:`, error);
  process.exit(1);
}
