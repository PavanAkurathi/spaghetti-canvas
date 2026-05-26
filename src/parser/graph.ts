import * as fs from 'fs';
import * as path from 'path';

interface CodeNode {
  id: string;
  name: string;
  dir: string;
  size: number;
  extension: string;
  preview: string[];
}

interface CodeLink {
  source: string;
  target: string;
}

interface CodebaseGraph {
  nodes: CodeNode[];
  links: CodeLink[];
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.svelte-kit', 'target', 'out',
  '.vercel', '.turbo', '.next', '.nuxt', 'coverage', '.nyc_output',
  'worktrees', '__pycache__', '.pytest_cache', 'vendor',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.svelte',
  '.json', '.html', '.css',
  '.rs', '.py', '.md',
  '.c', '.h', '.cpp', '.hpp',
  '.java',
]);

function scanDirectory(dirPath: string, rootDir: string, filesList: string[] = []): string[] {
  const items = fs.readdirSync(dirPath);
  for (const item of items) {
    const fullPath = path.join(dirPath, item);
    const relativePath = path.relative(rootDir, fullPath);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (!IGNORE_DIRS.has(item)) scanDirectory(fullPath, rootDir, filesList);
    } else if (stat.isFile()) {
      if (ALLOWED_EXTENSIONS.has(path.extname(item).toLowerCase())) filesList.push(relativePath);
    }
  }
  return filesList;
}

const JS_TS_IMPORT_REGEX = /(?:import|export)\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_REGEX = /require\(['"]([^'"]+)['"]\)/g;
const RUST_IMPORT_REGEX = /use\s+crate::([a-zA-Z0-9_:]+)/g;
const C_INCLUDE_REGEX = /#include\s+"([^"]+)"/g;
const JAVA_IMPORT_REGEX = /^import\s+(?:static\s+)?([a-zA-Z_$][\w$]*(?:\.[\w$]+)+)(?:\.\*)?;/gm;

function extractImports(filePath: string, content: string): string[] {
  const imports: string[] = [];
  const ext = path.extname(filePath).toLowerCase();

  if (['.js', '.ts', '.tsx', '.jsx', '.svelte'].includes(ext)) {
    let match;
    JS_TS_IMPORT_REGEX.lastIndex = 0;
    REQUIRE_REGEX.lastIndex = 0;
    while ((match = JS_TS_IMPORT_REGEX.exec(content)) !== null) imports.push(match[1]);
    while ((match = REQUIRE_REGEX.exec(content)) !== null) imports.push(match[1]);
  } else if (ext === '.rs') {
    let match;
    RUST_IMPORT_REGEX.lastIndex = 0;
    while ((match = RUST_IMPORT_REGEX.exec(content)) !== null) imports.push(`crate::${match[1]}`);
  } else if (['.c', '.h', '.cpp', '.hpp'].includes(ext)) {
    C_INCLUDE_REGEX.lastIndex = 0;
    let match;
    while ((match = C_INCLUDE_REGEX.exec(content)) !== null) {
      const inc = match[1];
      // Normalise bare names like "utils.h" to "./utils.h" so relative resolution handles them
      imports.push(inc.startsWith('.') ? inc : `./${inc}`);
    }
  } else if (ext === '.java') {
    JAVA_IMPORT_REGEX.lastIndex = 0;
    let match;
    // Prefix with "java:" so resolveImportPath knows to convert dots→slashes
    while ((match = JAVA_IMPORT_REGEX.exec(content)) !== null) imports.push(`java:${match[1]}`);
  }

  return imports;
}

function readAliases(rootDir: string): Record<string, string[]> {
  // Seed with the universal TS/Vite convention; tsconfig paths overwrite if present
  const aliases: Record<string, string[]> = { '@/*': ['src/*'] };
  try {
    const tsconfigPath = path.join(rootDir, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      const raw = fs.readFileSync(tsconfigPath, 'utf-8');
      // tsconfig allows JS-style comments — strip them before parsing
      const cleaned = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const tsconfig = JSON.parse(cleaned);
      const tsPaths = tsconfig?.compilerOptions?.paths;
      if (tsPaths && typeof tsPaths === 'object') Object.assign(aliases, tsPaths);
    }
  } catch { /* silently fall back to defaults */ }
  return aliases;
}

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.svelte', '.json'];

