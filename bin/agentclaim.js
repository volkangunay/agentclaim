#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRepo, relOf, stagedPaths, NotARepo } from '../src/repo.js';
import { loadConfig, isIgnored } from '../src/config.js';
import {
  resolveSid, touchSession, allSessions, isLive, labelOf, dropSession, readSession,
} from '../src/session.js';
import {
  allClaims, tryClaim, releaseClaim, releaseAllFor, gc, foreignHeld, readClaim, readPass,
  stepOut, activeOtherTouchers,
} from '../src/store.js';
import { context, verifyCommit, verifyMessage, isSolo } from '../src/gates.js';
import { runHook } from '../src/hooks.js';
import {
  installClaudeHooks, installGitHook, detectOtherHookManagers, isEphemeral,
  ensureStableInstall, hookCommand,
} from '../src/install.js';
import * as installer from '../src/install.js';
import { table, age, bold, dim, red, green, yellow, cyan } from '../src/format.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : d; };
const positionals = () => {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { if (['session', 'note', 'm'].includes(a.slice(2))) i++; continue; }
    out.push(a);
  }
  return out;
};

const die = (msg, code = 1) => { console.error(red(msg)); process.exit(code); };

function ctx() {
  try { return context({ cwd: process.cwd(), sid: resolveSid(opt('session')) }); }
  catch (e) {
    if (e instanceof NotARepo) die('agentclaim: not inside a git repository.');
    throw e;
  }
}

const HELP = `
${bold('agentclaim')} — file ownership for parallel AI agents
${dim('multiple agents, one working tree. git will not save you.')}

  ${bold('agentclaim init')} [--global]    wire up the hooks (Claude Code + git pre-commit)
  ${bold('agentclaim status')}             who holds what
  ${bold('agentclaim who')} <path>         owner of a single file
  ${bold('agentclaim claim')} <path...>    claim files            [--note "..."]
  ${bold('agentclaim release')} <path...>  release files          [--all] [--force]
  ${bold('agentclaim check')} <path...>    gate for scripts, exit 0/1  [--staged] [--quiet]
  ${bold('agentclaim verify')} [rev]       compare commit content against disk  [--all]
  ${bold('agentclaim label')} "<name>"     give this session a readable name
  ${bold('agentclaim gc')}                 collect stale claims
  ${bold('agentclaim doctor')}             diagnose the installation
  ${bold('agentclaim uninstall')}          remove the hooks
  ${bold('agentclaim mcp')}                run as an MCP server (for any agent)

Session identity: --session, else $AGENTCLAIM_SESSION, else the shell pid.
`;

function cmdInit() {
  const c = ctx();
  // Running from the npx cache? Copy ourselves somewhere permanent first, so the
  // hook commands we are about to write keep working after npm evicts the cache.
  const moved = ensureStableInstall();
  if (moved.moved) console.log(`${green('✓')} installed to  ${dim(moved.dest)}`);
  const settings = flag('global')
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(c.repo.root, '.claude', 'settings.json');

  let wrote;
  try { wrote = installClaudeHooks(settings); }
  catch (e) { die(`agentclaim: ${e.message}`); }
  console.log(`${green('✓')} Claude Code hooks wired  ${dim(wrote)}`);

  const gh = installGitHook(c.repo);
  console.log(`${green('✓')} git pre-commit installed  ${dim(gh.path)}${gh.chained ? dim('  (existing hook chained)') : ''}`);

  const others = detectOtherHookManagers(c.repo);
  if (others.length) {
    console.log(yellow(`⚠ Another hook manager is present: ${others.join(', ')}`));
    console.log(dim('  If it also owns pre-commit, add this to its own config:'));
    console.log(dim(`    node "${installer.BIN}" check --staged --quiet`));
  }
  console.log(`\n${dim('Try:')} agentclaim status`);
}

