// Optional `.agentclaim.json` at the repo root.
//
// Why `ignore` matters: generated files (locks, dist, build output) change in
// every session. If those get claimed too, the gate fires on every command and
// people learn to bypass it. A gate nobody can pass is worse than no gate.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  ttlMinutes: 30,
  // How long a session keeps blocking OTHERS from committing a file after its
  // last edit there. Sessions live for hours; "actively working in this file"
  // does not. Without this, two agents that both touched one file would block
  // each other until one of them exits — a deadlock with no way out.
  touchTtlMinutes: 10,
  mode: 'block', // 'block' | 'warn' | 'off'
  ignore: [
    'node_modules/**', 'dist/**', 'build/**', '.next/**', 'coverage/**',
    '**/*.log', '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.DS_Store',
  ],
};

export function loadConfig(repo) {
  const f = path.join(repo.root, '.agentclaim.json');
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { ...DEFAULTS, ...raw, ignore: raw.ignore ?? DEFAULTS.ignore };
  } catch {
    return { ...DEFAULTS };
  }
}

// Tiny glob matcher: `**`, `*`, `?`. Hand-rolled to keep zero dependencies.
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` optionally swallows leading directories, `**` swallows anything
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function isIgnored(cfg, rel) {
  return (cfg.ignore || []).some((g) => {
    const re = globToRe(g);
    if (re.test(rel)) return true;
    // Make `dist/**` also cover the `dist` directory itself
    return g.endsWith('/**') && globToRe(g.slice(0, -3)).test(rel);
  });
}
