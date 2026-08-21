// Repository identity and git queries.
//
// WHY THIS EXISTS: the lock store belongs in `--git-common-dir`, but the claim
// scope is `--show-toplevel`. In a worktree these are DIFFERENT places:
//   main checkout : common=/repo/.git   top=/repo
//   worktree wt11 : common=/repo/.git   top=/tmp/.../wt11
// We put the store in the common dir (so every worktree sees one registry) and
// key claims by toplevel (a separate worktree is a separate copy on disk, so
// blocking across worktrees would be a pure false positive — and worktrees are
// the recommended fix for this problem, we must not punish them).
//
// TRAP: bare `git rev-parse --git-common-dir` returns `.git` (RELATIVE) in a
// main checkout. Used directly, the store path drifts with the cwd and the
// protection silently collapses. `--path-format=absolute` (git 2.31+) is required.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class NotARepo extends Error {}

export function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function gitSafe(args, cwd) {
  try { return git(args, cwd); } catch { return null; }
}

export function findRepo(cwd = process.cwd()) {
  // One git process, not two: this runs on EVERY tool call, so a spare
  // subprocess here is latency the user feels all day.
  let top = null;
  let common = null;
  const both = gitSafe(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], cwd);
  if (both) {
    const lines = both.trim().split('\n');
    if (lines.length >= 2) { [top, common] = lines; }
  }
  if (!top) {
    // git < 2.31 fallback: --path-format is unsupported, and --git-common-dir
    // may come back relative, so resolve it against cwd.
    top = gitSafe(['rev-parse', '--show-toplevel'], cwd);
    if (!top) throw new NotARepo(`not inside a git repository: ${cwd}`);
    const rel = gitSafe(['rev-parse', '--git-common-dir'], cwd);
    if (rel == null) throw new NotARepo(`could not read git-common-dir: ${cwd}`);
    common = path.resolve(cwd, rel.trim());
  }
  common = common.trim();
  // realpath IS REQUIRED: on macOS /tmp and /var/folders are symlinks. git always
  // reports the RESOLVED path while an agent passes the unresolved one. Comparing
  // the two makes every path look "outside the repo" and THE GATE SILENTLY OPENS —
  // which is exactly what the first end-to-end run caught.
  const root = realish(top.trim());
  return { root, commonDir: common, store: path.join(common, 'agentclaim') };
}

// Resolves symlinks. If the file does not exist yet (a Write about to create it),
// resolves the nearest existing ancestor and re-appends the rest.
export function realish(p) {
  try { return fs.realpathSync(p); } catch {}
  const dir = path.dirname(p);
  if (dir === p) return p;
  return path.join(realish(dir), path.basename(p));
}

// Converts an absolute or relative path into a POSIX-separated path relative to
// the worktree root. Returns null when outside the repo (we never interfere there).
export function relOf(repo, p, base = process.cwd()) {
  const abs = realish(path.isAbsolute(p) ? p : path.resolve(realish(base), p));
  const rel = path.relative(repo.root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function splitZ(out) {
  return out ? out.split('\0').filter(Boolean) : [];
}

// RULE: never use `git diff` to find the dirty set — it does not see untracked
// files, and new files are exactly what tends to go missing. Always `status --porcelain`.
export function dirtyPaths(repo) {
  const out = gitSafe(['status', '--porcelain', '-z'], repo.root);
  if (out == null) return [];
  const parts = out.split('\0');
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2);
    paths.push(e.slice(3));
    // In -z format a rename/copy record is followed by the OLD path, which is
    // also an affected path.
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      i++;
      if (parts[i]) paths.push(parts[i]);
    }
  }
  return [...new Set(paths)];
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function stagedPaths(repo) {
  let out = gitSafe(['diff', '--cached', '--name-only', '-z'], repo.root);
  if (out == null) out = gitSafe(['diff', '--cached', '--name-only', '-z', EMPTY_TREE], repo.root);
  return [...new Set(splitZ(out))];
}

// What `git commit -a` would stage: tracked-modified plus already-staged.
export function trackedModifiedPaths(repo) {
  const out = gitSafe(['diff', '--name-only', '-z'], repo.root);
  return [...new Set([...splitZ(out), ...stagedPaths(repo)])];
}

export function commitPaths(repo, sha) {
  const out = gitSafe(
    ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sha],
    repo.root
  );
  return [...new Set(splitZ(out))];
}

export function revParse(repo, rev) {
  const out = gitSafe(['rev-parse', '--verify', '--quiet', rev], repo.root);
  return out ? out.trim() : null;
}