function cmdUninstall() {
  const c = ctx();
  for (const p of [
    path.join(c.repo.root, '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ]) {
    if (!fs.existsSync(p)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!cfg.hooks) continue;
      let changed = false;
      for (const ev of Object.keys(cfg.hooks)) {
        const before = cfg.hooks[ev].length;
        cfg.hooks[ev] = cfg.hooks[ev].filter(
          (e) => !(e.hooks || []).some((h) => String(h.command).includes('agentclaim'))
        );
        if (cfg.hooks[ev].length !== before) changed = true;
        if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
      }
      if (changed) {
        fs.writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
        console.log(`${green('✓')} hooks removed  ${dim(p)}`);
      }
    } catch {}
  }
  const hook = path.join(c.repo.commonDir, 'hooks', 'pre-commit');
  const local = path.join(c.repo.commonDir, 'hooks', 'pre-commit.local');
  if (fs.existsSync(hook) && fs.readFileSync(hook, 'utf8').includes('agentclaim')) {
    fs.unlinkSync(hook);
    if (fs.existsSync(local)) { fs.renameSync(local, hook); console.log(`${green('✓')} previous pre-commit restored`); }
    else console.log(`${green('✓')} git pre-commit removed`);
  }
}

function cmdStatus() {
  const c = ctx();
  touchSession(c.repo, c.sid, { wt: c.wt, cwd: c.cwd });
  const claims = allClaims(c.repo);
  const sessions = allSessions(c.repo).filter((s) => isLive(s, c.cfg));

  if (!sessions.length) { console.log(dim('no live sessions')); return; }

  const rows = sessions.map((s) => {
    const held = claims.filter((k) => k.sid === s.sid);
    const wtName = s.wt === c.wt ? '' : path.basename(s.wt || '');
    return [
      (s.sid === c.sid ? `${cyan('●')} ` : '  ') + labelOf(s) + (wtName ? dim(` [${wtName}]`) : ''),
      held.length,
      age(s.started || s.seen),
      dim(age(s.seen)),
    ];
  });
  console.log(table(['SESSION', 'FILES', 'AGE', 'LAST SEEN'], rows));

  const mine = claims.filter((k) => k.wt === c.wt);
  if (mine.length) {
    console.log('');
    const detail = mine
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((k) => {
        const s = readSession(c.repo, k.sid);
        const own = k.sid === c.sid;
        return [own ? green(k.path) : k.path, own ? dim('(you)') : labelOf(s), dim(age(k.at))];
      });
    console.log(table(['FILE', 'HELD BY', 'AGE'], detail));
  }
  if (isSolo(c)) console.log(`\n${dim('only one live session -> gates inactive (tool is a no-op)')}`);
}

function cmdWho() {
  const c = ctx();
  const p = positionals()[0];
  if (!p) die('usage: agentclaim who <path>');
  const rel = relOf(c.repo, p, c.cwd);
  if (!rel) die('that path is outside the repository.');
  const k = readClaim(c.repo, c.wt, rel);
  if (!k) { console.log(dim(`${rel} — unclaimed`)); return; }
  const s = readSession(c.repo, k.sid);
  const live = isLive(s, c.cfg);
  console.log(`${rel} → ${labelOf(s)} ${live ? green('(live)') : yellow('(stale, can be taken over)')} ${dim(age(k.at))}`);
}

function cmdClaim() {
  const c = ctx();
  touchSession(c.repo, c.sid, { wt: c.wt, cwd: c.cwd });
  const ps = positionals();
  if (!ps.length) die('usage: agentclaim claim <path...>');
  let bad = 0;
  for (const p of ps) {
    const rel = relOf(c.repo, p, c.cwd);
    if (!rel) { console.log(yellow(`skipped (outside repo): ${p}`)); continue; }
    const r = tryClaim(c.repo, c.cfg, { wt: c.wt, rel, sid: c.sid, note: opt('note') });
    if (r.ok) console.log(`${green('✓')} ${rel}`);
    else { bad++; console.log(`${red('✗')} ${rel} — held by: ${labelOf(readSession(c.repo, r.owner.sid))}`); }
  }
  process.exit(bad ? 1 : 0);
}

function cmdRelease() {
  const c = ctx();
  if (flag('all')) {
    const n = releaseAllFor(c.repo, opt('session') || c.sid);
    console.log(`${green('✓')} stepped out of ${n} file(s)`);
    return;
  }
  const ps = positionals();
  if (!ps.length) die('usage: agentclaim release <path...> | --all');
  for (const p of ps) {
    const rel = relOf(c.repo, p, c.cwd);
    if (!rel) continue;
    const k = readClaim(c.repo, c.wt, rel);
    if (!k) { console.log(dim(`${rel} — already unclaimed`)); continue; }
    if (flag('force')) {
      // Take it over outright: drops everyone's stake, including theirs.
      releaseClaim(c.repo, c.wt, rel);
      console.log(`${green('✓')} took over ${rel}`);
      continue;
    }
    // Default is "I am done here" — it never destroys another session's stake,
    // so it needs no --force and cannot be used to steal a file.
    const r = stepOut(c.repo, c.wt, rel, c.sid);
    if (r.gone) console.log(`${green('✓')} released ${rel}`);
    else console.log(`${green('✓')} stepped out of ${rel} ${dim(`(now with ${labelOf(readSession(c.repo, r.newOwner))})`)}`);
  }
}

// The gate for scripts, and the command the git pre-commit hook calls.
function cmdCheck() {
  const c = ctx();
  let sid = c.sid;
  // The git hook runs in a separate process; recover identity from Gate 2's token.
  if (flag('staged')) sid = process.env.AGENTCLAIM_SESSION || readPass(c.repo) || c.sid;

  const paths = flag('staged')
    ? stagedPaths(c.repo)
    : positionals().map((p) => relOf(c.repo, p, c.cwd)).filter(Boolean);

  const checked = paths.filter((p) => !isIgnored(c.cfg, p));
  const held = foreignHeld(c.repo, c.cfg, { wt: c.wt, sid, paths: checked });
  if (!held.length) { if (!flag('quiet')) console.log(green('✓ no conflicts')); process.exit(0); }

  console.error(red('\n⛔ agentclaim: these files are held by another live session:'));
  for (const k of held) console.error(`   ${k.path} → ${labelOf(readSession(c.repo, k.sid))} ${dim(age(k.at))}`);
  console.error(dim('\n   agentclaim status                   # who holds what'));
  console.error(dim('   agentclaim release <path> --force   # take over\n'));
  process.exit(1);
}

function cmdVerify() {
  const c = ctx();
  const rev = positionals()[0] || 'HEAD';
  const r = verifyCommit(c, rev, { onlyForeign: !flag('all') });
  if (r.error) die(`agentclaim: ${r.error}`);
  if (!r.mismatches.length) { console.log(`${green('✓')} ${r.sha.slice(0, 7)} — commit matches what is on disk`); return; }
  console.error(red(verifyMessage(r.sha, r.mismatches)));
  process.exit(1);
}

function cmdLabel() {
  const c = ctx();
  const name = positionals().join(' ');
  if (!name) die('usage: agentclaim label "money screen"');
  touchSession(c.repo, c.sid, { wt: c.wt, cwd: c.cwd, label: name });
  console.log(`${green('✓')} this session is now: ${bold(name)}`);
}

function cmdGc() {
  const c = ctx();
  const r = gc(c.repo, c.cfg);
  console.log(`${green('✓')} collected ${r.claims} stale claim(s), ${r.sessions} stale session(s), ${r.files} leftover file(s)`);
}

function cmdDoctor() {
  const c = ctx();
  const ok = (b) => (b ? green('✓') : red('✗'));
  console.log(bold('\nagentclaim doctor\n'));
  console.log(`${ok(true)} repo root       ${dim(c.repo.root)}`);
  console.log(`${ok(true)} git common dir  ${dim(c.repo.commonDir)}`);
  console.log(`${ok(fs.existsSync(installer.BIN))} executable      ${dim(installer.BIN)}`);
  if (isEphemeral()) console.log(yellow('  ⚠ running from the npx cache — run `agentclaim init` to install permanently'));

  const scopes = [
    ['project hooks', path.join(c.repo.root, '.claude', 'settings.json')],
    ['global hooks ', path.join(os.homedir(), '.claude', 'settings.json')],
  ].map(([label, p]) => {
    let wired = false;
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      wired = Object.values(cfg.hooks || {}).some((l) =>
        l.some((e) => (e.hooks || []).some((h) => String(h.command).includes('agentclaim'))));
    } catch {}
    return { label, p, wired };
  });
  // Either scope is enough. Marking the unused one with a red x would read as a
  // failure when nothing is actually wrong.
  const anyWired = scopes.some((x) => x.wired);
  for (const { label, p, wired } of scopes) {
    const mark = wired ? green('✓') : anyWired ? dim('–') : red('✗');
    const note = wired ? '' : dim(anyWired ? '  (not used)' : '  (not installed — run: agentclaim init)');
    console.log(`${mark} ${label}    ${dim(p)}${note}`);
  }

  const hook = path.join(c.repo.commonDir, 'hooks', 'pre-commit');
  const hookOk = fs.existsSync(hook) && fs.readFileSync(hook, 'utf8').includes('agentclaim');
  console.log(`${ok(hookOk)} git pre-commit  ${dim(hook)}`);

  const live = allSessions(c.repo).filter((s) => isLive(s, c.cfg));
  console.log(`\n${live.length} live session(s) · ${allClaims(c.repo).length} claim(s) · TTL ${c.cfg.ttlMinutes}m · mode ${c.cfg.mode}`);
  console.log(
    live.length > 1
      ? yellow('parallel sessions -> gates enforcing\n')
      : dim('fewer than two live sessions -> gates inactive (no-op)\n')
  );
}

try {
  switch (cmd) {
    case 'init': cmdInit(); break;
    case 'uninstall': cmdUninstall(); break;
    case 'status': cmdStatus(); break;
    case 'who': cmdWho(); break;
    case 'claim': cmdClaim(); break;
    case 'release': cmdRelease(); break;
    case 'check': cmdCheck(); break;
    case 'verify': cmdVerify(); break;
    case 'label': cmdLabel(); break;
    case 'gc': cmdGc(); break;
    case 'doctor': cmdDoctor(); break;
    case 'hook': runHook(argv[1]); break;
    case 'mcp': { const m = await import('../src/mcp.js'); await m.serve(); break; }
    case 'version': case '--version': case '-v':
      console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version); break;
    default: console.log(HELP);
  }
} catch (e) {
  if (cmd === 'hook') process.exit(0);   // a hook must never break the session
  die(`agentclaim: ${e.message}`);
}
