// MCP server — the "any agent" layer.
//
// WHY THIS EXISTS: hooks only exist in Claude Code. But Cursor, Windsurf, Codex,
// Zed, Cline and many others speak MCP. Exposing claim/release/status as MCP
// tools lets an agent with no hook system join the same ownership protocol.
// It is softer than a hook (the agent has to CHOOSE to call the tool), but the
// git pre-commit layer still backstops it.
//
// Transport: line-delimited JSON-RPC 2.0 over stdio. No dependencies.

import readline from 'node:readline';
import { context, verifyCommit } from './gates.js';
import { resolveSid, touchSession, allSessions, isLive, labelOf, readSession } from './session.js';
import { allClaims, tryClaim, releaseClaim, releaseAllFor, readClaim, foreignHeld } from './store.js';
import { relOf, stagedPaths } from './repo.js';
import { age } from './format.js';

const NAME = 'agentclaim';
const DEFAULT_PROTOCOL = '2024-11-05';

const TOOLS = [
  {
    name: 'agentclaim_status',
    description:
      'Show which parallel agent sessions are live in this git working tree and which files each one holds. Call this before starting work to see what is already taken.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agentclaim_claim',
    description:
      'Claim files before editing them, so other parallel agents cannot overwrite your work. Returns which paths were granted and which are held by someone else. If a path is denied, work on a different file instead.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Repo-relative or absolute file paths.' },
        note: { type: 'string', description: 'Optional short note on what you are doing.' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentclaim_release',
    description: 'Release files you no longer need, so other agents can take them. Call this when you finish with a file.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        all: { type: 'boolean', description: 'Release everything this session holds.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agentclaim_check',
    description:
      'Check whether given paths (or the staged set) are held by another live agent session. Call before git add / git commit / deploy.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        staged: { type: 'boolean', description: 'Check the currently staged files instead of explicit paths.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agentclaim_verify_commit',
    description:
      'Verify a commit actually captured what is on disk. Catches the git-add snapshot race, where another agent rewrote a file between your `git add` and your `git commit`, so the commit silently shipped stale content. Call after committing and before deploying.',
    inputSchema: {
      type: 'object',
      properties: { rev: { type: 'string', description: 'Revision, default HEAD.' } },
      additionalProperties: false,
    },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: s }] });

function ctxFor() {
  const sid = resolveSid(process.env.AGENTCLAIM_SESSION || `mcp-${process.pid}`);
  const c = context({ cwd: process.cwd(), sid });
  touchSession(c.repo, sid, { wt: c.wt, cwd: c.cwd, agent: process.env.AGENTCLAIM_AGENT || 'mcp' });
  return c;
}

function toRel(c, list) {
  return (list || []).map((p) => relOf(c.repo, p, c.cwd)).filter(Boolean);
}

function callTool(name, args = {}) {
  const c = ctxFor();
  switch (name) {
    case 'agentclaim_status': {
      const live = allSessions(c.repo).filter((s) => isLive(s, c.cfg));
      const claims = allClaims(c.repo).filter((k) => k.wt === c.wt);
      if (!live.length) return text('No live sessions.');
      const lines = live.map((s) => {
        const held = claims.filter((k) => k.sid === s.sid).map((k) => k.path);
        const me = s.sid === c.sid ? ' (you)' : '';
        return `- ${labelOf(s)}${me}: ${held.length ? held.join(', ') : '(no files)'}`;
      });
      const solo = live.filter((s) => s.sid !== c.sid).length === 0;
      lines.push(solo ? '\nYou are the only live session; gates are inactive.' : '\nParallel sessions active; gates are enforcing.');
      return text(lines.join('\n'));
    }
    case 'agentclaim_claim': {
      const rels = toRel(c, args.paths);
      if (!rels.length) return text('No valid repo-relative paths given.');
      const granted = [], denied = [];
      for (const rel of rels) {
        const r = tryClaim(c.repo, c.cfg, { wt: c.wt, rel, sid: c.sid, note: args.note });
        if (r.ok) granted.push(rel);
        else denied.push(`${rel} (held by "${labelOf(readSession(c.repo, r.owner.sid))}", ${age(r.owner.at)})`);
      }
      const out = [];
      if (granted.length) out.push(`Granted: ${granted.join(', ')}`);
      if (denied.length) out.push(`DENIED — do not edit these, another agent is working on them:\n  ${denied.join('\n  ')}`);
      return text(out.join('\n\n'));
    }
    case 'agentclaim_release': {
      if (args.all) return text(`Released ${releaseAllFor(c.repo, c.sid)} file(s).`);
      const rels = toRel(c, args.paths);
      let n = 0;
      for (const rel of rels) {
        const k = readClaim(c.repo, c.wt, rel);
        if (k && k.sid === c.sid && releaseClaim(c.repo, c.wt, rel)) n++;
      }
      return text(`Released ${n} file(s).`);
    }
    case 'agentclaim_check': {
      const paths = args.staged ? stagedPaths(c.repo) : toRel(c, args.paths);
      const held = foreignHeld(c.repo, c.cfg, { wt: c.wt, sid: c.sid, paths });
      if (!held.length) return text('OK — no conflicts. Safe to proceed.');
      return text(
        `CONFLICT — held by another live session, do not commit or deploy:\n  ${held
          .map((k) => `${k.path} → "${labelOf(readSession(c.repo, k.sid))}"`)
          .join('\n  ')}`
      );
    }
    case 'agentclaim_verify_commit': {
      const r = verifyCommit(c, args.rev || 'HEAD');
      if (r.error) return text(`Error: ${r.error}`);
      if (!r.mismatches.length) return text(`OK — ${r.sha.slice(0, 7)} matches what is on disk.`);
      return text(
        `MISMATCH — ${r.sha.slice(0, 7)} does NOT match disk for:\n  ${r.mismatches.join('\n  ')}\n\n` +
          'Another agent rewrote these between your `git add` and your `git commit`, so the commit ' +
          'captured stale content. DO NOT DEPLOY. Fix with:\n  git add ' +
          `${r.mismatches.join(' ')} && git commit --amend --no-edit`
      );
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function serve() {
  // Exit quietly when the client disconnects; never dump a stack trace.
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });
  process.on('SIGPIPE', () => process.exit(0));

  const rl = readline.createInterface({ input: process.stdin });
  const send = (msg) => {
    try { process.stdout.write(`${JSON.stringify(msg)}\n`); }
    catch (e) { if (e.code === 'EPIPE') process.exit(0); throw e; }
  };
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let req;
    try { req = JSON.parse(s); } catch { continue; }
    const { id, method, params } = req;
    if (id === undefined) continue; // notification: no response expected

    try {
      switch (method) {
        case 'initialize':
          reply(id, {
            protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: NAME, version: '0.1.0' },
          });
          break;
        case 'ping':
          reply(id, {});
          break;
        case 'tools/list':
          reply(id, { tools: TOOLS });
          break;
        case 'tools/call': {
          const { name, arguments: a } = params || {};
          try { reply(id, callTool(name, a || {})); }
          catch (e) { reply(id, { ...text(`agentclaim error: ${e.message}`), isError: true }); }
          break;
        }
        default:
          fail(id, -32601, `method not found: ${method}`);
      }
    } catch (e) {
      fail(id, -32603, e.message);
    }
  }
}
