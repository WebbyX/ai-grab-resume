#!/usr/bin/env bash
# Publish gate for the npm package: runs every check, lists every failure, exits 1 if any failed.
set -u
cd "$(dirname "$0")/.."

GITLEAKS_VERSION="8.30.1"
PATTERNS="scripts/forbidden-patterns.txt"
EXPECTED_FILES="package/LICENSE package/README.md package/dist/cli.js package/package.json"

failures=()
fail() {
  failures+=("$1")
  echo "FAIL: $1" >&2
}

scan_tree() {
  grep -rnIE -f "$PATTERNS" --exclude-dir=.git --exclude-dir=node_modules --exclude="$(basename "$PATTERNS")" "$1" | cut -d: -f1,2
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "1/7 gitleaks version" >&2
found_version="$(gitleaks version 2>/dev/null || true)"
[[ "$found_version" == "$GITLEAKS_VERSION" ]] || fail "1 gitleaks version is '${found_version:-missing}', expected $GITLEAKS_VERSION"

echo "2/7 gitleaks (history + working tree)" >&2
# why: gitleaks git exits 0 outside a repository, so that case is checked first.
if git rev-parse --git-dir >/dev/null 2>&1; then
  gitleaks git --redact --no-banner . >&2 || fail "2 gitleaks: findings in git history"
else
  fail "2 not a git repository: history cannot be scanned"
fi
gitleaks dir --redact --no-banner . >&2 || fail "2 gitleaks: findings in the working tree"

echo "3/7 forbidden patterns (working tree + history)" >&2
hits="$(scan_tree .)"
[[ -z "$hits" ]] || fail "3 forbidden pattern in working tree at: $(echo "$hits" | tr '\n' ' ')"
# why: git grep -E on macOS ignores \b, so history (incl. merge diffs via -m and commit messages) is scanned with the same grep as the working tree.
if git rev-parse --verify -q HEAD >/dev/null 2>&1; then
  history_hits="$(git log --all -m -p --no-color --format='@@commit %H%n%B' -- . ":!$PATTERNS" |
    awk '/^@@commit /{c=substr($2,1,12); f="(commit message)"; next} /^--- a\//{f=substr($0,7)} /^\+\+\+ b\//{f=substr($0,7)} {print c" "f"\t"$0}' |
    grep -E -f "$PATTERNS" | cut -f1)"
  message_hits="$(git log --all --no-color --format='@@commit %H%n%B' |
    awk '/^@@commit /{c=substr($2,1,12); next} {print c" (commit message)\t"$0}' |
    grep -E -f "$PATTERNS" | cut -f1)"
  history_hits="$(printf '%s\n%s\n' "$history_hits" "$message_hits" | sed '/^$/d' | sort -u)"
  [[ -z "$history_hits" ]] || fail "3 forbidden pattern in git history at (commit file): $(echo "$history_hits" | tr '\n' ';')"
else
  fail "3 no git history to scan"
fi

echo "4/7 packed tarball" >&2
if npm pack --json --pack-destination "$work" >/dev/null 2>"$work/pack.log"; then
  tar -xzf "$work"/*.tgz -C "$work"
  packed="$(cd "$work" && find package -type f | sort | tr '\n' ' ' | sed 's/ $//')"
  [[ "$packed" == "$EXPECTED_FILES" ]] || fail "4 tarball files are '$packed', expected '$EXPECTED_FILES'"
  tar_hits="$(scan_tree "$work/package")"
  [[ -z "$tar_hits" ]] || fail "4 forbidden pattern in tarball at: $(echo "$tar_hits" | sed "s#$work/##g" | tr '\n' ' ')"
  gitleaks dir --redact --no-banner "$work/package" >&2 || fail "4 gitleaks: findings in the tarball"
  # why: bundlers can embed the build dir as a relative path, so the repo's parent/name tail is searched too.
  repo_tail="$(basename "$(dirname "$(pwd -P)")")/$(basename "$(pwd -P)")/"
  local_paths=("$HOME" "$(pwd -P)" "$repo_tail")
  [[ "$(pwd)" == "$(pwd -P)" ]] || local_paths+=("$(pwd)")
  for local_path in "${local_paths[@]}"; do
    path_hits="$(grep -rlF -- "$local_path" "$work/package" | sed "s#$work/##g" | tr '\n' ' ')"
    [[ -z "$path_hits" ]] || fail "4 tarball contains the local path $local_path in: $path_hits"
  done
else
  cat "$work/pack.log" >&2
  fail "4 npm pack failed"
fi

echo "5/7 no runtime dependencies" >&2
node -e '
  const deps = require("./package.json").dependencies
  process.exit(deps === undefined || (typeof deps === "object" && deps !== null && Object.keys(deps).length === 0) ? 0 : 1)
' || fail "5 package.json dependencies must be absent or empty"

echo "6/7 commit identities" >&2
if identities="$(git log --format='%ae%n%ce' 2>/dev/null)" && [[ -n "$identities" ]]; then
  bad="$(echo "$identities" | grep -v '@users\.noreply\.github\.com$' | sort -u | tr '\n' ' ')"
  [[ -z "$bad" ]] || fail "6 commits by non-noreply emails: $bad"
else
  fail "6 no commits to check"
fi

echo "7/7 LICENSE" >&2
grep -q 'WebbyX' LICENSE 2>/dev/null || fail "7 LICENSE missing or without WebbyX"

if ((${#failures[@]} > 0)); then
  echo >&2
  echo "check-publishable: ${#failures[@]} check(s) failed:" >&2
  printf '  - %s\n' "${failures[@]}" >&2
  exit 1
fi
echo "check-publishable: all 7 checks passed" >&2
