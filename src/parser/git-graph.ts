import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface BranchNode {
  name: string;
  shortHash: string;
  fullHash: string;
  message: string;
  timestamp: number;
  relativeTime: string;
  parentBranch: string | null;
  changedFiles: ChangedFile[];
  type: 'main' | 'feat' | 'bugfix' | 'refactor' | 'chore' | 'other';
}

export interface ChangedFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  extension: string;
}

export interface GitGraph {
  branches: BranchNode[];
  defaultBranch: string;
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function getBranchType(name: string): BranchNode['type'] {
  if (name === 'main' || name === 'master' || name === 'trunk') return 'main';
  if (name.startsWith('feat/') || name.startsWith('feature/')) return 'feat';
  if (name.startsWith('bugfix/') || name.startsWith('fix/') || name.startsWith('hotfix/')) return 'bugfix';
  if (name.startsWith('refactor/') || name.startsWith('ref/')) return 'refactor';
  if (name.startsWith('chore/') || name.startsWith('docs/') || name.startsWith('ci/')) return 'chore';
  return 'other';
}

function relativeTime(timestamp: number): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / (86400 * 30))}mo ago`;
}

function generateGitGraph(repoDir: string): GitGraph {
  const cwd = path.resolve(repoDir);

  const defaultBranch =
    run('git symbolic-ref --short HEAD', cwd) ||
    run('git config init.defaultBranch', cwd) ||
    'main';

  // Collect all local branches sorted oldest→newest
  const raw = run(
    `git for-each-ref --sort=committerdate --format="%(refname:short)|%(objectname:short)|%(objectname)|%(subject)|%(committerdate:unix)" refs/heads/`,
    cwd
  );

  if (!raw) return { branches: [], defaultBranch };

  type RawBranch = { name: string; shortHash: string; fullHash: string; message: string; timestamp: number };

  const rawBranches: RawBranch[] = raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const parts = line.split('|');
      return {
        name: parts[0],
        shortHash: parts[1],
        fullHash: parts[2],
        message: parts[3],
        timestamp: parseInt(parts[4]) || 0,
      };
    });

  const branches: BranchNode[] = rawBranches.map(branch => {
    // Find parent: the branch whose tip is a direct ancestor of this branch,
    // is older, and has the latest timestamp among all such candidates.
    let parentBranch: string | null = null;
    let bestTs = -1;

    for (const other of rawBranches) {
      if (other.name === branch.name) continue;
      if (other.timestamp >= branch.timestamp) continue;
      const mergeBase = run(`git merge-base "${branch.fullHash}" "${other.fullHash}"`, cwd);
      if (mergeBase && mergeBase === other.fullHash && other.timestamp > bestTs) {
        bestTs = other.timestamp;
        parentBranch = other.name;
      }
    }

    // Get changed files relative to merge-base with parent (or default branch)
    const compareWith = parentBranch ?? defaultBranch;
    let changedFiles: ChangedFile[] = [];

    if (branch.name !== compareWith) {
      const mergeBase = run(`git merge-base "${compareWith}" "${branch.fullHash}"`, cwd);
      if (mergeBase) {
        const diff = run(`git diff --name-status "${mergeBase}" "${branch.fullHash}"`, cwd);
        changedFiles = diff
          .split('\n')
          .filter(Boolean)
          .slice(0, 15)
          .map(line => {
            const [status, filePath] = line.split('\t');
            return {
              path: filePath ?? '',
              status: (status?.[0] ?? 'M') as ChangedFile['status'],
              extension: path.extname(filePath ?? '').toLowerCase(),
            };
          });
      }
    }

    return {
      name: branch.name,
      shortHash: branch.shortHash,
      fullHash: branch.fullHash,
      message: branch.message,
      timestamp: branch.timestamp,
      relativeTime: relativeTime(branch.timestamp),
      parentBranch,
      changedFiles,
      type: getBranchType(branch.name),
    };
  });

  return { branches, defaultBranch };
}

const targetDir = process.argv[2] || '.';
const outputFile = process.argv[3] || 'public/git-graph.json';

try {
  const graph = generateGitGraph(targetDir);
  const outDir = path.dirname(outputFile);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(graph, null, 2));
  console.log(`Branches: ${graph.branches.length} (default: ${graph.defaultBranch})`);
  console.log(`Saved to: ${outputFile}`);
} catch (err) {
  console.error('Error:', err);
  process.exit(1);
}
