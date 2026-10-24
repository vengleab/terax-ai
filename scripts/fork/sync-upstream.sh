#!/usr/bin/env bash
# Merge crynta/terax-ai into the current fork branch with the least conflict pain.
#
#   scripts/fork/sync-upstream.sh            merge upstream/main into this branch
#   scripts/fork/sync-upstream.sh --ff-main  also fast-forward the local main mirror
#
# Pushing main or the branch is left to you.
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/crynta/terax-ai}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
FF_MAIN=0
[ "${1:-}" = "--ff-main" ] && FF_MAIN=1

cd "$(git rev-parse --show-toplevel)"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi
git config rerere.enabled true
git config rerere.autoupdate true

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "working tree has uncommitted changes; commit or stash first" >&2
  exit 1
fi

branch="$(git branch --show-current)"
git fetch upstream "$UPSTREAM_BRANCH"

if [ "$FF_MAIN" = 1 ] && [ "$branch" != "main" ]; then
  git fetch upstream "$UPSTREAM_BRANCH:main"
  echo "local main fast-forwarded to upstream/$UPSTREAM_BRANCH"
fi

if git merge --no-edit "upstream/$UPSTREAM_BRANCH"; then
  echo "merged upstream/$UPSTREAM_BRANCH into $branch"
else
  # Lockfiles: take upstream's, then let the tool re-add the fork's packages.
  if git diff --name-only --diff-filter=U | grep -qx 'src-tauri/Cargo.lock'; then
    git checkout --theirs src-tauri/Cargo.lock
    (cd src-tauri && cargo metadata --format-version 1 >/dev/null)
    git add src-tauri/Cargo.lock
    echo "Cargo.lock: took upstream and re-resolved fork crates"
  fi
  if git diff --name-only --diff-filter=U | grep -qx 'pnpm-lock.yaml'; then
    git checkout --theirs pnpm-lock.yaml
    git add pnpm-lock.yaml
    echo "pnpm-lock.yaml: took upstream (the fork adds no npm dependencies)"
  fi
  remaining="$(git diff --name-only --diff-filter=U)"
  if [ -n "$remaining" ]; then
    echo "unresolved conflicts, fix them and run: git commit" >&2
    echo "$remaining" >&2
    echo "after resolving, run: node scripts/fork/check-seams.mjs" >&2
    exit 1
  fi
  git commit --no-edit
fi

node scripts/fork/check-seams.mjs