function resolveImportPath(
  importerRelativePath: string,
  importString: string,
  allFiles: Set<string>,
  aliases: Record<string, string[]> = {}
): string | null {
  // Java: convert dotted package name to file path and try common Java source roots
  if (importString.startsWith('java:')) {
    const packagePath = importString.slice(5).replace(/\./g, '/') + '.java';
    for (const srcRoot of ['src/main/java', 'src', '']) {
      const candidate = srcRoot ? path.join(srcRoot, packagePath) : packagePath;
      if (allFiles.has(candidate)) return candidate;
    }
    return null;
  }

  // Rust crate-relative import
  if (importString.startsWith('crate::')) {
    const parts = importString.substring(7).split('::');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i);
      for (const p of [path.join('src', ...sub) + '.rs', path.join('src', ...sub, 'mod.rs')]) {
        if (allFiles.has(p)) return p;
      }
    }
    return null;
  }

  // Relative import: handles ./foo, ../bar, and C local includes normalised to ./
  if (importString.startsWith('.')) {
    const resolved = path.join(path.dirname(importerRelativePath), importString);
    if (allFiles.has(resolved)) return resolved;
    for (const ext of RESOLVE_EXTENSIONS) {
      if (allFiles.has(resolved + ext)) return resolved + ext;
    }
    for (const ext of RESOLVE_EXTENSIONS) {
      const idx = path.join(resolved, `index${ext}`);
      if (allFiles.has(idx)) return idx;
    }
    return null;
  }

  // Alias resolution: tsconfig paths, @/, ~/, etc.
  for (const [aliasPattern, targets] of Object.entries(aliases)) {
    const prefix = aliasPattern.endsWith('/*') ? aliasPattern.slice(0, -1) : aliasPattern;
    if (!importString.startsWith(prefix)) continue;
    const rest = importString.slice(prefix.length);
    for (const target of targets) {
      const targetBase = target.endsWith('/*') ? target.slice(0, -1) : target;
      const candidate = path.join(targetBase, rest);
      if (allFiles.has(candidate)) return candidate;
      for (const ext of RESOLVE_EXTENSIONS) {
        if (allFiles.has(candidate + ext)) return candidate + ext;
      }
      for (const ext of RESOLVE_EXTENSIONS) {
        const idx = path.join(candidate, `index${ext}`);
        if (allFiles.has(idx)) return idx;
      }
    }
  }

  return null;
}

function generateGraph(targetDir: string): CodebaseGraph {
  const rootDir = path.resolve(targetDir);
  console.log(`Scanning codebase at: ${rootDir}`);

  const relativeFilePaths = scanDirectory(rootDir, rootDir);
  const allFilesSet = new Set(relativeFilePaths);
  const aliases = readAliases(rootDir);

  const nodes: CodeNode[] = [];
  const links: CodeLink[] = [];

  for (const relPath of relativeFilePaths) {
    const fullPath = path.join(rootDir, relPath);
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
      const resolved = resolveImportPath(relPath, rawImport, allFilesSet, aliases);
      if (resolved) links.push({ source: relPath, target: resolved });
    }
  }

  return { nodes, links };
}

// CLI Execution Support
const targetDir = process.argv[2] || '.';
const outputFile = process.argv[3] || 'public/codebase.json';

try {
  const graph = generateGraph(targetDir);
  const outDir = path.dirname(outputFile);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(graph, null, 2), 'utf-8');
  console.log(`Successfully generated graph data!`);
  console.log(`Nodes (Files): ${graph.nodes.length}`);
  console.log(`Links (Imports): ${graph.links.length}`);
  console.log(`Saved result to: ${outputFile}`);
} catch (error) {
  console.error(`Error generating codebase graph:`, error);
  process.exit(1);
}
