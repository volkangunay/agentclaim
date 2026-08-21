// Per-session file snapshots: "what this session last saw on disk".
//
// WHY THIS EXISTS: to let two agents work in the same file we must answer
// "what changed since I last looked?" — not "what changed since the last
// commit?". Only the first question isolates the OTHER agent's edits from this
// agent's own. A snapshot is taken whenever a session reads or writes a file.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BYTES = 2 * 1024 * 1024; // do not snapshot huge files
const enc = (s) => Buffer.from(String(s)).toString('base64url');

export function snapDir(repo, sid) {
  return path.join(repo.store, 'snap', enc(sid));
}

function snapPath(repo, sid, wt, rel) {
  const h = crypto.createHash('sha1').update(`${wt}\0${rel}`).digest('hex');
  return path.join(snapDir(repo, sid), h);
}

// Returns the snapshot file path, or null when this session has never seen it.
export function snapFile(repo, sid, wt, rel) {
  const p = snapPath(repo, sid, wt, rel);
  return fs.existsSync(p) ? p : null;
}

export function takeSnapshot(repo, sid, wt, rel, absPath) {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > MAX_BYTES) return false;
    const dir = snapDir(repo, sid);
    fs.mkdirSync(dir, { recursive: true });
    const dst = snapPath(repo, sid, wt, rel);
    const tmp = `${dst}.${process.pid}.tmp`;
    fs.copyFileSync(absPath, tmp);
    fs.renameSync(tmp, dst);
    return true;
  } catch { return false; }
}

export function dropSnapshots(repo, sid) {
  try { fs.rmSync(snapDir(repo, sid), { recursive: true, force: true }); } catch {}
}

// A merge we computed in PreToolUse but cannot inject into the tool call.
//
// The hook output schema documents an `updatedInput` field, but nothing we can
// verify says it applies without also auto-approving the call — and if that
// assumption were wrong the merge would silently not happen and the other
// agent's work would be gone. That is the precise failure this tool exists to
// prevent, so we do not build on it. Instead we stash the merged content here
// and write it ourselves in PostToolUse, using only mechanics we control.
export function pendingPath(repo, sid, wt, rel) {
  const h = crypto.createHash('sha1').update(`${wt}\0${rel}`).digest('hex');
  return path.join(repo.store, 'pending', enc(sid), h);
}

export function writePending(repo, sid, wt, rel, content) {
  const p = pendingPath(repo, sid, wt, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export function takePending(repo, sid, wt, rel) {
  const p = pendingPath(repo, sid, wt, rel);
  try {
    const c = fs.readFileSync(p);
    fs.unlinkSync(p);
    return c;
  } catch { return null; }
}

export function dropPending(repo, sid) {
  try { fs.rmSync(path.join(repo.store, 'pending', enc(sid)), { recursive: true, force: true }); } catch {}
}

export function tmpFile(repo, name, content) {
  const dir = path.join(repo.store, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${process.pid}-${name}`);
  fs.writeFileSync(p, content);
  return p;
}

export function cleanTmp(repo) {
  try { fs.rmSync(path.join(repo.store, 'tmp'), { recursive: true, force: true }); } catch {}
}
