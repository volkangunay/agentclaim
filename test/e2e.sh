#!/usr/bin/env bash
# agentclaim end-to-end test.
#
# Every scenario here comes from an incident that ACTUALLY HAPPENED (see README).
# RULE: each gate is tested with both a passing and a failing example. A gate
# that fails to catch its own bug is worse than no gate, because it inspires trust.

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $ROOT/bin/agentclaim.js"
T="${TMPDIR:-/tmp}/agentclaim-e2e-$$"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# hook <event> <session> <json-tool-payload>  -> returns the exit code
hook() {
  local ev="$1" sid="$2" payload="$3"
  printf '%s' "$payload" | sed "s|__SID__|$sid|; s|__CWD__|$T|" \
    | node "$ROOT/bin/agentclaim.js" hook "$ev" >/dev/null 2>&1
}
write_payload() { printf '{"session_id":"__SID__","cwd":"__CWD__","tool_name":"Write","tool_input":{"file_path":"%s"}}' "$1"; }
read_payload()  { printf '{"session_id":"__SID__","cwd":"__CWD__","tool_name":"Read","tool_input":{"file_path":"%s"}}' "$1"; }
edit_payload()  { printf '{"session_id":"__SID__","cwd":"__CWD__","tool_name":"Edit","tool_input":{"file_path":"%s","old_string":"%s","new_string":"x"}}' "$1" "$2"; }
hook_err() {
  local ev="$1" sid="$2" payload="$3"
  printf '%s' "$payload" | sed "s|__SID__|$sid|; s|__CWD__|$T|" \
    | node "$ROOT/bin/agentclaim.js" hook "$ev" 2>&1 >/dev/null
}
wholefile_payload() { printf '{"session_id":"__SID__","cwd":"__CWD__","tool_name":"Write","tool_input":{"file_path":"%s","content":"%s"}}' "$1" "$2"; }
bash_payload()  { printf '{"session_id":"__SID__","cwd":"__CWD__","tool_name":"Bash","tool_input":{"command":"%s"}}' "$1"; }

rm -rf "$T"; mkdir -p "$T"; cd "$T" || exit 1
git init -q .; git config user.email t@t; git config user.name t
echo 'export const K = { a: 1 };' > i18n.js
echo 'export const demo = [];'    > api.demo.js
echo 'export const Money = 1;'    > Money.jsx
git add -A >/dev/null; git commit -qm init

# ─────────────────────────────────────────────────────────────────────────────
head_ "0) NO-OP PROOF - a lone session never trips a gate"
AGENTCLAIM_SESSION=A $CLI claim i18n.js >/dev/null
hook PreToolUse A "$(write_payload "$T/i18n.js")" && ok "solo: write allowed" || bad "solo write was blocked"
hook PreToolUse A "$(bash_payload 'git add -A')"  && ok "solo: git add -A allowed" || bad "solo git add was blocked"
hook PreToolUse A "$(bash_payload 'git commit -a')" && ok "solo: git commit -a allowed" || bad "solo commit was blocked"

# ─────────────────────────────────────────────────────────────────────────────
head_ "1) DESTRUCTIVE RESTORE - 'git checkout HEAD -- x' used to wipe someone else's work"
AGENTCLAIM_SESSION=B $CLI claim Money.jsx >/dev/null   # B becomes live
hook PreToolUse B "$(write_payload "$T/i18n.js")" \
  && bad "B WROTE to a file held by A" || ok "B blocked from writing A's file"
hook PreToolUse A "$(write_payload "$T/i18n.js")" \
  && ok "A can still write its own file" || bad "A was blocked from its own file"
hook PreToolUse B "$(bash_payload 'git checkout HEAD -- i18n.js')" \
  && bad "B REVERTED a file held by A" || ok "'git checkout HEAD -- i18n.js' blocked"
hook PreToolUse B "$(bash_payload 'git checkout HEAD -- Money.jsx')" \
  && ok "B can revert its own file" || bad "B was blocked from its own file"

# ─────────────────────────────────────────────────────────────────────────────
head_ "2) STAGING RACE - 'git commit -a' used to swallow another session's files"
echo 'export const K = { a: 2 };' > i18n.js     # A's file is now dirty
hook PreToolUse B "$(bash_payload 'git commit -a -m x')" \
  && bad "B COMMITTED a file held by A" || ok "'git commit -a' blocked"
hook PreToolUse B "$(bash_payload 'git add -A')" \
  && bad "B ran a bulk 'git add -A'" || ok "'git add -A' blocked"
hook PreToolUse B "$(bash_payload 'git add Money.jsx')" \
  && ok "B can stage only its own file" || bad "B could not stage its own file"
hook PreToolUse B "$(bash_payload 'git commit -m "message with ; and && in it"')" \
  && ok "path-free 'git commit -m' with empty index allowed" || bad "an innocent commit was blocked"

