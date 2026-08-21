// Claude Code hook bridge.
//
// CONTRACT (verified against the official hook-development skill, not assumed):
//   input : JSON on stdin — session_id, cwd, tool_name, tool_input[, tool_response]
//   allow : exit 0
//   deny  : {"hookSpecificOutput":{"permissionDecision":"deny"},
//            "systemMessage":"..."} on stderr + exit 2
//
// GOLDEN RULE: this bridge must NEVER break the user's session. Whatever blows
// up inside, we exit 0 and let the tool through. A broken guard that blocks
// everything is worse than no guard at all.

import fs from 'node:fs';
import path from 'node:path';
import { context, gateWrite, gateBash, verifyCommit, verifyMessage, isSolo } from './gates.js';
import { touchSession, dropSession, resolveSid } from './session.js';
import { releaseAllFor, gc } from './store.js';
import { takeSnapshot, dropSnapshots, dropPending, takePending, cleanTmp } from './snapshot.js';
import { relOf } from './repo.js';
import { isIgnored } from './config.js';

function readStdin() {
  const chunks = [];
  try {
    const buf = Buffer.alloc(65536);
    let n;
    while ((n = fs.readSync(0, buf, 0, buf.length, null)) > 0) chunks.push(Buffer.from(buf.subarray(0, n)));
  } catch (e) {
    if (e.code !== 'EAGAIN' && e.code !== 'EOF') { /* swallow */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function allow(message) {
  if (message) process.stderr.write(`\n${message}\n`);
  process.exit(0);
}

function denyExit(message) {
  process.stderr.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
      systemMessage: message,
    })
  );
  process.stderr.write(`\n${message}\n`);
  process.exit(2);
}

function feedback(message) {
  process.stderr.write(`\n${message}\n`);
  process.exit(2); // PostToolUse: the tool already ran; surface this to the model
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'str_replace_editor']);
const SEEN_TOOLS = new Set([...WRITE_TOOLS, 'Read', 'NotebookRead']);

const pathOf = (input) => input.file_path || input.notebook_path || input.path;

export function runHook(event) {
  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch { allow(); }

  const sid = resolveSid(payload.session_id);
  const cwd = payload.cwd || process.cwd();
  let ctx;
  try { ctx = context({ cwd, sid }); } catch { allow(); } // not a git repo -> stay out

  try { touchSession(ctx.repo, sid, { wt: ctx.wt, cwd, agent: 'claude-code' }); } catch {}

  const tool = payload.tool_name || '';
  const input = payload.tool_input || {};

  switch (event) {
    case 'SessionStart': {
      try { gc(ctx.repo, ctx.cfg); cleanTmp(ctx.repo); } catch {}
      allow();
      break;
    }
    case 'SessionEnd': {
      try {
        releaseAllFor(ctx.repo, sid);
        dropSnapshots(ctx.repo, sid);
        dropPending(ctx.repo, sid);
        dropSession(ctx.repo, sid);
      } catch {}
      allow();
      break;
    }
    case 'PreToolUse': {
      let d = { allow: true };
      if (WRITE_TOOLS.has(tool)) d = gateWrite(ctx, tool, input);
      else if (tool === 'Bash') d = gateBash(ctx, input.command || '');
      if (!d.allow) denyExit(d.message);
      allow(d.note || d.warn);
      break;
    }
    case 'PostToolUse': {
      // 1. Apply a merge computed before the write, so the other agent's work
      //    survives a whole-file overwrite.
      if (tool === 'Write') applyPendingMerge(ctx, sid, input);

      // 2. Remember what this session has now seen, so the next edit can be
      //    reasoned about region by region.
      if (SEEN_TOOLS.has(tool)) snapshot(ctx, sid, input);

      // 3. Gate 3: did the commit actually capture what is on disk?
      const cmd = input.command || '';
      if (tool === 'Bash' && /\bgit\b[\s\S]*\bcommit\b/.test(cmd) && !isSolo(ctx)) {
        const r = verifyCommit(ctx, 'HEAD');
        if (r.mismatches && r.mismatches.length) feedback(verifyMessage(r.sha, r.mismatches));
      }
      allow();
      break;
    }
    default:
      allow();
  }
}

function relFor(ctx, input) {
  const p = pathOf(input);
  if (!p) return null;
  const rel = relOf(ctx.repo, p, ctx.cwd);
  if (!rel || isIgnored(ctx.cfg, rel)) return null;
  return rel;
}

function snapshot(ctx, sid, input) {
  try {
    const rel = relFor(ctx, input);
    if (rel) takeSnapshot(ctx.repo, sid, ctx.wt, rel, path.join(ctx.repo.root, rel));
  } catch {}
}

function applyPendingMerge(ctx, sid, input) {
  try {
    const rel = relFor(ctx, input);
    if (!rel) return;
    const merged = takePending(ctx.repo, sid, ctx.wt, rel);
    if (!merged) return;
    const abs = path.join(ctx.repo.root, rel);
    fs.writeFileSync(abs, merged);
    takeSnapshot(ctx.repo, sid, ctx.wt, rel, abs);
    feedback(
      [
        `agentclaim: ${rel} was merged, not overwritten.`,
        'Another agent had edited this file; your write has been combined with',
        'their changes. Re-read the file before continuing — it now contains both.',
      ].join('\n')
    );
  } catch {}
}
