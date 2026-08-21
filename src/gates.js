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
import { tryClaim, foreignHeld, readClaim, writePass, addToucher, otherLiveTouchers } from './store.js';
import { analyze, hasIndirection, mentionsGit } from './parse-git.js';
import { snapFile, takeSnapshot, tmpFile, writePending } from './snapshot.js';
import { changedRanges, changedHunks, rangeOfString, anyOverlap, overlaps, fmtRanges, mergeThreeWay, readText } from './merge.js';

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
    'Ways out, in order of preference:',
    `  agentclaim release ${held[0].path}   # "I am done here" — frees it for them`,
    '  …or wait: a session stops blocking a file it has not edited recently',
    `  agentclaim release ${held[0].path} --force   # take it over outright`,
    'See what is going on:  agentclaim status',
  ].join('\n');
}

export function isSolo(ctx) {
  return foreignLiveSessions(ctx.repo, ctx.cfg, ctx.sid, ctx.wt).length === 0;
}

// ── Gate 1: writes ───────────────────────────────────────────────────────────
//
// Blocking is a stop sign, not a solution. Two agents in one file are only in
// real conflict when they touch the same REGION; anything else is a false
// conflict, and a tool that blocks those gets switched off.
//
// So the question is never "who owns this file?" but "what changed since I last
// looked at it?" — only that isolates the other agent's edits from my own, and
// it stays symmetric: the claim holder can no more clobber a latecomer's region
// than the other way round.
//
//   Edit  → does my target region overlap what changed since my snapshot?
//   Write → three-way merge (git merge-file); a clean merge is stashed and
//           applied to the file right after the tool runs, so BOTH edits land.
//
// Writes get smarter. Commits stay strict: once two live sessions have touched a
// file, Gate 2 stops both of them committing it, because that is exactly how one
// agent ships the other's half-finished work.
function targetRanges(tool, input, disk) {
  if (tool === 'Write') return null;                       // whole file → merge path
  const edits = tool === 'MultiEdit' && Array.isArray(input.edits)
    ? input.edits
    : [{ old_string: input.old_string, replace_all: input.replace_all }];
  const out = [];
  for (const e of edits) {
    if (!e || !e.old_string) continue;
    out.push(...rangeOfString(disk, e.old_string, Boolean(e.replace_all)));
  }
  return out;
}

// The other agent's actual edit, limited to the region we collide in.
function theirDiff(snapFilePath, absPath, mineRanges, maxLines = 24) {
  const hunks = changedHunks(snapFilePath, absPath)
    .filter((h) => mineRanges.some((m) => overlaps(m, h)));
  const out = [];
  for (const h of hunks) {
    out.push(`  @@ line ${h.start}${h.end !== h.start ? `-${h.end}` : ''} @@`);
    for (const l of h.lines) {
      if (out.length >= maxLines) { out.push('  … (truncated)'); return out; }
      out.push(`  ${l}`);
    }
  }
  return out.length ? out : ['  (their change could not be extracted)'];
}

function coexistNote(rel, mine, others, how) {
  return [
    `agentclaim: ${rel} is also being edited by another agent — ${how}.`,
    `  their lines: ${fmtRanges(others)}`,
    ...(mine ? [`  your lines:  ${fmtRanges(mine)}`] : []),
    'Both edits are kept. You may not commit this file until they are done.',
  ].join('\n');
}

export function gateWrite(ctx, tool, input) {
  if (ctx.cfg.mode === 'off') return ALLOW;
  const filePath = input.file_path || input.notebook_path || input.path;
  if (!filePath) return ALLOW;
  const rel = relOf(ctx.repo, filePath, ctx.cwd);
  if (!rel) return ALLOW;                       // outside the repo — not our business
  if (isIgnored(ctx.cfg, rel)) return ALLOW;    // generated file

  const abs = path.join(ctx.repo.root, rel);
  const claim = readClaim(ctx.repo, ctx.wt, rel);
  const others = otherLiveTouchers(ctx.repo, ctx.cfg, claim, ctx.sid);

  // Nobody else is in this file: claim it and get out of the way.
  if (!others.length || isSolo(ctx)) {
    tryClaim(ctx.repo, ctx.cfg, { wt: ctx.wt, rel, sid: ctx.sid });
    return ALLOW;
  }

  const held = [claim];
  const snap = snapFile(ctx.repo, ctx.sid, ctx.wt, rel);
  if (!snap) {
    // This session has never looked at the file, so it cannot be editing around
    // anyone. Writing here would be a blind clobber.
    return ctx.cfg.mode === 'warn'
      ? { allow: true, warn: denyMessage(ctx, held, `write to ${rel}`) }
      : deny(`${denyMessage(ctx, held, `write to ${rel}`)}\n\nRead the file first; agentclaim can then let you edit around them.`, held);
  }

  const changed = changedRanges(snap, abs);
  if (changed === null) {
    return deny(denyMessage(ctx, held, `write to ${rel}`), held);   // undecidable → stay safe
  }
  if (!changed.length) {
    // Nothing moved since I looked: my view is current, nothing to collide with.
    addToucher(ctx.repo, ctx.cfg, { wt: ctx.wt, rel, sid: ctx.sid });
    return ALLOW;
  }

  const disk = readText(abs);
  if (disk === null) return deny(denyMessage(ctx, held, `write to ${rel}`), held);   // binary

  if (tool !== 'Write') {
    const mine = targetRanges(tool, input, disk) || [];
    // old_string not present: the tool will fail on its own, no need to guess.
    if (!mine.length) return ALLOW;
    if (!anyOverlap(mine, changed)) {
      addToucher(ctx.repo, ctx.cfg, { wt: ctx.wt, rel, sid: ctx.sid });
      return { allow: true, note: coexistNote(rel, mine, changed, 'your edits do not overlap theirs') };
    }
    return deny(
      [
        `agentclaim: real conflict in ${rel} — you and another agent are editing the same lines.`,
        `  their lines: ${fmtRanges(changed)}`,
        `  your lines:  ${fmtRanges(mine)}`,
        '',
        'This is what they changed there, so you can adapt without re-reading blind:',
        ...theirDiff(snap, abs, mine),
        '',
        'Re-apply your change on top of their version, or work elsewhere until',
        'they are done. If you are finished in this file:  agentclaim release ' + rel,
      ].join('\n'),
      held
    );
  }

  // Whole-file Write: let git decide, using what I last saw as the merge base.
  const theirs = tmpFile(ctx.repo, 'theirs', input.content ?? '');
  const m = mergeThreeWay(abs, snap, theirs);
  if (m.ok) {
    addToucher(ctx.repo, ctx.cfg, { wt: ctx.wt, rel, sid: ctx.sid });
    writePending(ctx.repo, ctx.sid, ctx.wt, rel, m.content);
    return {
      allow: true,
      note: coexistNote(rel, null, changed, 'your write will be merged with theirs'),
    };
  }
  return deny(
    [
      `agentclaim: real conflict in ${rel} — your write cannot be merged with the other agent's changes.`,
      `  their lines: ${fmtRanges(changed)}`,
      '',
      'Re-read the file, then re-apply your change on top of their version.',
    ].join('\n'),
    held
  );
}

export { takeSnapshot };

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
