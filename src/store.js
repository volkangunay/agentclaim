// The claim store: filesystem-backed, serverless, atomic.
//
// Key = sha1(worktreeRoot + NUL + relativePath).
// The worktree is part of the key because the same relative path in two
// worktrees is TWO DIFFERENT FILES ON DISK. Treating them as a conflict would be
// a pure false positive — and worktrees are the recommended fix for this whole
// problem, so we must not penalise them.
//
// Atomicity comes from the `wx` flag (O_EXCL): create only if absent. If two
// sessions claim at the same instant the kernel picks a winner; no race.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isLive, readSession } from './session.js';

export function claimsDir(repo) { return path.join(repo.store, 'claims'); }

export function claimKey(wt, rel) {
  return crypto.createHash('sha1').update(`${wt}\0${rel}`).digest('hex');
}

function claimFile(repo, wt, rel) {
  return path.join(claimsDir(repo), `${claimKey(wt, rel)}.json`);
}

export function readClaim(repo, wt, rel) {
  try { return JSON.parse(fs.readFileSync(claimFile(repo, wt, rel), 'utf8')); }
  catch { return null; }
}

export function allClaims(repo) {
  let names = [];
  try { names = fs.readdirSync(claimsDir(repo)); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(claimsDir(repo), n), 'utf8'))); }
    catch {}
  }
  return out;
}

function writeClaim(repo, rec, { exclusive }) {
  fs.mkdirSync(claimsDir(repo), { recursive: true });
  const f = claimFile(repo, rec.wt, rec.path);
  if (exclusive) {
    fs.writeFileSync(f, JSON.stringify(rec), { flag: 'wx' }); // O_EXCL
  } else {
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, f);
  }
}

// Is the owner still valid? If its session died, the claim can be taken over.
export function ownerAlive(repo, cfg, claim) {
  if (!claim) return false;
  const s = readSession(repo, claim.sid);
  return isLive(s, cfg);
}

/**
  * Try to claim a file for this session.
  * @returns {{ok: true, claim} | {ok: false, owner}}
  */
export function tryClaim(repo, cfg, { wt, rel, sid, note }) {
  const rec = {
    path: rel, wt, sid, at: Date.now(), seen: Date.now(), note: note || null,
    touchers: { [sid]: Date.now() },
  };
  try {
    writeClaim(repo, rec, { exclusive: true });
    return { ok: true, claim: rec };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const cur = readClaim(repo, wt, rel);
  if (!cur) {
    // Deleted in a race between our attempts; try once more.
    try { writeClaim(repo, rec, { exclusive: true }); return { ok: true, claim: rec }; }
    catch { return { ok: false, owner: readClaim(repo, wt, rel) }; }
  }
  if (cur.sid === sid) {
    cur.seen = Date.now();
    cur.touchers = { ...(cur.touchers || {}), [sid]: Date.now() };
    if (note) cur.note = note;
    writeClaim(repo, cur, { exclusive: false });
    return { ok: true, claim: cur };
  }
  if (!ownerAlive(repo, cfg, cur)) {
    // Stale: the owner is dead or long silent. Take over.
    rec.tookOverFrom = cur.sid;
    writeClaim(repo, rec, { exclusive: false });
    return { ok: true, claim: rec };
  }
  return { ok: false, owner: cur };
}

export function releaseClaim(repo, wt, rel) {
  try { fs.unlinkSync(claimFile(repo, wt, rel)); return true; } catch { return false; }
}

export function releaseAllFor(repo, sid) {
  let n = 0;
  for (const c of allClaims(repo)) {
    if (c.sid === sid && releaseClaim(repo, c.wt, c.path)) n++;
  }
  return n;
}

// Collect claims whose owner is gone, plus stale session records.
export function gc(repo, cfg) {
  let claims = 0, sessions = 0;
  for (const c of allClaims(repo)) {
    if (!ownerAlive(repo, cfg, c) && releaseClaim(repo, c.wt, c.path)) claims++;
  }
  let names = [];
  try { names = fs.readdirSync(path.join(repo.store, 'sessions')); } catch {}
  for (const n of names) {
    const f = path.join(repo.store, 'sessions', n);
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!isLive(s, cfg)) { fs.unlinkSync(f); sessions++; }
    } catch { try { fs.unlinkSync(f); sessions++; } catch {} }
  }
  return { claims, sessions };
}

// Record that a session edited a file it does not own. Once two live sessions
// have touched the same file, NEITHER may commit it until the other is done —
// otherwise one of them commits the other's half-finished work, which is
// incident #1 all over again. Writes get smarter; commits stay strict.
export function addToucher(repo, cfg, { wt, rel, sid }) {
  const cur = readClaim(repo, wt, rel);
  if (!cur) return tryClaim(repo, cfg, { wt, rel, sid });
  cur.touchers = { ...(cur.touchers || { [cur.sid]: cur.at }), [sid]: Date.now() };
  cur.seen = Date.now();
  writeClaim(repo, cur, { exclusive: false });
  return { ok: true, claim: cur };
}

// Every live session that has touched this file, other than `sid`.
export function otherLiveTouchers(repo, cfg, claim, sid) {
  if (!claim) return [];
  const ids = new Set(Object.keys(claim.touchers || {}));
  ids.add(claim.sid);
  return [...ids].filter((id) => id !== sid && isLive(readSession(repo, id), cfg));
}

// Of the given paths, the ones another live session has a stake in.
export function foreignHeld(repo, cfg, { wt, sid, paths }) {
  const out = [];
  for (const rel of paths) {
    const c = readClaim(repo, wt, rel);
    if (c && otherLiveTouchers(repo, cfg, c, sid).length) out.push(c);
  }
  return out;
}

// ── Pass token ───────────────────────────────────────────────────────────────
// PROBLEM: the git `pre-commit` hook runs in a SEPARATE process and cannot know
// which session started the command. Without an identity it treats every claim
// as foreign and blocks the session's OWN commit.
// SOLUTION: when Gate 2 approves a commit it drops a short-lived token; the git
// hook reads the identity from it. The token is short-lived on purpose — it
// means "just approved", not a transfer of identity.
export function writePass(repo, sid) {
  try {
    fs.mkdirSync(repo.store, { recursive: true });
    fs.writeFileSync(path.join(repo.store, 'pass.json'), JSON.stringify({ sid, at: Date.now() }));
  } catch {}
}

export function readPass(repo, maxAgeMs = 120000) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(repo.store, 'pass.json'), 'utf8'));
    if (Date.now() - p.at <= maxAgeMs) return p.sid;
  } catch {}
  return null;
}