# ─────────────────────────────────────────────────────────────────────────────
head_ "3) SNAPSHOT RACE - the commit carries the OLD content from 'git add' time"
# B stages; A rewrites the same file AFTERWARDS; the commit takes the old content
git checkout -q -- i18n.js
AGENTCLAIM_SESSION=A $CLI claim api.demo.js >/dev/null
echo 'export const demo = ["v1"];' > api.demo.js
git add api.demo.js
echo 'export const demo = ["v2"];' > api.demo.js      # <- A cut in here
git commit -qm "half content"
AGENTCLAIM_SESSION=B $CLI verify HEAD >/dev/null 2>&1 \
  && bad "mismatch was NOT caught" || ok "commit-vs-disk mismatch caught"
git add api.demo.js && git commit -qm "fixed"
AGENTCLAIM_SESSION=B $CLI verify HEAD >/dev/null 2>&1 \
  && ok "the fixed commit reports clean" || bad "false alarm on a clean commit"

# ─────────────────────────────────────────────────────────────────────────────
head_ "4) UNIVERSAL NET - git pre-commit (covers every non-Claude-Code tool)"
$CLI init >/dev/null 2>&1
git add Money.jsx >/dev/null 2>&1
AGENTCLAIM_SESSION=A $CLI claim Money.jsx --note "A took over" >/dev/null 2>&1
$CLI release Money.jsx --force >/dev/null 2>&1
AGENTCLAIM_SESSION=A $CLI claim Money.jsx >/dev/null 2>&1
echo 'export const Money = 2;' > Money.jsx
git add Money.jsx
if git commit -qm "foreign file" >/dev/null 2>&1; then
  bad "pre-commit LET a foreign file through"
else
  ok "pre-commit stopped a foreign staged file"
fi

# ─────────────────────────────────────────────────────────────────────────────
head_ "5) STALE SESSION - a dead session must not lock the repo forever"
node -e '
const fs=require("fs"),p=require("path");
const d=p.join(process.cwd(),".git","agentclaim","sessions");
for (const f of fs.readdirSync(d)) {
  const q=p.join(d,f), s=JSON.parse(fs.readFileSync(q,"utf8"));
  if (s.sid==="A") { s.seen = Date.now() - 99*60*1000; fs.writeFileSync(q, JSON.stringify(s)); }
}'
AGENTCLAIM_SESSION=B $CLI claim Money.jsx >/dev/null 2>&1 \
  && ok "stale claim was taken over" || bad "stale claim could not be taken over"

# ─────────────────────────────────────────────────────────────────────────────
head_ "6) COEXISTENCE - same file, different regions, nobody blocked"
# Section 5 deliberately made A stale; bring it back to life for this scenario.
AGENTCLAIM_SESSION=A $CLI status >/dev/null 2>&1
printf 'const a1 = 1;\nconst a2 = 2;\nconst a3 = 3;\nconst a4 = 4;\nconst a5 = 5;\nconst a6 = 6;\nconst a7 = 7;\nconst a8 = 8;\n' > shared.js
git add shared.js >/dev/null 2>&1; git commit -qm "shared" >/dev/null 2>&1

# Both agents read the file, so both have a recorded view of it.
hook PostToolUse A "$(read_payload "$T/shared.js")" >/dev/null 2>&1
hook PostToolUse B "$(read_payload "$T/shared.js")" >/dev/null 2>&1

# A edits near the top: goes through the gate, claims the file, view moves on.
hook PreToolUse A "$(edit_payload "$T/shared.js" 'const a2 = 2;')" >/dev/null 2>&1 \
  && ok "A takes the file first" || bad "A was blocked from an untouched file"
sed -i.bak 's|const a2 = 2;|const a2 = 2; // A|' shared.js && rm -f shared.js.bak
hook PostToolUse A "$(write_payload "$T/shared.js")" >/dev/null 2>&1

# THE POINT: B works in the same file, just somewhere else. Not blocked.
hook PreToolUse B "$(edit_payload "$T/shared.js" 'const a7 = 7;')" \
  && ok "B edits a different region of A's file - ALLOWED" \
  || bad "B was blocked from a non-overlapping region"

# Overlapping lines are NOT a stop sign: an anchored edit still applies on top of
# their version, so blocking here would only cost a round trip.
OVER=$(hook_err PreToolUse B "$(edit_payload "$T/shared.js" 'const a2 = 2;')")
hook PreToolUse B "$(edit_payload "$T/shared.js" 'const a2 = 2;')" \
  && ok "B's overlapping edit is NOT blocked - the flow continues" \
  || bad "an overlapping edit stopped the agent"
echo "$OVER" | grep -q '// A' \
  && ok "B is handed A's change as context instead" \
  || bad "no context was given about A's change"

