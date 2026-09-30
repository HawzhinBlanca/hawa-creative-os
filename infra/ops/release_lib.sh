# Release directories for production (sourced, never run). ADR-158.
#
# Production used to run from the checkout people and tools work in (/Users/hawzhin/Hawdesign): the
# launch agents, nginx's and Vector's bind mounts and the watchdog's recovery all read it, and on
# 2026-09-30 it was on another tool's branch. Now each deploy runs from its own directory,
#   ~/.hawa/releases/<commit>   a detached git worktree of that commit (git worktree add --detach),
# and ~/.hawa/current is a symbolic link to the release production runs, flipped atomically (a rename)
# by deploy.sh just before it starts that release's containers; ~/.hawa/previous names the one before.
# The launch agents run ~/.hawa/current/infra/..., and the compose bind mounts read their files through
# ~/.hawa/current, so a checkout can be on any branch, dirty or deleted without production noticing.
#
# Host-local files (credentials, backups, receipts) live once in ~/.hawa/shared, at the same relative
# paths, and every release links to them: HAWA_SHARED_REQUIRED must exist there, HAWA_SHARED_DIRS are
# created there when missing, HAWA_SHARED_OPTIONAL are linked only when present.
#
# Bash 3.2 compatible (the macOS launch agents run /bin/bash).
#
#   hawa_releases_dir, hawa_current_link, hawa_previous_link, hawa_shared_dir   the locations
#   hawa_release_path <commit>             where that commit's release lives
#   hawa_deployed_root <fallback>          the physical directory ~/.hawa/current points to, else <fallback>
#   hawa_release_prepare <checkout> <commit>   create (or check) the release, link the shared files; prints its path
#   hawa_release_install <release>         pnpm install --offline and the build the scripts need ($HAWA_RELEASE_BUILD)
#   hawa_release_activate <release>        point current at it (atomic), previous at the old one, record history
#   hawa_release_prune [keep]              remove all but current, previous and the newest <keep> releases

HAWA_SHARED_REQUIRED=(infra/docker/.env.production infra/docker/.env)
HAWA_SHARED_DIRS=(infra/backup/snapshots infra/backup/release-receipts)
# The test settings the release gate's suite reads, and the one gitignored audit folder validate_pack's
# link check needs (the commit hook's own trap in a fresh worktree).
HAWA_SHARED_OPTIONAL=(.env.test output/audits/2026-09-29-product-flow-fixes)

hawa_releases_dir() { printf '%s' "${HAWA_RELEASES_DIR:-$HOME/.hawa/releases}"; }
hawa_current_link() { printf '%s' "${HAWA_CURRENT_LINK:-$HOME/.hawa/current}"; }
hawa_previous_link() { printf '%s' "${HAWA_PREVIOUS_LINK:-$(dirname "$(hawa_current_link)")/previous}"; }
hawa_shared_dir() { printf '%s' "${HAWA_SHARED_DIR:-$HOME/.hawa/shared}"; }
hawa_release_path() { printf '%s/%s' "$(hawa_releases_dir)" "$1"; }
hawa_physical() { (cd -P "$1" 2>/dev/null && pwd -P); }

hawa_deployed_root() {
  local link resolved
  link="$(hawa_current_link)"
  if [[ -L "$link" || -d "$link" ]] && resolved="$(hawa_physical "$link")" && [[ -n "$resolved" ]]; then
    printf '%s' "$resolved"
  else
    printf '%s' "$1"
  fi
}

# Links one shared path into a release. A tracked file or folder of the same name is never replaced.
hawa_release_link_shared() { # release, relative path, kind (required|dir|optional)
  local release="$1" rel="$2" kind="$3" shared target
  shared="$(hawa_shared_dir)/$rel"; target="$release/$rel"
  case "$kind" in
    dir) mkdir -p "$shared" && chmod 700 "$shared" ;;
    required) [[ -e "$shared" ]] || { echo "ERROR: $shared is missing: host-local files live in $(hawa_shared_dir) since ADR-158 (runbooks/PRODUCTION_RELEASE_DIRECTORIES.md, one-time switch-over)" >&2; return 1; } ;;
    optional) [[ -e "$shared" ]] || return 0 ;;
  esac
  if [[ -L "$target" ]]; then
    [[ "$(readlink "$target")" == "$shared" ]] && return 0
    rm -f "$target"
  elif [[ -e "$target" ]]; then
    echo "ERROR: $target exists in the release itself; it must be the link to $shared" >&2; return 1
  fi
  mkdir -p "$(dirname "$target")" && ln -s "$shared" "$target"
}

