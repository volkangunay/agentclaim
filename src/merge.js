// Region maths and three-way merge — the part that turns "blocked" into "both
// of you can work".
//
// Two agents touching the same file is only a real conflict when they touch the
// same REGION. Anything else is a false conflict, and blocking it teaches people
// to switch the tool off. Everything here leans on git itself: `git diff
// --no-index -U0` for changed ranges and `git merge-file` for the merge. No
// dependency, and the merge semantics are the ones users already trust.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// Line ranges (1-based, inclusive, in the CURRENT file) that differ from base.
export function changedRanges(baseFile, curFile) {
  let out = '';
  try {
    out = execFileSync('git', ['diff', '--no-index', '--unified=0', '--', baseFile, curFile], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    // git diff exits 1 when the files differ — that is the normal path.
    out = e.stdout ? e.stdout.toString() : '';
    if (!out) return null; // could not determine; caller must be conservative
  }
  const ranges = [];
  for (const line of out.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) {
      // Pure deletion: the change sits between lines. Treat the seam as touched.
      ranges.push({ start: Math.max(1, start), end: Math.max(1, start) + 1 });
    } else {
      ranges.push({ start, end: start + count - 1 });
    }
  }
  return ranges;
}

// Line range covered by a substring inside content.
export function rangeOfString(content, needle, all = false) {
  if (!needle) return [];
  const ranges = [];
  let from = 0;
  for (;;) {
    const idx = content.indexOf(needle, from);
    if (idx === -1) break;
    const start = content.slice(0, idx).split('\n').length;
    const end = start + needle.split('\n').length - 1;
    ranges.push({ start, end });
    if (!all) break;
    from = idx + Math.max(1, needle.length);
  }
  return ranges;
}

// The same diff, but keeping each hunk's text so we can show an agent what the
// other one actually wrote. Telling someone "line 14 conflicts" makes them guess;
// showing them the other version lets them adapt in one step.
export function changedHunks(baseFile, curFile) {
  let out = '';
  try {
    out = execFileSync('git', ['diff', '--no-index', '--unified=1', '--', baseFile, curFile], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    out = e.stdout ? e.stdout.toString() : '';
  }
  const hunks = [];
  let cur = null;
  for (const line of out.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      cur = { start, end: count === 0 ? start + 1 : start + count - 1, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (cur && /^[-+ ]/.test(line)) cur.lines.push(line);
  }
  return hunks;
}

export function overlaps(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

export function anyOverlap(aList, bList) {
  return aList.some((a) => bList.some((b) => overlaps(a, b)));
}

export function fmtRanges(list) {
  return list.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join(', ');
}

/**
 * Three-way merge via git. `ours` is what is on disk right now (the other
 * agent's work), `theirs` is what this agent wants to write.
 * @returns {{ok: true, content: string} | {ok: false, conflicts: number}}
 */
export function mergeThreeWay(oursFile, baseFile, theirsFile) {
  try {
    const merged = execFileSync(
      'git',
      ['merge-file', '-p', '--diff3', oursFile, baseFile, theirsFile],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
    return { ok: true, content: merged };
  } catch (e) {
    // A positive exit status is the number of conflicts, not a failure to run.
    const status = typeof e.status === 'number' ? e.status : -1;
    return { ok: false, conflicts: status > 0 ? status : 1 };
  }
}

export function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
