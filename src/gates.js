// Decision logic for the four gates.
//
// SHARED PRINCIPLE: if no other session is live in this worktree, no gate ever
// fires — the tool is a complete no-op. Friction only exists during genuine
// parallel work. A gate nobody can pass is worse than no gate at all.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, isIgnored } from './config.js';
import {
  findRepo, relOf, dirtyPaths, stagedPaths, trackedModifiedPaths,
  commitPaths, revParse,
} from './repo.js';
import { touchSession, foreignLiveSessions, readSession, labelOf } from './session.js';
import { tryClaim, foreignHeld, readClaim, writePass } from './store.js';
import { analyze, hasIndirection, mentionsGit } from './parse-git.js';

export const ALLOW = { allow: true };
const deny = (message, detail) => ({ allow: false, message, detail });

export function context({ cwd = process.cwd(), sid }) {
  const repo = findRepo(cwd);
  const cfg = loadConfig(repo);
  return { repo, cfg, sid, wt: repo.root, cwd };
}

function ageOf(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`;
}

function ownerLine(ctx, claim) {
  const s = readSession(ctx.repo, claim.sid);
  return `  ${claim.path} → "${labelOf(s)}" (claimed ${ageOf(claim.at)} ago)`;
}

function denyMessage(ctx, held, what) {
  const lines = held.slice(0, 6).map((c) => ownerLine(ctx, c));
  if (held.length > 6) lines.push(`  … and ${held.length - 6} more`);
  return [
    `agentclaim: blocked ${what} — another live agent session holds these files:`,
    ...lines,
    '',
    'Work on a different file, wait for the owner to release, or take over:',
    `  agentclaim release ${held[0].path} --force`,
    'See what is going on:  agentclaim status',
  ].join('\n');
}

export function isSolo(ctx) {
  return foreignLiveSessions(ctx.repo, ctx.cfg, ctx.sid, ctx.wt).length === 0;
}

// ── Gate 1: writes ───────────────────────────────────────────────────────────
export function gateWrite(ctx, filePath) {
  if (ctx.cfg.mode === 'off') return ALLOW;
  const rel = relOf(ctx.repo, filePath, ctx.cwd);
  if (!rel) return ALLOW;                       // outside the repo — not our business
  if (isIgnored(ctx.cfg, rel)) return ALLOW;    // generated file

  // Claim even when alone, so ownership is already established the moment a
  // second session shows up.
  const r = tryClaim(ctx.repo, ctx.cfg, { wt: ctx.wt, rel, sid: ctx.sid });
  if (r.ok) return ALLOW;
  if (isSolo(ctx)) return ALLOW;                // unreachable in practice; no-op guarantee
  if (ctx.cfg.mode === 'warn') return { allow: true, warn: denyMessage(ctx, [r.owner], 'write') };
  return deny(denyMessage(ctx, [r.owner], `write to ${rel}`), [r.owner]);
}

// ── Gate 2: git commands ─────────────────────────────────────────────────────
function expandPaths(ctx, given) {
  const dirty = dirtyPaths(ctx.repo);
  const out = new Set();
  for (const g of given) {
    const rel = relOf(ctx.repo, g, ctx.cwd);
    if (!rel) continue;
    const abs = path.join(ctx.repo.root, rel);
    let isDir = false;
    try { isDir = fs.statSync(abs).isDirectory(); } catch {}
    if (isDir || /[*?[]/.test(g)) {
      // A directory, or a pattern the shell did not expand: match the dirty set.
      const pref = isDir ? `${rel}/` : null;
      for (const d of dirty) {
        if (pref ? d.startsWith(pref) : simpleMatch(rel, d)) out.add(d);
      }
    } else out.add(rel);
  }
  return [...out];
}

function simpleMatch(pattern, s) {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
  return re.test(s);
}

function pathsForScope(ctx, op) {
  if (op.paths) return expandPaths(ctx, op.paths);
  if (op.scope === 'STAGED') return stagedPaths(ctx.repo);
  if (op.scope === 'TRACKED_MODIFIED') return trackedModifiedPaths(ctx.repo);
  return dirtyPaths(ctx.repo);
}

export function gateBash(ctx, command) {
  if (ctx.cfg.mode === 'off') return ALLOW;
  if (!command) return ALLOW;
  if (isSolo(ctx)) return ALLOW;   // ← no-op guarantee: never fires for a lone session

  const ops = analyze(command);
  for (const op of ops) {
    const paths = pathsForScope(ctx, op).filter((p) => !isIgnored(ctx.cfg, p));
    if (!paths.length) continue;
    const held = foreignHeld(ctx.repo, ctx.cfg, { wt: ctx.wt, sid: ctx.sid, paths });
    if (held.length) {
      if (ctx.cfg.mode === 'warn') return { allow: true, warn: denyMessage(ctx, held, op.op) };
      return deny(denyMessage(ctx, held, `\`${op.op}\``), held);
    }
  }

  // Everything passed. If a commit is about to run, leave an identity token so
  // the git pre-commit hook knows which session it belongs to.
  if (ops.some((o) => o.op.startsWith('git commit'))) writePass(ctx.repo, ctx.sid);

  // A command we could not decode that still touches git indirectly: we do not
  // wave it through while someone else is working. A lone session never gets here.
  if (!ops.length && hasIndirection(command) && mentionsGit(command)) {
    const others = foreignLiveSessions(ctx.repo, ctx.cfg, ctx.sid, ctx.wt).length > 0;
    if (others && ctx.cfg.mode === 'block') {
      return deny(
        [
          'agentclaim: this command could not be parsed, it touches git indirectly,',
          'and another agent session is working in this tree right now:',
          `  ${command.trim().slice(0, 200)}`,
          '',
          'Write the git command directly (no eval / sh -c), or check the state:',
          '  agentclaim status',
        ].join('\n'),
        []
      );
    }
  }
  return ALLOW;
}