# Whole-file write from B, based on the version B last saw: must be MERGED,
# not clobbered - A's line has to survive.
NEW='const a1 = 1;\nconst a2 = 2;\nconst a3 = 3;\nconst a4 = 4;\nconst a5 = 5;\nconst a6 = 6;\nconst a7 = 777;\nconst a8 = 8;\n'
hook PreToolUse B "$(wholefile_payload "$T/shared.js" "$NEW")" \
  && ok "B's whole-file write accepted for merge" || bad "mergeable whole-file write was blocked"
printf "$NEW" > shared.js                                  # the tool writes B's version
hook PostToolUse B "$(wholefile_payload "$T/shared.js" "$NEW")" >/dev/null 2>&1 || true
grep -q '// A' shared.js && ok "A's edit survived B's whole-file write" || bad "A's edit was lost"
grep -q 'a7 = 777' shared.js && ok "B's edit landed too" || bad "B's edit was lost"

# Writes got smarter, commits stay strict: neither may commit a contested file.
hook PreToolUse B "$(bash_payload 'git add shared.js')" \
  && bad "B staged a file A is still working in" || ok "commit path still strict for B"
hook PreToolUse A "$(bash_payload 'git add shared.js')" \
  && bad "A staged a file B is still working in" || ok "commit path still strict for A"

# ─────────────────────────────────────────────────────────────────────────────
head_ "7) GETTING UNSTUCK - a real conflict, and the way out of a contested file"

# 7a. A true collision must hand over the other agent's actual change, not just
#     say "conflict". Guessing costs a round trip; seeing it does not.
printf 'const b1 = 1;\nconst b2 = 2;\nconst b3 = 3;\nconst b4 = 4;\n' > conflict.js
git add conflict.js >/dev/null 2>&1; git commit -qm "conflict file" >/dev/null 2>&1
hook PostToolUse A "$(read_payload "$T/conflict.js")" >/dev/null 2>&1
hook PostToolUse B "$(read_payload "$T/conflict.js")" >/dev/null 2>&1
hook PreToolUse A "$(edit_payload "$T/conflict.js" 'const b3 = 3;')" >/dev/null 2>&1
sed -i.bak 's|const b3 = 3;|const b3 = 3; // by A|' conflict.js && rm -f conflict.js.bak
hook PostToolUse A "$(write_payload "$T/conflict.js")" >/dev/null 2>&1

MSG=$(hook_err PreToolUse B "$(edit_payload "$T/conflict.js" 'const b3 = 3;')")
hook PreToolUse B "$(edit_payload "$T/conflict.js" 'const b3 = 3;')" \
  && ok "same-line edit still runs - no pause anywhere in the edit path" \
  || bad "the agent was stopped on a same-line edit"
echo "$MSG" | grep -q '// by A' \
  && ok "the other agent's actual change is shown, not just a line number" \
  || bad "message did not include their change"

# 7b. THE DEADLOCK: both A and B have touched shared.js, so neither may commit it.
hook PreToolUse A "$(bash_payload 'git add shared.js')" \
  && bad "contested file was stageable" || ok "deadlock reproduced: A cannot stage"
# The cooperative exit: B says it is done. No --force, and it cannot steal.
AGENTCLAIM_SESSION=B $CLI release shared.js >/dev/null 2>&1
hook PreToolUse A "$(bash_payload 'git add shared.js')" \
  && ok "after B steps out, A can stage again" || bad "A is still stuck after B released"

# 7c. Nobody has to say anything: a session stops blocking a file it has not
#     touched recently, so the deadlock also resolves on its own.
hook PostToolUse B "$(read_payload "$T/shared.js")" >/dev/null 2>&1
hook PreToolUse B "$(edit_payload "$T/shared.js" 'const a5 = 5;')" >/dev/null 2>&1
hook PreToolUse A "$(bash_payload 'git add shared.js')" \
  && bad "B's fresh edit did not block A" || ok "B re-entering the file blocks A again"
node -e '
const fs=require("fs"),p=require("path");
const d=p.join(process.cwd(),".git","agentclaim","claims");
const old=Date.now()-99*60*1000;
for (const f of fs.readdirSync(d)) {
  const q=p.join(d,f), c=JSON.parse(fs.readFileSync(q,"utf8"));
  if (!c.path.endsWith("shared.js")) continue;
  for (const k of Object.keys(c.touchers||{})) if (k==="B") c.touchers[k]=old;
  if (c.sid==="B") c.at=old;
  fs.writeFileSync(q, JSON.stringify(c));
}'
hook PreToolUse A "$(bash_payload 'git add shared.js')" \
  && ok "an idle session stops blocking the commit on its own" \
  || bad "idle session still blocks the commit"

# ─────────────────────────────────────────────────────────────────────────────
printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
cd /; rm -rf "$T"
[ "$FAIL" -eq 0 ]
