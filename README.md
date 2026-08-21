<div align="center">

# agentclaim

**Multiple agents. One working tree. Git won't save you.**

File ownership for parallel AI coding agents — so they stop silently overwriting each other.

[![npm](https://img.shields.io/npm/v/agentclaim?color=0b7285)](https://www.npmjs.com/package/agentclaim)
[![node](https://img.shields.io/badge/node-%E2%89%A518-0b7285)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-0b7285)](package.json)
[![license](https://img.shields.io/badge/license-MIT-0b7285)](LICENSE)

```bash
npm i -g agentclaim && agentclaim init
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

**Writes get smarter. Commits stay strict.**

Blocking every second writer would be a stop sign, not a solution — and a tool that
blocks work people need to do gets switched off. Two agents in one file are only in
real conflict when they touch the same **region**.

So agentclaim does not ask "who owns this file?" It asks **"what changed since I last
looked at it?"** — the only question that separates the other agent's edits from your
own. Different regions, both agents work. Same lines, one of them stops.

```
agentclaim: src/checkout.ts is also being edited by another agent — your edits do not overlap theirs.
  their lines: 12-19
  your lines:  84-91
Both edits are kept. You may not commit this file until they are done.
```

A whole-file `Write` is not a conflict either — it gets three-way merged with the other
agent's work using `git merge-file`, so both edits land:

```
agentclaim: src/checkout.ts was merged, not overwritten.
Another agent had edited this file; your write has been combined with
their changes. Re-read the file before continuing — it now contains both.
```

### Overlapping lines are still not a stop sign

A targeted edit is surgical: it only applies if its anchor text still exists in the file
as it stands right now. That one property does all the work.

- **anchor still there** → replacing it keeps the other agent's edits, because their
  changes are, by definition, somewhere else in the text
- **anchor gone** → the tool refuses on its own and the agent re-reads

Either way the outcome is already correct, so blocking would cost a round trip and buy
nothing. agentclaim adds context instead:

```
agentclaim: heads up — another agent just changed the same lines of src/checkout.ts.
  their lines: 12-19
  your lines:  14-16

Your edit still applies cleanly on top of their version. This is what
they changed, in case it affects what you were about to do:
  @@ line 12-19 @@
  -  const total = items.length
  +  const total = items.reduce((n, i) => n + i.qty, 0)

Nothing is blocked. You may not commit this file until they are done.
```

### What actually stops an agent

Four things, and only these:

| Stopped | Why |
|---------|-----|
| A **whole-file write** that cannot be three-way merged | There is no correct automatic answer, and one of the two versions would be lost. |
| A **whole-file write** to a file this session has never read | Nothing to merge against; it is a blind overwrite. |
| **Staging or committing** a file another agent is actively editing | Incident #1: this is how one agent ships the other's half-finished work. |
| A **git command we cannot parse** that touches git indirectly (`eval`, `sh -c`) while another session is live | We will not guess about `git reset --hard`. |

Nothing in the edit path stops. That is the point: a tool that interrupts agents doing
ordinary work gets switched off, and then it protects nothing.

### Commits are the strict part

Once two live sessions have touched a file, neither may stage or commit it — because
that is exactly how one agent ships the other's half-finished work. Incident #1 above.

That protection would be a deadlock if it had no exit, so it has three:

| Exit | What it does |
|------|--------------|
| `agentclaim release <path>` | "I am done here." Drops only *your* stake, needs no `--force`, and cannot be used to steal a file. The other agent can commit immediately. |
| do nothing | A session stops blocking a file it has not edited for `touchTtlMinutes` (default 10). Agents run for hours; nobody edits one file for hours. |
| `agentclaim release <path> --force` | Take it over outright. The blunt instrument, still there when you need it. |

Sessions ending or crashing release everything they held, so the tree never stays locked.

No server. No daemon. No dependencies. The store is a directory inside `.git/`.

---

## Quick start

```bash
npm i -g agentclaim
cd your-repo
agentclaim init
```

Prefer not to install globally? `npx agentclaim init` works too — it copies itself to
`~/.agentclaim/lib` first, because hooks must point at a path that still exists tomorrow.

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
| 1 | **Write** | before `Write` / `Edit` | nothing in the edit path — whole-file writes get merged, and only an unmergeable one stops |
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
agentclaim release <path...>  "I am done here"       [--all] [--force to take over]
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
  "touchTtlMinutes": 10,
  "mode": "block",
  "ignore": ["node_modules/**", "dist/**", "*.lock", "package-lock.json"]
}
```

- **`ttlMinutes`** — a session with no activity for this long is considered gone and
  its claims can be taken over. Every hook invocation refreshes the heartbeat, so an
  active session never expires.
- **`touchTtlMinutes`** — how long a session keeps blocking *others* from committing a
  file after its last edit there. Shorter than `ttlMinutes` on purpose: still being
  alive is not the same as still working in this file, and conflating the two is what
  turns protection into deadlock.
- **`mode`** — `block` (default), `warn` (report but allow), `off`.
- **`ignore`** — never claimed. Keep generated files here; if lockfiles and build
  output get claimed, the gate fires constantly and people start bypassing it.

---

## How it works

```
.git/agentclaim/
  sessions/<id>.json   { sid, label, pid, started, seen, wt }
  claims/<hash>.json   { path, wt, sid, at, touchers }
  snap/<sid>/<hash>    what that session last saw on disk
  pending/<sid>/<hash> a merge computed before a write, applied right after it
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
- **Region reasoning** compares your session's snapshot with the file on disk using
  `git diff --no-index -U0`, and merges with `git merge-file`. Everything is git's own
  semantics — the ones you already trust — with no dependency added.
- **Merges are applied by us, not injected.** The hook output schema has an
  `updatedInput` field, but nothing verifiable says it applies without also
  auto-approving the call, and a wrong assumption there would silently drop the other
  agent's work. So the merge is stashed and written right after the tool runs, using
  only mechanics we control.

- **Cost per tool call** is one short-lived node process: ~45 ms working alone, ~83 ms
  when a gate actually has to reason (measured on a 200-file repo). Node startup
  dominates — taking a snapshot after a read adds about 1 ms.
- **Nothing to maintain.** `gc` runs on every session start and removes the claims,
  snapshots and pending merges of sessions that are gone, so nothing accumulates in
  `.git/`.

---

## Limitations

Stated plainly, because a guard you trust wrongly is worse than no guard.

- `git commit --no-verify` skips the git hook layer. The Claude Code layer still catches it.
- Agents without hooks or MCP are invisible **while writing**; they are caught at commit time.
- Command parsing is deliberately not a full shell parser. For `eval` / `sh -c` /
  backticks that touch git, agentclaim refuses **only while another session is live**.
- Region coexistence needs to know what your session last saw, so it only applies to
  files the agent has read or written through its tools. A file changed by some other
  route (a shell `sed`, an external editor) is invisible to that reasoning.
- agentclaim does not understand *meaning*. Two edits can be textually independent and
  still be semantically incoherent together; it tells you the other agent was there, but
  the judgement is yours.
- A clean three-way merge can still be semantically wrong, exactly as it can for humans.
  agentclaim tells you the file was merged so you re-read before relying on it.
- Claims are per-machine. Nothing is synchronised across hosts.

---

## Testing

```bash
npm test
```

32 end-to-end checks. The suite replays all three real incidents above, proves the tool
is a complete no-op for a lone session, and asserts each gate with both a passing and a
failing example — a gate that fails to catch its own bug is worse than no gate, because
it inspires trust.

---

## License

MIT
