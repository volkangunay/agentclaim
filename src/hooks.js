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
import { context, gateWrite, gateBash, verifyCommit, verifyMessage, isSolo } from './gates.js';
import { touchSession, dropSession, resolveSid } from './session.js';
import { releaseAllFor, gc } from './store.js';

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

function allow() { process.exit(0); }

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

function warnExit(message) {
  process.stderr.write(`\n${message}\n`);
  process.exit(2); // PostToolUse/warn: surface feedback to the model; the tool already ran
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'str_replace_editor']);

export function runHook(event) {
  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch { allow(); }

  const sid = resolveSid(payload.session_id);
  const cwd = payload.cwd || process.cwd();
  let ctx;
  try { ctx = context({ cwd, sid }); } catch { allow(); } // not a git repo -> stay out

  try { touchSession(ctx.repo, sid, { wt: ctx.wt, cwd, agent: 'claude-code' }); } catch {}

  switch (event) {
    case 'SessionStart': {
      try { gc(ctx.repo, ctx.cfg); } catch {}
      allow();
      break;
    }
    case 'SessionEnd': {
      try { releaseAllFor(ctx.repo, sid); dropSession(ctx.repo, sid); } catch {}
      allow();
      break;
    }
    case 'PreToolUse': {
      const tool = payload.tool_name || '';
      const input = payload.tool_input || {};
      let d = { allow: true };
      if (WRITE_TOOLS.has(tool)) {
        const p = input.file_path || input.notebook_path || input.path;
        if (p) d = gateWrite(ctx, p);
      } else if (tool === 'Bash') {
        d = gateBash(ctx, input.command || '');
      }
      if (!d.allow) denyExit(d.message);
      if (d.warn) warnExit(d.warn);
      allow();
      break;
    }
    case 'PostToolUse': {
      // Gate 3: after the commit lands, compare its content against disk.
      const cmd = (payload.tool_input || {}).command || '';
      if (payload.tool_name !== 'Bash' || !/\bgit\b[\s\S]*\bcommit\b/.test(cmd)) allow();
      if (isSolo(ctx)) allow(); // a lone session cannot race with anyone
      const r = verifyCommit(ctx, 'HEAD');
      if (r.mismatches && r.mismatches.length) warnExit(verifyMessage(r.sha, r.mismatches));
      allow();
      break;
    }
    default:
      allow();
  }
}
