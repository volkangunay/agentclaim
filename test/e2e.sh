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
printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
cd /; rm -rf "$T"
[ "$FAIL" -eq 0 ]
