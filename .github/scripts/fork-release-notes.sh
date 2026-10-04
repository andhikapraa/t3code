#!/usr/bin/env bash
# Usage: fork-release-notes.sh <head> <upstream-ref> [previous-release-tag]
# Markdown notes for commits since the previous fork release, split into
# upstream and fork changes. The desktop update popover keeps only the last 8
# bullets of each release, so fork changes come last and upstream is capped.
set -euo pipefail
head="$1"
upstream="$2"
UPSTREAM_LIMIT=20

# Upstream publishes nightly tags too, so the caller names the fork's own
# previous release rather than guessing from tags.
prev="${3:-}"
range=("$head")
[[ -n "$prev" ]] && range+=("^$prev")

# Non-merge commits new since the last release, newest first.
new="$(git rev-list --no-merges "${range[@]}")"
in_upstream="$(git rev-list "$upstream")"
upstream_shas="$(grep -Fx -f <(printf '%s\n' "$in_upstream") <<<"$new" || true)"
fork_shas="$(grep -Fxv -f <(printf '%s\n' "$in_upstream") <<<"$new" || true)"

subject() { git log -1 --format='%s' "$1"; }
upstream_count="$(grep -c . <<<"$upstream_shas" || true)"

if [[ "$upstream_count" -gt 0 ]]; then
  echo "## From upstream ($upstream_count)"
  head -n "$UPSTREAM_LIMIT" <<<"$upstream_shas" | while read -r sha; do echo "- $(subject "$sha")"; done
  if [[ "$upstream_count" -gt "$UPSTREAM_LIMIT" ]]; then
    echo "- …and $((upstream_count - UPSTREAM_LIMIT)) more upstream changes"
  fi
  echo
fi
if [[ -n "$fork_shas" ]]; then
  echo "## Fork changes"
  while read -r sha; do echo "- $(subject "$sha")"; done <<<"$fork_shas"
  echo
fi
if [[ -z "$fork_shas" && "$upstream_count" -eq 0 ]]; then
  echo "- Rebuild with no source changes."
  echo
fi
echo "Built from \`$(git rev-parse --short=10 "$head")\`${prev:+, changes since $prev}."
