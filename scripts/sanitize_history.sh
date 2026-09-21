#!/usr/bin/env bash
# ==============================================================================
# Hawa Creative OS — Git History Sanitization Script (Owner Action)
# Targets:
#   1. Proprietary Microsoft fonts: packages/creative/assets/fonts/Verdana*
#   2. Internal graphics: data/kaae-graphics/
#   3. Secrets and historical literals
# ==============================================================================
set -euo pipefail

echo "================================================================================"
echo "          HAWA CREATIVE OS — GIT HISTORY SANITIZATION TOOL"
echo "================================================================================"
echo "WARNING: This script rewrites git commit history. It must be run only by"
echo "the repository owner on a dedicated fresh clone."
echo "================================================================================"

if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "ERROR: git-filter-repo is required but not installed."
  echo "Install it via: brew install git-filter-repo (macOS) or pip install git-filter-repo"
  exit 1
fi

read -p "Are you sure you want to rewrite history on this repository? (y/N) " confirm
if [[ "${confirm}" != "y" && "${confirm}" != "Y" ]]; then
  echo "Aborted by user."
  exit 0
fi

echo "--> Step 1: Purging proprietary font files and client graphics from all commits..."
git-filter-repo --force \
  --path-glob 'packages/creative/assets/fonts/Verdana*' --invert-paths \
  --path data/kaae-graphics --invert-paths

echo "--> Step 2: Verification..."
if git log --all -- 'packages/creative/assets/fonts/Verdana*' data/kaae-graphics | grep -q "commit"; then
  echo "WARNING: Some historical references remain. Run git gc --prune=now."
else
  echo "SUCCESS: All specified paths purged from entire git history."
fi

echo "================================================================================"
echo "Next Steps for Owner:"
echo "1. Verify repository status: git status"
echo "2. Add remote back: git remote add origin <git-url>"
echo "3. Force push to private GitHub repository: git push origin --force --all"
echo "4. Ask any other development worktrees to re-clone fresh."
echo "================================================================================"
