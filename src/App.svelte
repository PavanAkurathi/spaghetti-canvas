<script lang="ts">
  import { onMount } from 'svelte';
  import hljs from 'highlight.js/lib/core';
  import typescript from 'highlight.js/lib/languages/typescript';
  import javascript from 'highlight.js/lib/languages/javascript';
  import json from 'highlight.js/lib/languages/json';
  import css from 'highlight.js/lib/languages/css';
  import xml from 'highlight.js/lib/languages/xml';
  import rust from 'highlight.js/lib/languages/rust';
  import python from 'highlight.js/lib/languages/python';
  import markdown from 'highlight.js/lib/languages/markdown';

  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('json', json);
  hljs.registerLanguage('css', css);
  hljs.registerLanguage('html', xml);
  hljs.registerLanguage('svelte', xml);
  hljs.registerLanguage('rust', rust);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('markdown', markdown);

  const EXT_TO_LANG: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.svelte': 'svelte',
    '.json': 'json',
    '.css': 'css',
    '.html': 'html',
    '.rs': 'rust',
    '.py': 'python',
    '.md': 'markdown',
  };

  // --- Types ---
  interface CodeNode {
    id: string;
    name: string;
    dir: string;
    size: number;
    extension: string;
    preview?: string[];
    highlightedPreview?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }

  interface CodeLink {
    source: string;
    target: string;
  }

  interface CodebaseGraph {
    nodes: CodeNode[];
    links: CodeLink[];
  }

  interface FolderLayout {
    path: string;
    name: string;
    depth: number;
    x: number;
    y: number;
    width: number;
    height: number;
    files: CodeNode[];
  }

  interface VSCodeApi {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
  }

  // --- Git Branch Types ---
  interface ChangedFile {
    path: string;
    status: 'A' | 'M' | 'D' | 'R';
    extension: string;
  }

  interface BranchNode {
    name: string;
    shortHash: string;
    message: string;
    timestamp: number;
    relativeTime: string;
    parentBranch: string | null;
    changedFiles: ChangedFile[];
    type: 'main' | 'feat' | 'bugfix' | 'refactor' | 'chore' | 'other';
    // layout
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }

  interface GitGraph {
    branches: BranchNode[];
    defaultBranch: string;
  }

  // --- Runes (Svelte 5 State) ---
  let graphData = $state<CodebaseGraph>({ nodes: [], links: [] });
  let folders = $state<FolderLayout[]>([]);
  
  // Transform / Zoom / Pan state
  let panX = $state(50);
  let panY = $state(50);
  let scale = $state(0.5);
  let isDragging = $state(false);
  let startX = $state(0);
  let startY = $state(0);

  // Interaction State
  let searchQuery = $state('');
  let hoveredNodeId = $state<string | null>(null);
  let selectedNodeId = $state<string | null>(null);
  let activeExtensionFilter = $state<string>('all');

  // Loading / Error States
  let isLoading = $state(true);
  let loadError = $state<string | null>(null);

  // View mode
  let mode = $state<'files' | 'branches'>('files');
  let gitGraph = $state<GitGraph | null>(null);
  let branchNodes = $state<BranchNode[]>([]);
  let hoveredBranchName = $state<string | null>(null);

  // VS Code active file tracking
  let activeFileId = $state<string | null>(null);

  // Branch canvas interaction
  let selectedBranchName = $state<string | null>(null);
  const selectedBranch = $derived(branchNodes.find(b => b.name === selectedBranchName) ?? null);

  // Branch search
  let branchSearchQuery = $state('');
  const branchMatchNames = $derived(() => {
    if (!branchSearchQuery) return null;
    const q = branchSearchQuery.toLowerCase();
    return new Set(branchNodes.filter(b =>
      b.name.toLowerCase().includes(q) || b.message.toLowerCase().includes(q)
    ).map(b => b.name));
  });

  // VS Code API integration
  let vscode = $state<VSCodeApi | null>(null);
  try {
    // @ts-ignore
    vscode = acquireVsCodeApi();
  } catch (e) {
    // Running in standalone browser
  }

  // --- Computed States (Svelte 5 $derived) ---
  const selectedNode = $derived(
    graphData.nodes.find(n => n.id === selectedNodeId) || null
  );

  const incomingLinks = $derived(
    hoveredNodeId ? graphData.links.filter(l => l.target === hoveredNodeId) : []
  );

  const outgoingLinks = $derived(
    hoveredNodeId ? graphData.links.filter(l => l.source === hoveredNodeId) : []
  );

  // Set of connected node IDs to highlight
  const highlightedNodeIds = $derived(() => {
    if (!hoveredNodeId) return new Set<string>();
    const ids = new Set<string>([hoveredNodeId]);
    for (const link of incomingLinks) ids.add(link.source);
    for (const link of outgoingLinks) ids.add(link.target);
    return ids;
  });

  // Filtered nodes for search visibility overlay
  const searchMatchIds = $derived(() => {
    if (!searchQuery) return null;
    const query = searchQuery.toLowerCase();
    return new Set(
      graphData.nodes
        .filter(n => n.name.toLowerCase().includes(query) || n.id.toLowerCase().includes(query))
        .map(n => n.id)
    );
  });

  // Unique extensions for filter tabs
  const availableExtensions = $derived([
    'all',
    ...Array.from(new Set(graphData.nodes.map(n => n.extension))).sort()
  ]);

  // Outgoing imports for the selected node
  const exportsList = $derived(
    selectedNodeId ? graphData.links.filter(l => l.source === selectedNodeId) : []
  );

  // Incoming importers for the selected node
  const importersList = $derived(
    selectedNodeId ? graphData.links.filter(l => l.target === selectedNodeId) : []
  );

  // Load data and run layout
  onMount(() => {
    const messageListener = (event: MessageEvent) => {
      const message = event.data;
      if (message.command === 'setGraphData') {
        layoutGraph(message.data, true);
        isLoading = false;
      } else if (message.command === 'refreshGraph') {
        // Re-layout without resetting pan/zoom (file was saved)
        layoutGraph(message.data, false);
      } else if (message.command === 'activeFile') {
        activeFileId = message.path;
        // Pan canvas to show the newly active file
        const node = graphData.nodes.find(n => n.id === message.path);
        if (node) panToNode(node);
      }
    };

    window.addEventListener('message', messageListener);

    // Ask VS Code for data if loaded as an extension
    if (vscode) {
      vscode.postMessage({ command: 'ready' });
    } else {
      // Browser fallback: load codebase.json and optionally git-graph.json
      Promise.all([
        fetch('/codebase.json').then(r => { if (!r.ok) throw new Error('Failed to load codebase.json'); return r.json(); }),
        fetch('/git-graph.json').then(r => r.ok ? r.json() : null).catch(() => null),
      ]).then(([codeData, gitData]) => {
        layoutGraph(codeData);
        if (gitData) {
          gitGraph = gitData;
          layoutBranches(gitData);
        }
        isLoading = false;
      }).catch(err => {
        console.error(err);
        loadError = err.message;
        isLoading = false;
      });
    }

    return () => {
      window.removeEventListener('message', messageListener);
    };
  });

  // Pan the canvas to center a specific node (used for active file tracking)
  function panToNode(node: CodeNode) {
    if (node.x === undefined || node.y === undefined) return;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight - 64;
    const nodeW = node.width ?? 280;
    const nodeH = node.height ?? 178;
    panX = viewportW / 2 - (node.x + nodeW / 2) * scale;
    panY = viewportH / 2 - (node.y + nodeH / 2) * scale;
  }

  // Jump to the first search match (called on Enter in the search box)
  function jumpToFirstMatch() {
    const ids = searchMatchIds();
    if (!ids || ids.size === 0) return;
    const firstId = [...ids][0];
    const node = graphData.nodes.find(n => n.id === firstId);
    if (node) {
      selectedNodeId = firstId;
      // Zoom to a comfortable reading level then center
      scale = Math.max(scale, 0.5);
      panToNode(node);
    }
  }

  function panToBranch(branch: BranchNode) {
    if (branch.x === undefined || branch.y === undefined) return;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight - 64;
    const bW = branch.width ?? 300;
    const bH = branch.height ?? 120;
    panX = viewportW / 2 - (branch.x + bW / 2) * scale;
    panY = viewportH / 2 - (branch.y + bH / 2) * scale;
  }

  // --- Layout Algorithm ---
  // Groups folders by their depth-2 ancestor ("module"), then stacks within
  // each module band using sub-columns to prevent extreme canvas dimensions.
  function layoutGraph(data: CodebaseGraph, initialLoad = true) {
    const isLarge = data.nodes.length > 80;
    const fileWidth = 280;
    const fileHeight = isLarge ? 90 : 190;
    const cardGap = isLarge ? 8 : 12;
    const folderPadding = 20;
    const folderHeaderHeight = 52;
    const folderSpacingY = isLarge ? 20 : 48;
    const columnWidth = fileWidth + folderPadding * 2; // 320
    const subColGapX = 20;
    const groupGapX = isLarge ? 60 : 180;
    const maxSubColHeight = isLarge ? 3200 : 2800;

    // Group files by dir
    const filesByDir: Record<string, CodeNode[]> = {};
    for (const node of data.nodes) {
      if (!filesByDir[node.dir]) filesByDir[node.dir] = [];
      filesByDir[node.dir].push(node);
    }

    const folderPaths = Object.keys(filesByDir).sort();

    // Assign each folder to a column group by its depth-2 ancestor
    const getGroupKey = (dirPath: string): string => {
      if (dirPath === '') return '';
      const parts = dirPath.split('/');
      return parts.length <= 2 ? dirPath : parts.slice(0, 2).join('/');
    };

    // Collect and sort groups: root first, then by depth then alphabetically
    const groupSet = new Set<string>(folderPaths.map(getGroupKey));
    const sortedGroups = Array.from(groupSet).sort((a, b) => {
      if (a === '') return -1;
      if (b === '') return 1;
      const aD = a.split('/').length;
      const bD = b.split('/').length;
      return aD !== bD ? aD - bD : a.localeCompare(b);
    });

    const layouts: FolderLayout[] = [];
    let currentX = 50;

    for (const groupKey of sortedGroups) {
      const groupFolderPaths = folderPaths.filter(p => getGroupKey(p) === groupKey).sort();
      if (groupFolderPaths.length === 0) continue;

      // Sub-columns within this module group
      const subCols: Array<{ x: number; y: number }> = [{ x: currentX, y: 80 }];

      for (const dirPath of groupFolderPaths) {
        const files = filesByDir[dirPath];
        const height = folderHeaderHeight + files.length * fileHeight + folderPadding;

        let col = subCols[subCols.length - 1];
        if (col.y + height > maxSubColHeight) {
          col = { x: col.x + columnWidth + subColGapX, y: 80 };
          subCols.push(col);
        }

        const x = col.x;
        const y = col.y;
        col.y += height + folderSpacingY;

        files.forEach((file, i) => {
          file.x = x + folderPadding;
          file.y = y + folderHeaderHeight + i * fileHeight;
          file.width = fileWidth;
          file.height = fileHeight - cardGap;
        });

        layouts.push({
          path: dirPath,
          name: dirPath === '' ? 'root' : dirPath,
          depth: dirPath === '' ? 0 : dirPath.split('/').length,
          x, y, width: columnWidth, height,
          files
        });
      }

      // Advance past all sub-columns of this group
      currentX = Math.max(...subCols.map(c => c.x)) + columnWidth + groupGapX;
    }

    // Compute syntax-highlighted HTML for each node's preview
    for (const node of data.nodes) {
      if (node.preview && node.preview.length > 0) {
        const code = node.preview.join('\n');
        const lang = EXT_TO_LANG[node.extension];
        try {
          node.highlightedPreview = lang
            ? hljs.highlight(code, { language: lang }).value
            : hljs.highlightAuto(code).value;
        } catch {
          node.highlightedPreview = code
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
      }
    }

    graphData = data;
    folders = layouts;
    if (initialLoad) fitView(layouts);
  }

  function fitView(layouts: FolderLayout[]) {
    if (layouts.length === 0) return;

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight - 64;
    const padding = 60;

    const minX = Math.min(...layouts.map(f => f.x));
    const minY = Math.min(...layouts.map(f => f.y));
    const maxX = Math.max(...layouts.map(f => f.x + f.width));
    const maxY = Math.max(...layouts.map(f => f.y + f.height));

    const contentW = maxX - minX;
    const contentH = maxY - minY;

    const scaleX = (viewportW - padding * 2) / contentW;
    const scaleY = (viewportH - padding * 2) / contentH;
    const newScale = Math.min(scaleX, scaleY, 1.0);

    scale = newScale;
    panX = padding - minX * newScale + (viewportW - padding * 2 - contentW * newScale) / 2;
    panY = padding - minY * newScale + (viewportH - padding * 2 - contentH * newScale) / 2;
  }

  // --- Zoom & Pan Event Handlers ---
  function handleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.interactive-node') || target.closest('.sidebar')) return;

    isDragging = true;
    startX = e.clientX - panX;
    startY = e.clientY - panY;
  }

  function handleMouseMove(e: MouseEvent) {
    if (!isDragging) return;
    panX = e.clientX - startX;
    panY = e.clientY - startY;
  }

  function handleMouseUp() {
    isDragging = false;
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const zoomFactor = 1.1;
    const nextScale = e.deltaY < 0 ? scale * zoomFactor : scale / zoomFactor;

    if (nextScale < 0.02 || nextScale > 4) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    panX = mouseX - (mouseX - panX) * (nextScale / scale);
    panY = mouseY - (mouseY - panY) * (nextScale / scale);
    scale = nextScale;
  }

  // --- Node Accent Colors ---
  function getExtColor(ext: string): string {
    switch (ext) {
      case '.ts': return '#3178c6';       // TypeScript Blue
      case '.svelte': return '#ff3e00';   // Svelte Red-Orange
      case '.js': return '#f7df1e';       // JS Yellow
      case '.json': return '#0fa57c';     // JSON Green
      case '.rs': return '#de2c2c';       // Rust Red
      case '.html': return '#e34c26';     // HTML Red
      case '.css': return '#563d7c';      // CSS Purple
      case '.md': return '#0070f3';       // Markdown Blue
      default: return '#8b5cf6';          // Default Violet
    }
  }

  // Format file sizes
  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // Bezier curve path calculation between nodes
  function getLinkPath(source: CodeNode, target: CodeNode): string {
    if (source.x === undefined || source.y === undefined || target.x === undefined || target.y === undefined) {
      return '';
    }

    const sw = source.width || 280;
    const sh = source.height || 178;
    const th = target.height || 178;

    const sy = source.y + sh / 2;
    const ty = target.y + th / 2;

    // Same column: draw a loop out to the right side instead of crossing backward
    if (Math.abs(source.x - target.x) < 20) {
      const sx = source.x + sw;
      const tx = target.x + sw;
      const bulge = sw * 0.7;
      return `M ${sx} ${sy} C ${sx + bulge} ${sy}, ${tx + bulge} ${ty}, ${tx} ${ty}`;
    }

    const sx = source.x + sw;
    const tx = target.x;
    const dx = Math.abs(tx - sx) * 0.5;
    return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  }

  // --- Branch Canvas Functions ---
  function layoutBranches(graph: GitGraph) {
    const CARD_W = 300;
    const FILE_ROW_H = 18;
    const HEADER_H = 44;
    const COMMIT_H = 60;
    const PAD = 8;
    const COL_GAP = 120;
    const ROW_GAP = 32;

    function cardHeight(branch: BranchNode): number {
      return Math.max(120, Math.min(HEADER_H + COMMIT_H + PAD + branch.changedFiles.length * FILE_ROW_H + PAD, 340));
    }

    const byName: Record<string, BranchNode> = {};
    for (const b of graph.branches) byName[b.name] = b;

    const childrenOf: Record<string, string[]> = {};
    const roots: string[] = [];
    for (const b of graph.branches) {
      if (b.parentBranch && byName[b.parentBranch]) {
        if (!childrenOf[b.parentBranch]) childrenOf[b.parentBranch] = [];
        childrenOf[b.parentBranch].push(b.name);
      } else {
        roots.push(b.name);
      }
    }

    const depthOf: Record<string, number> = {};
    const bfsQueue = [...roots];
    for (const r of roots) depthOf[r] = 0;
    while (bfsQueue.length > 0) {
      const name = bfsQueue.shift()!;
      const d = depthOf[name];
      for (const child of (childrenOf[name] || [])) {
        depthOf[child] = d + 1;
        bfsQueue.push(child);
      }
    }

    const byDepth: Record<number, string[]> = {};
    for (const b of graph.branches) {
      const d = depthOf[b.name] ?? 0;
      if (!byDepth[d]) byDepth[d] = [];
      byDepth[d].push(b.name);
    }

    let currentX = 60;
    for (const depth of Object.keys(byDepth).map(Number).sort()) {
      let currentY = 60;
      for (const name of byDepth[depth]) {
        const branch = byName[name];
        const h = cardHeight(branch);
        branch.x = currentX;
        branch.y = currentY;
        branch.width = CARD_W;
        branch.height = h;
        currentY += h + ROW_GAP;
      }
      currentX += CARD_W + COL_GAP;
    }

    branchNodes = [...graph.branches];
    fitBranchView();
  }

  function fitBranchView() {
    const laid = branchNodes.filter(b => b.x !== undefined);
    if (laid.length === 0) return;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight - 64;
    const padding = 60;
    const minX = Math.min(...laid.map(b => b.x!));
    const minY = Math.min(...laid.map(b => b.y!));
    const maxX = Math.max(...laid.map(b => b.x! + (b.width ?? 300)));
    const maxY = Math.max(...laid.map(b => b.y! + (b.height ?? 120)));
    const contentW = maxX - minX;
    const contentH = maxY - minY;
    const newScale = Math.min(
      (viewportW - padding * 2) / contentW,
      (viewportH - padding * 2) / contentH,
      1.2
    );
    scale = newScale;
    panX = padding - minX * newScale + (viewportW - padding * 2 - contentW * newScale) / 2;
    panY = padding - minY * newScale + (viewportH - padding * 2 - contentH * newScale) / 2;
  }

  function getBranchColor(type: BranchNode['type']): string {
    switch (type) {
      case 'main':     return '#10b981';
      case 'feat':     return '#6366f1';
      case 'bugfix':   return '#ef4444';
      case 'refactor': return '#f59e0b';
      case 'chore':    return '#8b5cf6';
      default:         return '#64748b';
    }
  }

  function getBranchLinkPath(parent: BranchNode, child: BranchNode): string {
    if (parent.x === undefined || child.x === undefined) return '';
    const pw = parent.width ?? 300;
    const x1 = parent.x + pw;
    const y1 = parent.y! + (parent.height ?? 120) / 2;
    const x2 = child.x!;
    const y2 = child.y! + (child.height ?? 120) / 2;
    const dx = (x2 - x1) * 0.5;
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  function truncate(str: string, max: number): string {
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }

  function fileStatusIcon(status: ChangedFile['status']): string {
    return status === 'A' ? '+' : status === 'D' ? '−' : status === 'R' ? '→' : '~';
  }

  function fileStatusColor(status: ChangedFile['status']): string {
    return status === 'A' ? '#10b981' : status === 'D' ? '#ef4444' : status === 'R' ? '#6366f1' : '#f59e0b';
  }
</script>

<!-- Window Level Events for Pan Dragging -->
<svelte:window onmouseup={handleMouseUp} onmousemove={handleMouseMove} />

<main class="spaghetti-app">
  {#if isLoading}
    <div class="loading-overlay">
      <div class="spinner"></div>
      <p>Scanning directory & building dependency graph...</p>
    </div>
  {:else if loadError}
    <div class="error-overlay">
      <span class="error-icon">⚠️</span>
      <p>Error loading codebase: {loadError}</p>
      <p class="error-help">Check that your workspace contains valid source code files.</p>
    </div>
  {:else}
    <!-- Top bar UI -->
    <header class="top-bar">
      <div class="logo">
        <span class="emoji">🍝</span>
        <span class="title">spaghetti</span>
        <span class="subtitle">codebase visualizer</span>
      </div>

      {#if gitGraph}
        <div class="mode-toggle">
          <button class="mode-btn" class:active={mode === 'files'} onclick={() => { mode = 'files'; fitView(folders); }}>
            Files
          </button>
          <button class="mode-btn" class:active={mode === 'branches'} onclick={() => { mode = 'branches'; fitBranchView(); }}>
            Branches
            <span class="branch-count">{gitGraph.branches.length}</span>
          </button>
        </div>
      {/if}

      {#if mode === 'branches'}
        <div class="controls">
          <div class="search-box">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="search-icon">
              <path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clip-rule="evenodd" />
            </svg>
            <input
              type="text"
              placeholder="Search branches…"
              bind:value={branchSearchQuery}
            />
            {#if branchSearchQuery}
              <button class="clear-btn" onclick={() => branchSearchQuery = ''}>&times;</button>
            {/if}
          </div>
        </div>
      {/if}

      {#if mode === 'files'}
      <div class="controls">
        <!-- Search Input -->
        <div class="search-box">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="search-icon">
            <path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clip-rule="evenodd" />
          </svg>
          <input
            type="text"
            placeholder="Search files… (Enter to jump)"
            bind:value={searchQuery}
            onkeydown={(e) => e.key === 'Enter' && jumpToFirstMatch()}
          />
          {#if searchQuery}
            <button class="clear-btn" onclick={() => searchQuery = ''}>&times;</button>
          {/if}
        </div>

        <!-- Filter Extension Tabs -->
        <div class="filter-tabs">
          {#each availableExtensions as ext}
            <button
              class="tab-btn"
              class:active={activeExtensionFilter === ext}
              onclick={() => activeExtensionFilter = ext}
            >
              {ext === 'all' ? 'All Files' : ext}
            </button>
          {/each}
        </div>
      </div>
      {/if}

      <!-- Zoom HUD Info -->
      <div class="zoom-hud">
        Zoom: {Math.round(scale * 100)}%
        <button class="hud-btn" onclick={() => mode === 'files' ? fitView(folders) : fitBranchView()}>Reset View</button>
      </div>
    </header>

    <!-- Interactive Visualizer Surface -->
    <section 
      class="canvas-container" 
      onmousedown={handleMouseDown}
      onwheel={handleWheel}
      style="cursor: {isDragging ? 'grabbing' : 'grab'}"
    >
      <svg 
        width="100%" 
        height="100%" 
        class="canvas-svg"
      >
        <!-- Grid Pattern Background -->
        <defs>
          <pattern id="grid-pattern" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(30, 41, 59, 0.5)" stroke-width="1" />
          </pattern>
        </defs>
        
        <!-- Apply zoom/pan transformation -->
        <g transform="translate({panX}, {panY}) scale({scale})">
          <!-- Render grid background inside view scope -->
          <rect 
            x="-5000" 
            y="-5000" 
            width="10000" 
            height="10000" 
            fill="url(#grid-pattern)"
            pointer-events="none"
          />

          {#if mode === 'files'}
          <!-- Links (Dependency Curves) -->
          <g class="links-layer">
            {#each graphData.links as link}
              {@const srcNode = graphData.nodes.find(n => n.id === link.source)}
              {@const tgtNode = graphData.nodes.find(n => n.id === link.target)}
              {#if srcNode && tgtNode}
                {@const isHoveredSrc = hoveredNodeId === link.source}
                {@const isHoveredTgt = hoveredNodeId === link.target}
                {@const isDimmed = hoveredNodeId !== null && !isHoveredSrc && !isHoveredTgt}
                {@const isHighlighted = hoveredNodeId !== null && (isHoveredSrc || isHoveredTgt)}
                
                <path
                  d={getLinkPath(srcNode, tgtNode)}
                  class="dependency-link"
                  class:dimmed={isDimmed}
                  class:highlight-out={isHoveredSrc}
                  class:highlight-in={isHoveredTgt}
                  stroke={isHoveredSrc ? '#ec4899' : isHoveredTgt ? '#10b981' : 'rgba(99, 102, 241, 0.55)'}
                  stroke-width={isHighlighted ? 4 : 2}
                  fill="none"
                />
              {/if}
            {/each}
          </g>

          <!-- Folders & Files Layout -->
          <g class="folders-layer">
            {#each folders as folder}
              <!-- Outer Folder Pane (Glassmorphic Container) -->
              <g class="folder-group" transform="translate({folder.x}, {folder.y})">
                <rect
                  width={folder.width}
                  height={folder.height}
                  rx="12"
                  class="folder-pane"
                  stroke="rgba(99, 102, 241, 0.15)"
                  fill="rgba(17, 24, 39, 0.7)"
                />
                
                <!-- Folder Header Title -->
                <text
                  x="16"
                  y="30"
                  class="folder-header-title"
                  fill="#94a3b8"
                >
                  📁 {folder.name}
                </text>

                <!-- Line divider under header -->
                <line 
                  x1="0" 
                  y1="48" 
                  x2={folder.width} 
                  y2="48" 
                  stroke="rgba(30, 41, 59, 0.8)" 
                  stroke-width="1.5"
                />
              </g>
            {/each}

            <!-- Individual File Cards (interactive-node overlay) -->
            {#each graphData.nodes as node}
              {@const isHovered = hoveredNodeId === node.id}
              {@const isSelected = selectedNodeId === node.id}
              {@const isActive = activeFileId === node.id}
              {@const isSearchResult = searchMatchIds() ? searchMatchIds()!.has(node.id) : true}
              {@const isExtensionFiltered = activeExtensionFilter === 'all' || node.extension === activeExtensionFilter}
              {@const isFilteredOut = !isSearchResult || !isExtensionFiltered}
              {@const isDimmed = (hoveredNodeId !== null && !highlightedNodeIds().has(node.id)) || isFilteredOut}
              
              {#if node.x !== undefined && node.y !== undefined}
                <g
                  class="interactive-node"
                  class:dimmed={isDimmed}
                  class:hovered={isHovered}
                  class:selected={isSelected}
                  class:active-file={isActive}
                  transform="translate({node.x}, {node.y})"
                  onmouseenter={() => hoveredNodeId = node.id}
                  onmouseleave={() => hoveredNodeId = null}
                  onclick={(e) => {
                    e.stopPropagation();
                    selectedNodeId = node.id;
                    if (vscode) {
                      vscode.postMessage({ command: 'openFile', path: node.id });
                    }
                  }}
                >
                  <!-- File Card Rect -->
                  <rect
                    width={node.width}
                    height={node.height}
                    rx="8"
                    class="file-card-rect"
                    fill="#0f172a"
                    stroke={isActive ? '#10b981' : isSelected ? '#6366f1' : isHovered ? 'rgba(99, 102, 241, 0.6)' : '#1e293b'}
                    stroke-width={isActive || isSelected ? 2 : 1}
                  />
                  {#if isActive}
                    <!-- Active file pulse ring -->
                    <rect width={node.width} height={node.height} rx="8" fill="none"
                      stroke="#10b981" stroke-width="1" opacity="0.25" class="active-pulse-ring" />
                    <!-- Active indicator dot -->
                    <circle cx={(node.width ?? 280) - 10} cy="10" r="4" fill="#10b981" class="active-dot" />
                  {/if}

                  <!-- Extension color bar -->
                  <rect x="0" y="0" width="4" height={node.height} rx="2" fill={getExtColor(node.extension)} />

                  <!-- Extension badge -->
                  <rect x="12" y="10" width="36" height="18" rx="3" fill="rgba(15, 23, 42, 0.8)" stroke="rgba(75, 85, 99, 0.35)" stroke-width="0.5" />
                  <text x="30" y="23" text-anchor="middle" class="node-ext-label" fill={getExtColor(node.extension)}>
                    {node.extension.substring(1) || 'file'}
                  </text>

                  <!-- File name -->
                  <text x="56" y="24" class="node-name-text" fill={isHovered || isSelected ? '#ffffff' : '#e2e8f0'}>
                    {node.name}
                  </text>

                  <!-- Header divider -->
                  <line x1="8" y1="38" x2={(node.width ?? 280) - 8} y2="38" stroke="#1e293b" stroke-width="1" />

                  <!-- Code preview -->
                  <foreignObject x="8" y="42" width={(node.width ?? 280) - 16} height={(node.height ?? 178) - 50}>
                    <div style="width:100%;height:100%;overflow:hidden;position:relative;">
                      <pre class="code-preview-pre">{@html node.highlightedPreview ?? node.preview?.join('\n') ?? ''}</pre>
                      <div class="code-preview-fade"></div>
                    </div>
                  </foreignObject>

                  <!-- Connection anchor dots -->
                  <circle cx="0" cy={(node.height ?? 178) / 2} r="3" fill="#4b5563" opacity="0.3" />
                  <circle cx={(node.width ?? 280)} cy={(node.height ?? 178) / 2} r="3" fill="#4b5563" opacity="0.3" />
                </g>
              {/if}
            {/each}
          </g>
          {:else}
          <!-- Branch links -->
          <g class="branch-links-layer">
            {#each branchNodes as branch}
              {#if branch.parentBranch}
                {@const parentNode = branchNodes.find(b => b.name === branch.parentBranch)}
                {#if parentNode && parentNode.x !== undefined && branch.x !== undefined}
                  {@const color = getBranchColor(branch.type)}
                  <path
                    d={getBranchLinkPath(parentNode, branch)}
                    fill="none"
                    stroke={color}
                    stroke-width="2"
                    stroke-opacity="0.45"
                  />
                {/if}
              {/if}
            {/each}
          </g>

          <!-- Branch cards -->
          <g class="branch-cards-layer">
            {#each branchNodes as branch}
              {#if branch.x !== undefined}
                {@const color = getBranchColor(branch.type)}
                {@const isHovered = hoveredBranchName === branch.name}
                {@const isSelected = selectedBranchName === branch.name}
                {@const isSearchDimmed = branchMatchNames() !== null && !branchMatchNames()!.has(branch.name)}
                {@const slashIdx = branch.name.indexOf('/')}
                {@const prefix = slashIdx >= 0 ? branch.name.slice(0, slashIdx) : ''}
                {@const shortName = slashIdx >= 0 ? branch.name.slice(slashIdx + 1) : branch.name}
                <g
                  class="branch-card"
                  class:branch-hovered={isHovered}
                  class:branch-selected={isSelected}
                  class:dimmed={isSearchDimmed}
                  transform="translate({branch.x}, {branch.y})"
                  onmouseenter={() => hoveredBranchName = branch.name}
                  onmouseleave={() => hoveredBranchName = null}
                  onclick={() => { selectedBranchName = branch.name; panToBranch(branch); }}
                >
                  <rect
                    width={branch.width}
                    height={branch.height}
                    rx="10"
                    fill="#0f172a"
                    stroke={isSelected ? color : isHovered ? color : '#1e293b'}
                    stroke-width={isSelected || isHovered ? 2 : 1}
                    stroke-opacity={isSelected ? 1 : isHovered ? 0.8 : 1}
                  />
                  <rect x="0" y="0" width="4" height={branch.height} rx="2" fill={color} />
                  <foreignObject x="4" y="0" width={(branch.width ?? 300) - 4} height={branch.height}>
                    <div class="branch-card-body">
                      <div class="branch-card-header" style="background: {color}18; border-bottom: 1px solid {color}2a">
                        <div class="branch-card-name">
                          {#if prefix}<span class="branch-prefix" style="color: {color}99">{prefix}/</span>{/if}<span class="branch-shortname">{shortName}</span>
                        </div>
                        <span class="branch-type-badge" style="background: {color}22; color: {color}; border: 1px solid {color}44">{branch.type}</span>
                      </div>
                      <div class="branch-card-content">
                        <div class="branch-commit-row">
                          <code class="branch-hash">{branch.shortHash}</code>
                          <span class="branch-time">{branch.relativeTime}</span>
                        </div>
                        <p class="branch-message">{truncate(branch.message, 44)}</p>
                        {#if branch.changedFiles.length > 0}
                          <div class="branch-divider"></div>
                          <div class="branch-files">
                            {#each branch.changedFiles.slice(0, 10) as file}
                              <div class="branch-file-row">
                                <span class="file-status-char" style="color: {fileStatusColor(file.status)}">{fileStatusIcon(file.status)}</span>
                                <span class="branch-file-path">{truncate(file.path, 32)}</span>
                              </div>
                            {/each}
                            {#if branch.changedFiles.length > 10}
                              <div class="branch-more-files">+{branch.changedFiles.length - 10} more</div>
                            {/if}
                          </div>
                        {/if}
                      </div>
                    </div>
                  </foreignObject>
                  <circle cx="0" cy={(branch.height ?? 120) / 2} r="4" fill={color} opacity="0.35" />
                  <circle cx={(branch.width ?? 300)} cy={(branch.height ?? 120) / 2} r="4" fill={color} opacity="0.35" />
                </g>
              {/if}
            {/each}
          </g>
          {/if}
        </g>
      </svg>
    </section>

    <!-- Sliding Details Sidebar -->
    {#if selectedNode}
      <aside class="sidebar">
        <div class="sidebar-header">
          <h2>File Details</h2>
          <button class="close-sidebar-btn" onclick={() => selectedNodeId = null}>&times;</button>
        </div>

        <div class="sidebar-content">
          <div class="detail-group file-header">
            <span class="file-badge" style="background-color: {getExtColor(selectedNode.extension)}1a; color: {getExtColor(selectedNode.extension)}; border: 1px solid {getExtColor(selectedNode.extension)}33">
              {selectedNode.extension}
            </span>
            <h3>{selectedNode.name}</h3>
            <p class="file-path">{selectedNode.id}</p>
          </div>

          <div class="detail-card">
            <div class="card-item">
              <span class="label">File Size:</span>
              <span class="value">{formatBytes(selectedNode.size)}</span>
            </div>
            <div class="card-item">
              <span class="label">Directory:</span>
              <span class="value">{selectedNode.dir || 'root'}</span>
            </div>
            {#if vscode}
              <button class="open-editor-btn" onclick={() => vscode?.postMessage({ command: 'openFile', path: selectedNode.id })}>
                📄 Open in Editor
              </button>
            {/if}
          </div>

          <!-- Dependency Analysis -->
          <div class="detail-group">
            <h4>Imports (Outgoing Connections)</h4>
            {#if exportsList.length > 0}
              <ul class="dep-list">
                {#each exportsList as link}
                  <li>
                    <button class="link-to-file" onclick={() => {
                      selectedNodeId = link.target;
                      if (vscode) vscode.postMessage({ command: 'openFile', path: link.target });
                    }}>
                      {link.target}
                    </button>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="empty-text">No outgoing imports detected.</p>
            {/if}
          </div>

          <div class="detail-group">
            <h4>Imported By (Incoming Connections)</h4>
            {#if importersList.length > 0}
              <ul class="dep-list">
                {#each importersList as link}
                  <li>
                    <button class="link-to-file" onclick={() => {
                      selectedNodeId = link.source;
                      if (vscode) vscode.postMessage({ command: 'openFile', path: link.source });
                    }}>
                      {link.source}
                    </button>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="empty-text">Not imported by any other scanned files.</p>
            {/if}
          </div>
        </div>
      </aside>
    {/if}

    <!-- Branch Details Sidebar -->
    {#if selectedBranch}
      {@const color = getBranchColor(selectedBranch.type)}
      <aside class="sidebar">
        <div class="sidebar-header">
          <h2>Branch Details</h2>
          <button class="close-sidebar-btn" onclick={() => selectedBranchName = null}>&times;</button>
        </div>
        <div class="sidebar-content">
          <div class="detail-group file-header">
            <span class="file-badge" style="background:{color}1a; color:{color}; border:1px solid {color}33">
              {selectedBranch.type}
            </span>
            <h3 style="word-break:break-all">{selectedBranch.name}</h3>
          </div>

          <div class="detail-card">
            <div class="card-item">
              <span class="label">Commit</span>
              <code class="value" style="font-family:monospace;color:#6366f1">{selectedBranch.shortHash}</code>
            </div>
            <div class="card-item">
              <span class="label">Last updated</span>
              <span class="value">{selectedBranch.relativeTime}</span>
            </div>
            {#if selectedBranch.parentBranch}
              <div class="card-item">
                <span class="label">Branched from</span>
                <button class="link-to-file" onclick={() => {
                  selectedBranchName = selectedBranch?.parentBranch ?? null;
                  const parent = branchNodes.find(b => b.name === selectedBranch?.parentBranch);
                  if (parent) panToBranch(parent);
                }}>
                  {selectedBranch.parentBranch}
                </button>
              </div>
            {/if}
            <div class="card-item" style="flex-direction:column;align-items:flex-start;gap:4px">
              <span class="label">Commit message</span>
              <span class="value" style="font-size:0.8rem;color:#94a3b8">{selectedBranch.message}</span>
            </div>
          </div>

          <div class="detail-group">
            <h4>Changed Files ({selectedBranch.changedFiles.length})</h4>
            {#if selectedBranch.changedFiles.length > 0}
              <ul class="dep-list">
                {#each selectedBranch.changedFiles as file}
                  <li>
                    <div class="changed-file-row">
                      <span class="changed-file-status" style="color:{fileStatusColor(file.status)}">{fileStatusIcon(file.status)}</span>
                      <button class="link-to-file" onclick={() => {
                        if (vscode) vscode.postMessage({ command: 'openFile', path: file.path });
                      }}>
                        {file.path}
                      </button>
                    </div>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="empty-text">No changed files detected.</p>
            {/if}
          </div>
        </div>
      </aside>
    {/if}
  {/if}
</main>

<style>
  /* --- Typography --- */
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

  /* --- Main Layout --- */
  .spaghetti-app {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    background-color: #0b0f19;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    color: #f3f4f6;
    user-select: none;
    overflow: hidden;
  }

  /* --- Loading and Error Screens --- */
  .loading-overlay, .error-overlay {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background-color: #0b0f19;
    color: #94a3b8;
    font-size: 0.95rem;
    gap: 16px;
  }
  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(99, 102, 241, 0.1);
    border-top-color: #6366f1;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .error-icon {
    font-size: 2.5rem;
  }
  .error-help {
    font-size: 0.8rem;
    color: #4b5563;
  }

  /* --- Top Bar Styling --- */
  .top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 64px;
    padding: 0 24px;
    background-color: #0d1324;
    border-bottom: 1px solid #1f2937;
    z-index: 10;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .emoji {
    font-size: 1.5rem;
  }
  .title {
    font-weight: 700;
    font-size: 1.25rem;
    color: #f3f4f6;
    letter-spacing: -0.025em;
  }
  .subtitle {
    font-size: 0.75rem;
    color: #6366f1;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-weight: 600;
    margin-left: 4px;
    padding: 2px 6px;
    background: rgba(99, 102, 241, 0.1);
    border-radius: 4px;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 16px;
    flex: 1;
    justify-content: center;
    max-width: 700px;
    margin: 0 24px;
  }

  /* --- Search Box --- */
  .search-box {
    position: relative;
    display: flex;
    align-items: center;
    width: 240px;
    height: 38px;
    background: #111827;
    border: 1px solid #1f2937;
    border-radius: 8px;
    padding: 0 12px;
    transition: all 0.2s;
  }
  .search-box:focus-within {
    width: 280px;
    border-color: #6366f1;
    box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25);
  }
  .search-icon {
    width: 16px;
    height: 16px;
    color: #94a3b8;
    margin-right: 8px;
  }
  .search-box input {
    width: 100%;
    background: transparent;
    border: none;
    outline: none;
    color: #f3f4f6;
    font-size: 0.875rem;
  }
  .clear-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0 4px;
  }
  .clear-btn:hover {
    color: #f3f4f6;
  }

  /* --- Filter tabs --- */
  .filter-tabs {
    display: flex;
    background-color: #111827;
    padding: 3px;
    border-radius: 8px;
    border: 1px solid #1f2937;
  }
  .tab-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    padding: 6px 12px;
    font-size: 0.75rem;
    font-weight: 500;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .tab-btn.active {
    background-color: #1f2937;
    color: #ffffff;
    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  }
  .tab-btn:hover:not(.active) {
    color: #e2e8f0;
  }

  /* --- Zoom HUD --- */
  .zoom-hud {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 0.75rem;
    color: #94a3b8;
  }
  .hud-btn {
    background: #111827;
    border: 1px solid #1f2937;
    color: #f3f4f6;
    padding: 6px 10px;
    font-size: 0.75rem;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .hud-btn:hover {
    border-color: #4b5563;
    background: #1f2937;
  }

  /* --- Canvas Area --- */
  .canvas-container {
    flex: 1;
    position: relative;
    width: 100%;
    height: calc(100vh - 64px);
    overflow: hidden;
  }
  .canvas-svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  /* --- Folders Layout --- */
  .folder-pane {
    stroke-dasharray: 2 1;
    transition: all 0.3s ease;
  }
  .folder-header-title {
    font-size: 0.85rem;
    font-weight: 600;
    letter-spacing: 0.025em;
  }

  /* --- File Node Cards --- */
  .interactive-node {
    cursor: pointer;
    transition: opacity 0.25s ease;
  }
  .file-card-rect {
    transition: stroke 0.25s, stroke-width 0.2s, filter 0.2s;
  }
  .interactive-node.hovered .file-card-rect {
    filter: drop-shadow(0 0 6px rgba(99, 102, 241, 0.4));
  }
  .node-ext-label {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
  }
  .node-name-text {
    font-size: 0.8rem;
    font-weight: 500;
  }

  :global(.code-preview-pre) {
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace;
    font-size: 6.5px;
    line-height: 1.5;
    color: #475569;
    margin: 0;
    padding: 0;
    white-space: pre;
    overflow: hidden;
    tab-size: 2;
    background: transparent !important;
  }

  /* hljs token colors tuned for our dark theme */
  :global(.code-preview-pre .hljs-keyword)  { color: #c678dd; }
  :global(.code-preview-pre .hljs-string)   { color: #98c379; }
  :global(.code-preview-pre .hljs-comment)  { color: #4b5563; font-style: italic; }
  :global(.code-preview-pre .hljs-number)   { color: #d19a66; }
  :global(.code-preview-pre .hljs-title)    { color: #61afef; }
  :global(.code-preview-pre .hljs-type)     { color: #e5c07b; }
  :global(.code-preview-pre .hljs-built_in) { color: #56b6c2; }
  :global(.code-preview-pre .hljs-attr)     { color: #e06c75; }
  :global(.code-preview-pre .hljs-literal)  { color: #d19a66; }
  :global(.code-preview-pre .hljs-variable) { color: #abb2bf; }

  :global(.code-preview-fade) {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 22px;
    background: linear-gradient(transparent, #0f172a);
    pointer-events: none;
  }

  /* --- Connections (Links) --- */
  .dependency-link {
    transition: opacity 0.25s ease, stroke-width 0.2s ease;
    pointer-events: none;
  }
  
  /* Link Animations */
  @keyframes link-flow {
    to {
      stroke-dashoffset: -20;
    }
  }

  .dependency-link.highlight-out {
    stroke-dasharray: 5, 5;
    animation: link-flow 0.8s linear infinite;
  }

  .dependency-link.highlight-in {
    stroke-dasharray: 5, 5;
    animation: link-flow 0.8s linear infinite;
  }

  /* Focus and Filtering Dimmer states */
  .interactive-node.dimmed,
  .dependency-link.dimmed {
    opacity: 0.15 !important;
  }

  /* --- Details Sidebar --- */
  .sidebar {
    position: absolute;
    top: 64px;
    right: 0;
    width: 380px;
    height: calc(100vh - 64px);
    background-color: #0d1324;
    border-left: 1px solid #1f2937;
    z-index: 20;
    display: flex;
    flex-direction: column;
    box-shadow: -4px 0 20px rgba(0, 0, 0, 0.4);
    animation: slide-in 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes slide-in {
    from {
      transform: translateX(100%);
    }
    to {
      transform: translateX(0);
    }
  }

  .sidebar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px 24px;
    border-bottom: 1px solid #1f2937;
  }
  .sidebar-header h2 {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0;
    color: #ffffff;
  }
  .close-sidebar-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 1.5rem;
    cursor: pointer;
    padding: 0 4px;
  }
  .close-sidebar-btn:hover {
    color: #ffffff;
  }

  .sidebar-content {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .detail-group h3 {
    margin: 8px 0 4px 0;
    font-size: 1.25rem;
    font-weight: 600;
  }
  .detail-group h4 {
    margin: 0 0 12px 0;
    font-size: 0.85rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  
  .file-path {
    font-family: monospace;
    font-size: 0.75rem;
    color: #6366f1;
    word-break: break-all;
    margin: 0;
  }
  .file-badge {
    display: inline-block;
    padding: 2px 8px;
    font-size: 0.7rem;
    font-weight: 600;
    border-radius: 4px;
    text-transform: uppercase;
  }

  .detail-card {
    background-color: #111827;
    border: 1px solid #1f2937;
    border-radius: 10px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .card-item {
    display: flex;
    justify-content: space-between;
    font-size: 0.85rem;
  }
  .card-item .label {
    color: #94a3b8;
  }
  .card-item .value {
    font-weight: 500;
    color: #f3f4f6;
  }

  .open-editor-btn {
    margin-top: 8px;
    width: 100%;
    background-color: #6366f1;
    border: none;
    color: white;
    padding: 8px 12px;
    font-size: 0.85rem;
    font-weight: 500;
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .open-editor-btn:hover {
    background-color: #4f46e5;
  }

  .dep-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .link-to-file {
    width: 100%;
    text-align: left;
    background-color: #111827;
    border: 1px solid #1f2937;
    color: #e2e8f0;
    padding: 8px 12px;
    font-size: 0.8rem;
    border-radius: 6px;
    cursor: pointer;
    font-family: monospace;
    transition: all 0.2s;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link-to-file:hover {
    border-color: #6366f1;
    color: #6366f1;
    background-color: rgba(99, 102, 241, 0.05);
  }

  .empty-text {
    font-size: 0.8rem;
    color: #4b5563;
    font-style: italic;
    margin: 0;
  }

  /* --- Mode Toggle --- */
  .mode-toggle {
    display: flex;
    background: #111827;
    padding: 3px;
    border-radius: 8px;
    border: 1px solid #1f2937;
    gap: 2px;
  }
  .mode-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    padding: 6px 14px;
    font-size: 0.8rem;
    font-weight: 500;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .mode-btn.active {
    background: #1f2937;
    color: #fff;
  }
  .mode-btn:hover:not(.active) {
    color: #e2e8f0;
  }
  .branch-count {
    background: rgba(99, 102, 241, 0.15);
    color: #6366f1;
    padding: 1px 6px;
    border-radius: 10px;
    font-size: 0.7rem;
    font-weight: 600;
  }

  /* --- Branch Canvas --- */
  .branch-hovered :global(rect:first-child) {
    filter: drop-shadow(0 0 10px rgba(99, 102, 241, 0.35));
  }

  :global(.branch-card-body) {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: 'Inter', system-ui, sans-serif;
    box-sizing: border-box;
  }
  :global(.branch-card-header) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    flex-shrink: 0;
    gap: 8px;
  }
  :global(.branch-card-name) {
    font-size: 0.73rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    line-height: 1.3;
  }
  :global(.branch-prefix) {
    font-weight: 500;
  }
  :global(.branch-shortname) {
    color: #f3f4f6;
  }
  :global(.branch-type-badge) {
    font-size: 0.58rem;
    font-weight: 700;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 4px;
    flex-shrink: 0;
    letter-spacing: 0.04em;
  }
  :global(.branch-card-content) {
    padding: 8px 12px;
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  :global(.branch-commit-row) {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  :global(.branch-hash) {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.62rem;
    color: #6366f1;
    background: rgba(99, 102, 241, 0.1);
    padding: 1px 5px;
    border-radius: 3px;
  }
  :global(.branch-time) {
    font-size: 0.68rem;
    color: #64748b;
  }
  :global(.branch-message) {
    font-size: 0.7rem;
    color: #94a3b8;
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.4;
  }
  :global(.branch-divider) {
    height: 1px;
    background: #1e293b;
    margin: 4px 0 2px;
    flex-shrink: 0;
  }
  :global(.branch-files) {
    display: flex;
    flex-direction: column;
    gap: 1px;
    overflow: hidden;
    flex: 1;
  }
  :global(.branch-file-row) {
    display: flex;
    align-items: center;
    gap: 5px;
    line-height: 1.6;
  }
  :global(.file-status-char) {
    font-size: 0.65rem;
    font-weight: 700;
    width: 10px;
    text-align: center;
    flex-shrink: 0;
    font-family: monospace;
  }
  :global(.branch-file-path) {
    font-size: 0.62rem;
    color: #4b5563;
    font-family: 'JetBrains Mono', monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  :global(.branch-more-files) {
    font-size: 0.62rem;
    color: #374151;
    font-style: italic;
    padding-left: 15px;
  }

  /* --- Branch card selected state --- */
  .branch-card {
    cursor: pointer;
    transition: opacity 0.2s;
  }
  .branch-card.dimmed {
    opacity: 0.15;
  }
  .branch-selected :global(rect:first-child) {
    filter: drop-shadow(0 0 12px rgba(99, 102, 241, 0.5));
  }

  /* --- Changed file row in branch sidebar --- */
  .changed-file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  .changed-file-status {
    font-size: 0.8rem;
    font-weight: 700;
    width: 14px;
    text-align: center;
    flex-shrink: 0;
    font-family: monospace;
  }

  /* --- Active File (VS Code tracked) --- */
  .interactive-node.active-file .file-card-rect {
    filter: drop-shadow(0 0 8px rgba(16, 185, 129, 0.5));
  }

  @keyframes pulse-ring {
    0%   { opacity: 0.3; stroke-width: 1; }
    50%  { opacity: 0.08; stroke-width: 3; }
    100% { opacity: 0.3; stroke-width: 1; }
  }
  :global(.active-pulse-ring) {
    animation: pulse-ring 2s ease-in-out infinite;
  }
  :global(.active-dot) {
    animation: pulse-ring 2s ease-in-out infinite;
  }

  /* --- VS Code Theme Bridge --- */
  /* When running inside a VS Code webview, use the injected CSS variables */
  :global(body[data-vscode]) .spaghetti-app {
    background-color: var(--app-canvas-bg, #0b0f19);
  }
  :global(body[data-vscode]) .top-bar {
    background-color: var(--app-surface, #0d1324);
    border-bottom-color: var(--app-border, #1f2937);
  }
  :global(body[data-vscode]) .sidebar {
    background-color: var(--app-surface, #0d1324);
    border-left-color: var(--app-border, #1f2937);
  }
  :global(body[data-vscode]) .search-box {
    background: var(--app-input-bg, #111827);
    border-color: var(--app-border, #1f2937);
  }
  :global(body[data-vscode]) .filter-tabs,
  :global(body[data-vscode]) .mode-toggle {
    background: var(--app-input-bg, #111827);
    border-color: var(--app-border, #1f2937);
  }
  :global(body[data-vscode]) .title {
    color: var(--app-text-primary, #f3f4f6);
  }
  :global(body[data-vscode]) .zoom-hud {
    color: var(--app-text-muted, #94a3b8);
  }
</style>