// ── Gate 3: commit truth check ───────────────────────────────────────────────
//
// The bug it catches: `git add` snapshots the file as it is AT THAT MOMENT. If
// another session rewrites it before you commit, the commit carries the OLD
// content and git says nothing at all.
//
// FALSE-POSITIVE GUARD: `git add x; edit x; git commit` also produces
// commit ≠ disk, but that is LEGITIMATE partial staging. So by default we only
// report files held by ANOTHER session.
export function verifyCommit(ctx, rev = 'HEAD', { onlyForeign = true } = {}) {
  const sha = revParse(ctx.repo, rev);
  if (!sha) return { sha: null, mismatches: [], error: `unknown revision: ${rev}` };
  const out = [];
  for (const rel of commitPaths(ctx.repo, sha)) {
    if (isIgnored(ctx.cfg, rel)) continue;
    if (onlyForeign) {
      const c = readClaim(ctx.repo, ctx.wt, rel);
      if (!c || c.sid === ctx.sid) continue;   // mine or unowned → treated as intentional
    }
    const abs = path.join(ctx.repo.root, rel);
    let disk;
    try { disk = fs.readFileSync(abs); } catch { continue; } // deleted in the commit
    let blob;
    try {
      blob = execFileSync('git', ['show', `${sha}:${rel}`], {
        cwd: ctx.repo.root, maxBuffer: 64 * 1024 * 1024,
      });
    } catch { continue; }
    if (!blob.equals(disk)) out.push(rel);
  }
  return { sha, mismatches: out };
}

export function verifyMessage(sha, mismatches) {
  return [
    `agentclaim: ⚠ commit ${sha.slice(0, 7)} does NOT match what is on disk:`,
    ...mismatches.map((p) => `  ${p}`),
    '',
    'This is the classic `git add` snapshot race: another session rewrote these',
    'files after you staged them, so the commit captured stale content.',
    'DO NOT DEPLOY. Fix it with:',
    `  git add ${mismatches.join(' ')} && git commit --amend --no-edit`,
  ].join('\n');
}

export { touchSession };
