<div align="center">

# agentclaim

**Multiple agents. One working tree. Git won't save you.**

File ownership for parallel AI coding agents — so they stop silently overwriting each other.

[![node](https://img.shields.io/badge/node-%E2%89%A518-0b7285)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-0b7285)](package.json)
[![license](https://img.shields.io/badge/license-MIT-0b7285)](LICENSE)

```bash
npx github:volkangunay/agentclaim init
```

</div>

---

## The problem

You run two, three, five coding agents at once. They share **one working tree**.

Git was built for people on separate clones merging later. It has no idea what to do
with two writers editing the same checkout at the same second. There is no conflict
marker, no warning, no merge — the second write just wins and the first one is gone.

These are three real incidents from one afternoon in one repo. All three shipped to
production. None of them produced a single error message.

### 1. The staging race

`git add` snapshots a file **as it is at that instant**.

```
 session A            session B
 ─────────            ─────────
                      git add i18n.js Money.jsx   ← snapshots i18n.js v1
 write i18n.js v2
                      git commit                  ← commit contains i18n.js v1
```

The commit shipped a new `Money.jsx` alongside the **old** `i18n.js`. The screen
rendered raw translation keys in production. Git reported success. The follow-up
fix commit fell into the exact same race.

### 2. The destructive restore

```bash
git checkout HEAD -- i18n.js api.demo.js   # session A tidies its tree
git commit -a                              # session B, two seconds later
```

Session B's work was reverted off disk and then committed away. Silently.

### 3. The gate that lied

The deploy script had a dirty-tree guard. It checked the tree **at deploy time**,
not the race **at commit time**. The gate went green, the commit was wrong, and the
deploy faithfully published the wrong commit.

---

## The fix

Before an agent writes a file, it **claims** it. While a claim is live, no other
session can write that file, stage it, commit it, or revert it.

```
⛔ agentclaim: blocked write to web/src/i18n.jsx — another live agent session holds these files:
  web/src/i18n.jsx → "money screen" (claimed 6m ago)

Work on a different file, wait for the owner to release, or take over:
  agentclaim release web/src/i18n.jsx --force
See what is going on:  agentclaim status
```

No server. No daemon. No dependencies. The lock store is a directory inside `.git/`.

---

## Quick start

```bash
npm i -g agentclaim     # or: npx github:volkangunay/agentclaim
cd your-repo
agentclaim init
```

That is it. `init` wires up Claude Code hooks and installs a git `pre-commit` hook
(chaining any existing one). Check it any time:

```console
$ agentclaim status
SESSION          FILES  AGE   LAST SEEN
● money screen       3  6m    2s
  ai visibility      2  22m   14s

FILE                    HELD BY        AGE
web/src/Money.jsx       (you)          6m
web/src/i18n.jsx        (you)          6m
web/src/api.demo.js     ai visibility  22m
```

Give your session a readable name so the other agent's error message means something:

```bash
agentclaim label "money screen"
```

---

## What `init` changes on your machine

Three things. Nothing else.

| What | Where | Undo |
|------|-------|------|
| Hook entries | `.claude/settings.json` (backed up first) | `agentclaim uninstall` |
| A `pre-commit` hook | `.git/hooks/` (an existing hook is chained, never replaced) | `agentclaim uninstall` |
| The claim store | `.git/agentclaim/` — inside `.git`, never committed | delete the directory |

No network calls. No telemetry. No background process. Not a single line of your
code is touched, and nothing new appears in `git status`.

---

## It does nothing when you are alone

**If yours is the only live session in the tree, every gate short-circuits to allow.**
No claims are enforced, no commands are inspected, nothing to bypass.

This is deliberate. A gate people cannot pass is worse than no gate, because they
learn to disable it and then it protects nothing. agentclaim only has teeth in the
exact situation it exists for.

```console
$ agentclaim doctor
...
1 live session(s) · 3 claim(s) · TTL 30m · mode block
single session -> gates inactive (no-op)
```

---

## The four gates

| # | Gate | When | What it stops |
|---|------|------|---------------|
| 1 | **Write** | before `Write` / `Edit` | writing a file another live session holds |
| 2 | **Git** | before a `Bash` command | `git add -A`, `git commit -a`, `git checkout -- x`, `git reset --hard`, `git stash`, `git clean` touching files you do not own |
| 3 | **Commit truth** | after `git commit` | the snapshot race — commit content that does not match disk |
| 4 | **pre-commit** | on any `git commit` | staged files owned by someone else, from *any* tool |

Gate 3 is the one nothing else catches. It re-reads every path in the commit with
`git show <sha>:<path>` and compares it byte-for-byte with the file on disk:

```
agentclaim: ⚠ commit 045d1f7 does NOT match what is on disk:
  web/src/api.demo.js

This is the classic `git add` snapshot race: another session rewrote these
files after you staged them, so the commit captured stale content.
DO NOT DEPLOY. Fix it with:
  git add web/src/api.demo.js && git commit --amend --no-edit
```

It only reports files held by *another* session, so ordinary partial staging
(`git add x`, keep editing `x`, commit) never triggers a false alarm.

---

## Works with any agent

Three integration layers, strongest first. Use as many as apply.

### Claude Code — hooks (strongest)

```bash
agentclaim init            # project-level  (.claude/settings.json)
agentclaim init --global   # every repo     (~/.claude/settings.json)
```

Gates run *before* the write or the command. The agent gets the denial as
feedback and picks a different file on its own.

### Cursor · Windsurf · Codex · Zed · Cline · anything MCP

agentclaim ships an MCP server, so any agent that speaks MCP can join the same
ownership protocol:

```json
{
  "mcpServers": {
    "agentclaim": {
      "command": "agentclaim",
      "args": ["mcp"],
      "env": { "AGENTCLAIM_SESSION": "cursor-1", "AGENTCLAIM_AGENT": "cursor" }
    }
  }
}
```

Tools exposed: `agentclaim_status`, `agentclaim_claim`, `agentclaim_release`,
`agentclaim_check`, `agentclaim_verify_commit`. The descriptions tell the model
when to call them.

### Everything else — the git hook

`agentclaim init` installs a `pre-commit` hook, so aider, a plain `git commit`,
your IDE, or a shell script all hit the same check. Nothing to configure.

For deploy scripts and CI, use the exit-code gate:

```bash
agentclaim check --staged --quiet || exit 1   # anyone else holding staged files?
agentclaim verify HEAD                        # did the commit capture disk?
```

---

## Commands

```
agentclaim init [--global]    wire up the hooks (Claude Code + git pre-commit)
agentclaim status             who holds what
agentclaim who <path>         owner of a single file
agentclaim claim <path...>    claim files            [--note "..."]
agentclaim release <path...>  release files          [--all] [--force]
agentclaim check <path...>    gate for scripts, exit 0/1  [--staged] [--quiet]
agentclaim verify [rev]       compare commit content against disk  [--all]
agentclaim label "<name>"     give this session a readable name
agentclaim gc                 collect stale claims
agentclaim doctor             diagnose the installation
agentclaim uninstall          remove the hooks
agentclaim mcp                run as an MCP server
```

---

## Configuration

Optional `.agentclaim.json` at the repo root:

```json
{
  "ttlMinutes": 30,
  "mode": "block",
  "ignore": ["node_modules/**", "dist/**", "*.lock", "package-lock.json"]
}
```

- **`ttlMinutes`** — a session with no activity for this long is considered gone and
  its claims can be taken over. Every hook invocation refreshes the heartbeat, so an
  active session never expires.
- **`mode`** — `block` (default), `warn` (report but allow), `off`.
- **`ignore`** — never claimed. Keep generated files here; if lockfiles and build
  output get claimed, the gate fires constantly and people start bypassing it.

---

## How it works

```
.git/agentclaim/
  sessions/<id>.json   { sid, label, pid, started, seen, wt }
  claims/<hash>.json   { path, wt, sid, at }
  pass.json            short-lived identity token for the git hook
```

- **Store location** is `git rev-parse --git-common-dir`, so every worktree of the
  repo shares one registry.
- **Claim keys** include the worktree root, because the same relative path in two
  worktrees is two different files on disk. Separate worktrees never block each
  other — worktrees are a legitimate fix for this problem, not something to punish.
- **Atomicity** is `open(..., 'wx')` — O_EXCL. Two simultaneous claims, one winner,
  no race.
- **Liveness** is TTL-based. Hooks fire on every tool call, so `seen` stays fresh
  within seconds; a crashed agent's claims are reclaimable and never wedge the repo.

---

## Limitations

Stated plainly, because a guard you trust wrongly is worse than no guard.

- `git commit --no-verify` skips the git hook layer. The Claude Code layer still catches it.
- Agents without hooks or MCP are invisible **while writing**; they are caught at commit time.
- Command parsing is deliberately not a full shell parser. For `eval` / `sh -c` /
  backticks that touch git, agentclaim refuses **only while another session is live**.
- Two agents that genuinely must edit the same file will be blocked. Use
  `agentclaim release`, or give them separate worktrees.
- Claims are per-machine. Nothing is synchronised across hosts.

---

## Testing

```bash
npm test
```

The suite replays all three real incidents above and asserts each gate with both a
passing and a failing example — a gate that fails to catch its own bug is worse than
no gate, because it inspires trust.

---

## License

MIT
