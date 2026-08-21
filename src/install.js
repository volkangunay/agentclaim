// `agentclaim init` — wires up the hooks. Idempotent: running it twice is harmless.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.resolve(HERE, '..', 'bin', 'agentclaim.js');

const MATCH_PRE = 'Write|Edit|MultiEdit|NotebookEdit|Bash';

export function hookCommand(event) {
  return `node "${BIN}" hook ${event}`;
}

// If we run from npx's throwaway cache, the path we write will not exist tomorrow.
export function isEphemeral() {
  return /[/\\](_npx|\.npm[/\\]_npx)[/\\]/.test(BIN);
}

function entriesFor() {
  const mk = (event, matcher) => {
    const e = { hooks: [{ type: 'command', command: hookCommand(event) }] };
    if (matcher) e.matcher = matcher;
    return e;
  };
  return {
    PreToolUse: mk('PreToolUse', MATCH_PRE),
    PostToolUse: mk('PostToolUse', 'Bash'),
    SessionStart: mk('SessionStart', null),
    SessionEnd: mk('SessionEnd', null),
  };
}

const isOurs = (entry) =>
  (entry.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('agentclaim'));

export function installClaudeHooks(settingsPath) {
  let cfg = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    try { cfg = JSON.parse(raw); }
    catch { throw new Error(`${settingsPath} is not valid JSON; fix it by hand, refusing to overwrite.`); }
    // Back it up before touching it — the user's settings file is sacred.
    fs.writeFileSync(`${settingsPath}.agentclaim-backup`, raw);
  } else {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  }

  cfg.hooks = cfg.hooks || {};
  const wanted = entriesFor();
  for (const [event, entry] of Object.entries(wanted)) {
    const list = Array.isArray(cfg.hooks[event]) ? cfg.hooks[event] : [];
    const kept = list.filter((e) => !isOurs(e));   // replace any previous agentclaim entry
    kept.push(entry);
    cfg.hooks[event] = kept;
  }
  fs.writeFileSync(settingsPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return settingsPath;
}

const PRE_COMMIT = `#!/bin/sh
# agentclaim — the universal net (covers every tool, not just Claude Code).
# Stops a commit that includes files this session does NOT own.
# To remove: agentclaim uninstall  (or just delete this file)
if command -v node >/dev/null 2>&1; then
  node "__BIN__" check --staged --quiet || exit 1
fi
__CHAIN__
`;

export function installGitHook(repo) {
  const dir = path.join(repo.commonDir, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'pre-commit');
  let chain = '';

  if (fs.existsSync(target)) {
    const cur = fs.readFileSync(target, 'utf8');
    if (cur.includes('agentclaim')) {
      // already ours; preserve the chained-hook line
      const m = cur.match(/^exec "(.+pre-commit\.local)".*$/m);
      chain = m ? `exec "${m[1]}" "$@"` : '';
    } else {
      const moved = path.join(dir, 'pre-commit.local');
      fs.renameSync(target, moved);
      chain = `exec "${moved}" "$@"`;
    }
  }

  fs.writeFileSync(target, PRE_COMMIT.replace('__BIN__', BIN).replace('__CHAIN__', chain));
  fs.chmodSync(target, 0o755);
  return { path: target, chained: Boolean(chain) };
}

export function detectOtherHookManagers(repo) {
  const found = [];
  if (fs.existsSync(path.join(repo.root, '.husky'))) found.push('husky (.husky/)');
  for (const f of ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml']) {
    if (fs.existsSync(path.join(repo.root, f))) found.push(`lefthook (${f})`);
  }
  if (fs.existsSync(path.join(repo.root, '.pre-commit-config.yaml'))) found.push('pre-commit (python)');
  return found;
}
