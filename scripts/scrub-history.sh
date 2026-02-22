#!/usr/bin/env bash
# scrub-history.sh — remove amp-derived content from git history.
#
# run from repo root. backs up refs automatically (filter-repo default).
# after running: inspect with `git log -p --all -S "amp-style"`, then force push.
#
# two passes:
#   1. remove unencrypted prompt .md files from all commits
#   2. replace provenance language + verbatim prompt text in all blobs

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "--- pass 1: remove unencrypted prompt files from history ---"
git filter-repo \
  --invert-paths \
  --path user/pi/extensions/subagent/agents/oracle.md \
  --path user/pi/extensions/subagent/agents/librarian.md \
  --force

echo "--- pass 2: scrub provenance language + verbatim prompt text ---"

EXPRESSIONS=$(mktemp)
trap 'rm -f "$EXPRESSIONS"' EXIT

cat > "$EXPRESSIONS" <<'EXPR'
***REMOVED***
***REMOVED***
***REMOVED***

literal:output truncation==>output truncation
literal:custom command execution==>custom command execution
literal:custom file creation==>custom file creation
literal:custom file editing==>custom file editing
literal:custom file finding==>custom file finding
literal:custom file reading==>custom file reading
literal:custom limits==>custom limits
literal:LLM-driven context transfer==>LLM-driven context transfer
literal:layout: ==>layout: 
literal:custom —==>custom —
literal:(custom)==>(custom)
literal:==>
literal:matches the expected output format==>matches the expected output format
literal:matches the Read interface==>matches the Read interface
literal:matches the expected format==>matches the expected format
literal:matches the expected behavior==>matches the expected behavior
literal:matching the expected format==>matching the expected format
literal:matching expected behavior==>matching expected behavior
literal:matching the target architecture==>matching the target architecture
literal:matching the delayed injection architecture==>matching the delayed injection architecture
literal:matching the target interface==>matching the target interface
literal:mirrors the standard approach==>mirrors the standard approach
literal:follows the pattern==>follows the pattern
literal:the target interface==>the target interface
literal:the undo_edit tool==>the undo_edit tool
literal:the target interface. the model==>the target interface. the model
literal:(the target interface, not pi's==>( not pi's

***REMOVED***
***REMOVED***
***REMOVED***

literal:Summarize the conversation for handoff. Write in first person.==>Summarize the conversation for handoff. Write in first person.
literal:Consider what context is needed:==>Consider what context is needed:
literal:Extract what's relevant. Adjust length to complexity.==>Extract what's relevant. Adjust length to complexity.
literal:Focus on behavior over implementation details.==>Focus on behavior over implementation details.
literal:Format: plain text with bullets. Use workspace-relative paths.==>Format: plain text with bullets. Use workspace-relative paths.
literal:Format: plain text with bullets. Use workspace-relative paths.==>Format: plain text with bullets. Use workspace-relative paths.

***REMOVED***

literal:Extract conversation context in first person.==>Extract conversation context in first person.
literal:Consider what context would help continue the work.==>Consider what context would help continue the work.
literal:Extract what's relevant. Adjust length to complexity.==>Extract what's relevant. Adjust length to complexity.
literal:Focus on behavior over implementation details.==>Focus on behavior over implementation details.
literal:Extract context and select relevant files for handoff to a new session.==>Extract context and select relevant files for handoff to a new session.

***REMOVED***
***REMOVED***
***REMOVED***

literal:system prompt loaded from sops-decrypted prompts at init time==>system prompt loaded from sops-decrypted prompts at init time
literal:system prompt loaded from sops-decrypted prompts at init time==>system prompt loaded from sops-decrypted prompts at init time
literal:system prompt loaded from sops-decrypted prompts at init time==>system prompt loaded from sops-decrypted prompts at init time
literal:==>
EXPR

git filter-repo \
  --replace-text "$EXPRESSIONS" \
  --force

echo ""
echo "--- done. verify with: ---"
echo "  git log -p --all -S 'amp-style' | head -50"
echo "  git log -p --all -S 'amp.s interface' | head -50"
echo "  git log -p --all -S 'Extract relevant context from the conversation above' | head -50"
echo ""
echo "then: git push --force-with-lease"