hawa_release_prepare() { # checkout, commit
  local checkout="$1" commit="$2" release head rel
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: '$commit' is not a full commit id" >&2; return 1; }
  release="$(hawa_release_path "$commit")"
  mkdir -p "$(hawa_releases_dir)" && chmod 700 "$(hawa_releases_dir)"
  if [[ ! -e "$release" ]]; then
    git -C "$checkout" worktree add --detach "$release" "$commit" >/dev/null 2>&1 \
      || { echo "ERROR: git worktree add --detach $release $commit failed (from $checkout)" >&2; return 1; }
  fi
  head="$(git -C "$release" rev-parse HEAD 2>/dev/null || true)"
  [[ "$head" == "$commit" ]] || { echo "ERROR: $release is at ${head:-no commit}, not $commit; remove it (git worktree remove --force) and deploy again" >&2; return 1; }
  for rel in "${HAWA_SHARED_REQUIRED[@]}"; do hawa_release_link_shared "$release" "$rel" required || return 1; done
  for rel in "${HAWA_SHARED_DIRS[@]}"; do hawa_release_link_shared "$release" "$rel" dir || return 1; done
  for rel in "${HAWA_SHARED_OPTIONAL[@]}"; do hawa_release_link_shared "$release" "$rel" optional || return 1; done
  [[ -z "$(git -C "$release" status --porcelain 2>/dev/null)" ]] \
    || { echo "ERROR: $release has changes of its own (git status); a release is never edited in place" >&2; return 1; }
  printf '%s' "$release"
}

# The dependencies and the build the release's own scripts need: deploy.sh's tsx scripts, the release
# gate's suite, and the monthly drill's apps/core/dist/tools/blob-verify.js. Recorded once per release.
hawa_release_install() { # release
  local release="$1" name log
  name="$(basename "$release")"
  [[ -e "$release/.git" ]] || { echo "ERROR: $release is not a release worktree" >&2; return 1; }
  [[ ! -f "$(hawa_releases_dir)/.built-$name" ]] || return 0
  log="$(hawa_releases_dir)/.build-$name.log"
  if (cd "$release" && eval "${HAWA_RELEASE_BUILD:-pnpm install --offline --frozen-lockfile && pnpm build && pnpm --filter @hawa/desk build}") > "$log" 2>&1; then
    : > "$(hawa_releases_dir)/.built-$name"
  else
    echo "ERROR: installing and building $release failed; see $log" >&2; tail -20 "$log" >&2; return 1
  fi
}

hawa_release_activate() { # release
  local release link previous old tmp
  release="$(hawa_physical "$1")" || { echo "ERROR: no release at $1" >&2; return 1; }
  link="$(hawa_current_link)"; previous="$(hawa_previous_link)"
  mkdir -p "$(dirname "$link")"
  old="$(hawa_physical "$link" || true)"
  if [[ "$old" != "$release" ]]; then
    tmp="${link}.new.$$"; rm -f "$tmp"; ln -s "$release" "$tmp"
    # A rename replaces the link in one step: at no moment is there no current release. (ln -sfn
    # unlinks first, and mv onto a link to a directory moves into that directory.)
    python3 -c 'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "$tmp" "$link" || { rm -f "$tmp"; return 1; }
    if [[ -n "$old" ]]; then
      tmp="${previous}.new.$$"; rm -f "$tmp"; ln -s "$old" "$tmp"
      python3 -c 'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "$tmp" "$previous" || rm -f "$tmp"
    fi
  fi
  mkdir -p "$(hawa_releases_dir)"
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$(basename "$release")" >> "$(hawa_releases_dir)/.history"
}

# Keeps current, previous and the <keep> most recently activated releases (HAWA_RELEASES_KEEP, 5);
# a release prepared but never activated counts by its directory's age. Old containers' bind mounts
# point through ~/.hawa/current, never into a release, so pruning cannot pull a file from under one.
hawa_release_prune() { # [keep]
  local keep="${1:-${HAWA_RELEASES_KEEP:-5}}" dir name current previous order kept=0 common
  dir="$(hawa_releases_dir)"; [[ -d "$dir" ]] || return 0
  current="$(hawa_physical "$(hawa_current_link)" || true)"; previous="$(hawa_physical "$(hawa_previous_link)" || true)"
  # Newest first: activations (latest occurrence of each), then directories never activated, newest first.
  order="$( { [[ -f "$dir/.history" ]] && awk '{print $2}' "$dir/.history" | sed -n '1!G;h;$p' || true; ls -1t "$dir" 2>/dev/null || true; } \
    | grep -E '^[0-9a-f]{40}$' | awk '!seen[$0]++' || true)"
  for name in $order; do
    [[ -d "$dir/$name" ]] || continue
    if [[ "$dir/$name" == "$current" || "$dir/$name" == "$previous" ]]; then continue; fi
    kept=$((kept + 1))
    (( kept > keep )) || continue
    common="$(git -C "$dir/$name" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    if [[ -n "$common" ]] && git --git-dir="$common" worktree remove --force "$dir/$name" >/dev/null 2>&1; then
      echo "removed release $name"
    elif rm -rf "${dir:?}/$name"; then
      [[ -z "$common" ]] || git --git-dir="$common" worktree prune >/dev/null 2>&1 || true
      echo "removed release $name"
    else
      echo "WARNING: could not remove release $name" >&2
    fi
    rm -f "$dir/.built-$name" "$dir/.build-$name.log"
  done
}
