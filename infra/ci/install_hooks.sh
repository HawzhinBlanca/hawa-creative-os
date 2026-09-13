#!/usr/bin/env bash
# Points this clone at the versioned hooks so every commit runs the secret and manifest gates.
set -Eeuo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath infra/ci/hooks
echo "core.hooksPath=infra/ci/hooks (pre-commit: secret scan + manifest validation)"
