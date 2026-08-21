// Bash command → the set of paths it would affect.
//
// DESIGN DECISION: this is NOT a full shell parser. The goal is to recognise git
// commands that mutate the working tree. For anything we cannot decode:
//   - no other live session in the repo → allow (the tool is a no-op anyway)
//   - another session is live AND the command touches git indirectly → deny
// So the conservative branch only ever engages during genuine parallel work.

const SEPS = new Set(['&&', '||', ';', '|', '&', '\n']);

// Small quote-aware tokenizer. Separators are emitted as their own tokens.
export function tokenize(cmd) {
  const tokens = [];
  let cur = '';
  let quote = null;
  const push = () => { if (cur !== '') { tokens.push(cur); cur = ''; } };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
      continue;
    }
    if (c === '\'' || c === '"') { quote = c; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
    if (c === '\n') { push(); tokens.push('\n'); continue; }
    if (/\s/.test(c)) { push(); continue; }
    if (c === '&' || c === '|' || c === ';') {
      push();
      const two = cmd.slice(i, i + 2);
      if (two === '&&' || two === '||') { tokens.push(two); i++; }
      else tokens.push(c);
      continue;
    }
    cur += c;
  }
  push();
  return tokens;
}

export function segments(cmd) {
  const out = [];
  let cur = [];
  for (const t of tokenize(cmd)) {
    if (SEPS.has(t)) { if (cur.length) out.push(cur); cur = []; }
    else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

// Shell indirection: we cannot see inside, so we cannot decode the command safely.
const INDIRECTION = /(^|[^\w-])(eval|source|xargs)([^\w-]|$)|`|\$\(|\b(sh|bash|zsh|env)\s+(-[a-z]*\s+)*-c\b/;

export function hasIndirection(cmd) {
  return INDIRECTION.test(cmd);
}

export function mentionsGit(cmd) {
  return /(^|[^\w-])git([^\w-]|$)/.test(cmd);
}

function isGitBinary(tok) {
  if (!tok) return false;
  const base = tok.split('/').pop();
  return base === 'git';
}

// Skips global flags between `git` and the subcommand (-C dir, -c k=v, ...).
function subcommandOf(tokens) {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '-C' || t === '-c' || t === '--namespace' || t === '--work-tree' || t === '--git-dir') { i += 2; continue; }
    if (t.startsWith('--')) { i += 1; continue; }
    if (t.startsWith('-')) { i += 1; continue; }
    return { sub: t, rest: tokens.slice(i + 1) };
  }
  return { sub: null, rest: [] };
}

// Flags that take a value. Without this table we mistake the MESSAGE of
// `git commit -m "msg"` for a path — exactly what the first test run caught.
// Flags whose value only attaches with `=` (`-S`, `--gpg-sign`) are DELIBERATELY
// absent, so they do not swallow the following token and skip a real flag.
const VALUE_FLAGS = {
  commit: {
    long: new Set(['--message', '--file', '--reuse-message', '--reedit-message',
      '--author', '--date', '--cleanup', '--fixup', '--squash', '--template',
      '--trailer', '--pathspec-from-file']),
    short: new Set(['m', 'F', 'C', 'c', 't']),
  },
  add: { long: new Set(['--chmod', '--pathspec-from-file']), short: new Set() },
  checkout: { long: new Set(['--conflict', '--orphan', '--pathspec-from-file', '--source']), short: new Set(['b', 'B', 's']) },
  restore: { long: new Set(['--source', '--conflict', '--pathspec-from-file']), short: new Set(['s']) },
  reset: { long: new Set(['--pathspec-from-file']), short: new Set() },
  clean: { long: new Set(['--exclude']), short: new Set(['e']) },
  stash: { long: new Set(['--message']), short: new Set(['m']) },
  rm: { long: new Set(['--pathspec-from-file']), short: new Set() },
  mv: { long: new Set(), short: new Set() },
};

// Strips flags AND flag values, leaving path candidates.
// Everything after `--` is unconditionally a path.
function argPaths(rest, sub) {
  const spec = VALUE_FLAGS[sub] || { long: new Set(), short: new Set() };
  const paths = [];
  let afterDD = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (afterDD) { paths.push(t); continue; }
    if (t === '--') { afterDD = true; continue; }
    if (t.startsWith('--')) {
      if (!t.includes('=') && spec.long.has(t)) i++; // value is the next token
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      const letters = t.slice(1);
      for (let j = 0; j < letters.length; j++) {
        if (!spec.short.has(letters[j])) continue;
        // Last letter of the cluster: value is the next token. Otherwise inline (-mfix).
        if (j === letters.length - 1) i++;
        break;
      }
      continue;
    }
    paths.push(t);
  }
  return paths;
}

const ALL = 'ALL_DIRTY';
const STAGED = 'STAGED';
const TRACKED = 'TRACKED_MODIFIED';

/**
  * Classify a single command segment.
  * @returns {null | {op: string, scope: 'ALL_DIRTY'|'STAGED'|'TRACKED_MODIFIED', paths?: string[]}}
  *          null = does not mutate the working tree, not our business.
  */
export function classify(tokens) {
  if (!tokens.length) return null;
  // Skip prefixes such as `env FOO=1 git ...`
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (!isGitBinary(tokens[i])) return null;

  const { sub, rest } = subcommandOf(tokens.slice(i));
  if (!sub) return null;
  const has = (...f) => rest.some((t) => f.includes(t));
  const paths = argPaths(rest, sub);

  switch (sub) {
    case 'add': {
      if (has('-A', '--all', '-u', '--update') || paths.includes('.') || paths.includes(':/'))
        return { op: 'git add (bulk)', scope: ALL };
      if (!paths.length) return null;
      return { op: 'git add', scope: ALL, paths };
    }
    case 'commit': {
      if (has('-a', '--all', '-am', '-am')) return { op: 'git commit -a', scope: TRACKED };
      if (rest.some((t) => t.startsWith('-a') && !t.startsWith('--') && /^-[a-z]*a[a-z]*$/.test(t)))
        return { op: 'git commit -a', scope: TRACKED };
      if (paths.length) return { op: 'git commit <path>', scope: ALL, paths };
      return { op: 'git commit', scope: STAGED };
    }
    case 'checkout':
    case 'restore': {
      // We care about the restore-a-file form, not branch switching.
      if (paths.includes('.')) return { op: `git ${sub} .`, scope: ALL };
      const dd = rest.indexOf('--');
      if (sub === 'restore' || dd !== -1) {
        const p = dd !== -1 ? argPaths(rest.slice(dd), sub) : paths;
        if (p.length) return { op: `git ${sub}`, scope: ALL, paths: p };
      }
      return null;
    }
    case 'reset':
      if (has('--hard')) return { op: 'git reset --hard', scope: ALL };
      return null;
    case 'stash': {
      const verb = paths[0] || 'push';
      if (['list', 'show'].includes(verb)) return null;
      return { op: `git stash ${verb}`, scope: ALL };
    }
    case 'clean':
      if (has('-f', '--force', '-fd', '-df', '-fdx', '-xdf')) return { op: 'git clean', scope: ALL };
      return null;
    case 'rm':
    case 'mv':
      if (paths.length) return { op: `git ${sub}`, scope: ALL, paths };
      return null;
    default:
      return null;
  }
}

export function analyze(cmd) {
  return segments(cmd).map(classify).filter(Boolean);
}
