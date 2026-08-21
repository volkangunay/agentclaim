// Session records, heartbeats and liveness.
//
// WHY LIVENESS IS TTL-ONLY: hooks are launched through a shell, so the ppid we
// can observe is often an intermediate shell that exits immediately — a pid is
// not a reliable anchor. A hook, however, fires on EVERY tool use, so `seen` is
// refreshed within seconds in an active session. A session past its TTL is
// either dead or long idle; in both cases handing its claims over is the right
// call. Clean shutdown is additionally handled by the SessionEnd hook.
// The pid is kept for diagnostics and display only.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const enc = (s) => Buffer.from(s).toString('base64url');

export function sessionsDir(repo) { return path.join(repo.store, 'sessions'); }

export function resolveSid(explicit) {
  return (
    explicit ||
    process.env.AGENTCLAIM_SESSION ||
    `local-${process.ppid}`
  );
}

function sessionFile(repo, sid) {
  return path.join(sessionsDir(repo), `${enc(sid)}.json`);
}

export function readSession(repo, sid) {
  try { return JSON.parse(fs.readFileSync(sessionFile(repo, sid), 'utf8')); }
  catch { return null; }
}

// Heartbeat. Called on every hook invocation and every CLI command.
export function touchSession(repo, sid, patch = {}) {
  fs.mkdirSync(sessionsDir(repo), { recursive: true });
  const prev = readSession(repo, sid) || {
    sid,
    started: Date.now(),
    label: null,
    agent: process.env.AGENTCLAIM_AGENT || null,
    host: os.hostname(),
  };
  const rec = { ...prev, ...patch, sid, pid: process.ppid, seen: Date.now() };
  const f = sessionFile(repo, sid);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, f); // atomic replace
  return rec;
}

export function dropSession(repo, sid) {
  try { fs.unlinkSync(sessionFile(repo, sid)); } catch {}
}

export function allSessions(repo) {
  let names = [];
  try { names = fs.readdirSync(sessionsDir(repo)); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(sessionsDir(repo), n), 'utf8')));
    } catch {}
  }
  return out;
}

export function isLive(rec, cfg, now = Date.now()) {
  if (!rec || typeof rec.seen !== 'number') return false;
  return now - rec.seen <= cfg.ttlMinutes * 60 * 1000;
}

// Is any session OTHER than this one live in this worktree?
// If not, the tool is a complete no-op: no gate ever fires.
export function foreignLiveSessions(repo, cfg, sid, wt) {
  return allSessions(repo).filter(
    (s) => s.sid !== sid && s.wt === wt && isLive(s, cfg)
  );
}

// A name a human can tell apart from the other one.
//
// Falling back to the agent name alone was useless in the one place this matters:
// with two Claude Code sessions, `status` printed "claude-code" twice and you
// could not tell which was which. Always keep something session-unique unless
// the user gave the session a real name.
export function labelOf(rec) {
  if (!rec) return '?';
  if (rec.label) return rec.label;
  const short = String(rec.sid).replace(/[^A-Za-z0-9]/g, '').slice(-6) || String(rec.sid).slice(0, 6);
  return rec.agent ? `${rec.agent}:${short}` : short;
}
