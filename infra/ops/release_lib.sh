# Release directories for production (sourced, never run). ADR-158.
#
# Production used to run from the checkout people and tools work in (/Users/hawzhin/Hawdesign): the
# launch agents, nginx's and Vector's bind mounts and the watchdog's recovery all read it, and on
# 2026-09-30 it was on another tool's branch. Now each deploy runs from its own directory,
#   ~/.hawa/releases/<commit>   a detached git worktree of that commit (git worktree add --detach),
# and ~/.hawa/current is a symbolic link to the release production runs, flipped atomically (a rename)
# by deploy.sh just before it starts that release's containers; ~/.hawa/previous names the one before.
# The launch agents run ~/.hawa/current/infra/..., so a checkout can be on any branch, dirty or deleted
# without production noticing.
#
# Containers never bind a file through ~/.hawa/current (addendum 3): Docker Desktop resolves the link
# when it creates a container and keeps the release path, so a container nothing recreated stayed on an
# old release until the prune removed it (vector, 2026-09-30). The files compose binds (HAWA_RUNTIME_FILES,
# and HAWA_RUNTIME_SHARED from ~/.hawa/shared) are copied into ~/.hawa/runtime instead, a real directory
# that is never switched or pruned, at the same relative paths. They are rewritten in place (the same
# inode): a single-file bind mount keeps the inode it bound, so a replaced file is never seen.
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
#   hawa_release_prune [keep]              remove all but current, previous, the newest <keep> releases and
#                                          any release a container's bind mounts may still use
#   hawa_runtime_dir                       where the files compose binds live (~/.hawa/runtime)
#   hawa_runtime_sync <from> [dest] [shared] [missing]   copy them in place; prints "changed <path>" per file

HAWA_SHARED_REQUIRED=(infra/docker/.env.production infra/docker/.env)
HAWA_SHARED_DIRS=(infra/backup/snapshots infra/backup/release-receipts)
# The test settings the release gate's suite reads, and the one gitignored audit folder validate_pack's
# link check needs (the commit hook's own trap in a fresh worktree).
HAWA_SHARED_OPTIONAL=(.env.test infra/docker/.env.service-boundaries infra/docker/.env.worker infra/docker/.env.worker-db infra/docker/.office-proxy-header.conf output/audits/2026-09-29-product-flow-fixes)

# The files compose binds into nginx, vector and postgres, from the release; and from ~/.hawa/shared.
HAWA_RUNTIME_FILES=(infra/docker/nginx.conf infra/docker/vector.yaml infra/docker/00-init-roles.sql db/schema.sql db/rls.sql db/03-grants.sql db/seed.sql)
HAWA_RUNTIME_SHARED=(infra/docker/.office-proxy-header.conf)
HAWA_RELEASE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

hawa_releases_dir() { printf '%s' "${HAWA_RELEASES_DIR:-$HOME/.hawa/releases}"; }
hawa_current_link() { printf '%s' "${HAWA_CURRENT_LINK:-$HOME/.hawa/current}"; }
hawa_previous_link() { printf '%s' "${HAWA_PREVIOUS_LINK:-$(dirname "$(hawa_current_link)")/previous}"; }
hawa_shared_dir() { printf '%s' "${HAWA_SHARED_DIR:-$HOME/.hawa/shared}"; }
hawa_runtime_dir() { printf '%s' "${HAWA_RUNTIME_DIR:-$HOME/.hawa/runtime}"; }
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
  hawa_release_check_worker_identity "$release" || return 1
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
  hawa_release_check_worker_identity "$release" || return 1
  link="$(hawa_current_link)"; previous="$(hawa_previous_link)"
  mkdir -p "$(dirname "$link")"
  # Docker creates a missing bind-mount source as a directory. If a container was ever started through
  # ~/.hawa/current before it existed, current is a real directory of empty directories: remove those
  # (empty directories only; anything holding a file or a link stops the deploy for a person to look).
  if [[ -d "$link" && ! -L "$link" ]]; then
    if [[ -n "$(find "$link" ! -type d -print -quit)" ]]; then
      echo "ERROR: $link is a real directory holding files, not a release link; look at it by hand" >&2; return 1
    fi
    find "$link" -depth -type d -empty -delete || return 1
    echo "! removed $link, a directory of empty placeholders Docker made for missing bind-mount sources" >&2
  fi
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

# The releases any container, running or stopped, may still read through a bind mount: sources inside
# ~/.hawa/releases/<commit>, and sources through ~/.hawa/current or previous resolved against the release
# history at the container's creation and last start (infra/ops/release_mounts.py). Fails (and the prune
# removes nothing) when Docker cannot be asked or a mount cannot be resolved for certain.
hawa_release_mounted() {
  local ids json
  command -v docker >/dev/null 2>&1 || { echo "docker is not available to ask which releases containers use" >&2; return 1; }
  ids="$(docker ps -aq --no-trunc 2>/dev/null)" || { echo "docker ps failed" >&2; return 1; }
  if [[ -z "$ids" ]]; then json='[]'
  else
    # One id per word. A container removed between the two calls fails the inspect: ask once more.
    # shellcheck disable=SC2086
    json="$(docker inspect $ids 2>/dev/null)" || json="$(docker inspect $(docker ps -aq --no-trunc) 2>/dev/null)" \
      || { echo "docker inspect failed" >&2; return 1; }
  fi
  printf '%s' "$json" | python3 "$HAWA_RELEASE_LIB_DIR/release_mounts.py" --releases "$(hawa_releases_dir)" \
    --current "$(hawa_current_link)" --previous "$(hawa_previous_link)" --history "$(hawa_releases_dir)/.history"
}

# Keeps current, previous and the <keep> most recently activated releases (HAWA_RELEASES_KEEP, 5);
# a release prepared but never activated counts by its directory's age. A release a container may still
# bind is kept whatever its age, and when that cannot be known no release is removed (addendum 3: the
# prune removed the release vector was pinned to, 2026-09-30).
hawa_release_prune() { # [keep]
  local keep="${1:-${HAWA_RELEASES_KEEP:-5}}" dir name current previous order kept=0 common mounted
  dir="$(hawa_releases_dir)"; [[ -d "$dir" ]] || return 0
  current="$(hawa_physical "$(hawa_current_link)" || true)"; previous="$(hawa_physical "$(hawa_previous_link)" || true)"
  mounted="$(hawa_release_mounted)" || { echo "WARNING: could not tell which releases containers still bind; no release was removed" >&2; return 0; }
  # Newest first: activations (latest occurrence of each), then directories never activated, newest first.
  order="$( { [[ -f "$dir/.history" ]] && awk '{print $2}' "$dir/.history" | sed -n '1!G;h;$p' || true; ls -1t "$dir" 2>/dev/null || true; } \
    | grep -E '^[0-9a-f]{40}$' | awk '!seen[$0]++' || true)"
  for name in $order; do
    [[ -d "$dir/$name" ]] || continue
    if [[ "$dir/$name" == "$current" || "$dir/$name" == "$previous" ]]; then continue; fi
    kept=$((kept + 1))
    (( kept > keep )) || continue
    if grep -qx "$name" <<< "$mounted"; then echo "kept release $name: a container's bind mount may still use it"; continue; fi
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

# Copies one file in place: an existing destination keeps its inode (truncated and rewritten, never
# replaced), so a container that binds it sees the new content. Prints "changed" when the content changed.
# The mode follows the source: owner-only when the source is, else 0644. A directory of empty
# directories at the destination is Docker's placeholder for a source that was missing, and is removed.
hawa_runtime_put() { # source, destination
  local src="$1" dst="$2" mode
  [[ -f "$src" ]] || { echo "ERROR: $src is missing; it is bound into a container" >&2; return 1; }
  [[ ! -L "$dst" ]] || { echo "ERROR: $dst is a symbolic link; runtime files are real files" >&2; return 1; }
  if [[ -d "$dst" ]]; then
    [[ -z "$(find "$dst" ! -type d -print -quit)" ]] || { echo "ERROR: $dst is a directory holding files; look at it by hand" >&2; return 1; }
    find "$dst" -depth -type d -empty -delete || return 1
    echo "! removed $dst, an empty placeholder Docker made for a missing bind-mount source; recreate the container that binds it" >&2
  fi
  mode="$(stat -c %a "$src" 2>/dev/null || stat -f %Lp "$src")" || return 1
  if (( 8#$mode & 8#044 )); then mode=644; else mode=600; fi
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then chmod "$mode" "$dst"; return 0; fi
  mkdir -p "$(dirname "$dst")" || return 1
  [[ -e "$dst" ]] || (umask 077 && : > "$dst") || return 1
  { chmod "$mode" "$dst" && cat "$src" > "$dst"; } || { echo "ERROR: could not write $dst" >&2; return 1; }
  cmp -s "$src" "$dst" || { echo "ERROR: $dst does not match $src after the copy" >&2; return 1; }
  echo changed
}

# Copies every file compose binds into <dest> (the runtime directory), in place: HAWA_RUNTIME_FILES from
# <from> (a release, or another runtime directory), HAWA_RUNTIME_SHARED from <shared>. With "missing" as
# the fourth argument only files not there yet are written. Prints "changed <path>" for each file whose
# content changed; a missing source fails, naming it.
hawa_runtime_sync() { # from, [dest], [shared], [missing]
  local from="$1" dest="${2:-$(hawa_runtime_dir)}" shared="${3:-$(hawa_shared_dir)}" only="${4:-}" rel src out
  [[ -d "$from" ]] || { echo "ERROR: no directory $from to copy the runtime files from" >&2; return 1; }
  [[ ! -L "$dest" ]] || { echo "ERROR: $dest is a symbolic link; the runtime directory must be a real directory (Docker would pin its target)" >&2; return 1; }
  { mkdir -p "$dest" && chmod 700 "$dest"; } || return 1
  for rel in "${HAWA_RUNTIME_FILES[@]}" "${HAWA_RUNTIME_SHARED[@]}"; do
    src="$from/$rel"
    case " ${HAWA_RUNTIME_SHARED[*]} " in *" $rel "*) src="$shared/$rel" ;; esac
    if [[ "$only" == missing && -f "$dest/$rel" && ! -L "$dest/$rel" ]]; then continue; fi
    out="$(hawa_runtime_put "$src" "$dest/$rel")" || return 1
    [[ -z "$out" ]] || echo "changed $rel"
  done
}

# ADR183: discard only inactive, clean release worktrees predating the worker route boundary.
# Unlike retention pruning this refuses dirty/non-worktree targets and never falls back to rm -rf.
hawa_release_prune_unsafe() { # checkout, security foundation commit
  local checkout="$1" floor="$2" dir candidate name head common current previous mounted
  [[ "$floor" =~ ^[0-9a-f]{40}$ ]] && git -C "$checkout" cat-file -e "$floor^{commit}" 2>/dev/null \
    || { echo 'ERROR: invalid release security foundation' >&2; return 1; }
  dir="$(hawa_releases_dir)"; [[ -d "$dir" ]] || return 0
  current="$(hawa_physical "$(hawa_current_link)" || true)"; previous="$(hawa_physical "$(hawa_previous_link)" || true)"
  common="$(git -C "$checkout" rev-parse --path-format=absolute --git-common-dir)" || return 1
  # ADR-158 addendum 3: a release a container may still bind is never removed here either (this removed
  # 1737c8f2 under the running vector and Postgres on 2026-09-30); when that cannot be known, none is.
  mounted="$(hawa_release_mounted)" || { echo "WARNING: could not tell which releases containers still bind; no unsafe release was removed" >&2; return 0; }
  for candidate in "$dir"/*; do
    name="$(basename "$candidate")"; [[ "$name" =~ ^[0-9a-f]{40}$ ]] || continue
    [[ ! -L "$candidate" && -d "$candidate" ]] || { echo 'ERROR: invalid release target' >&2; return 1; }
    head="$(git -C "$candidate" rev-parse HEAD 2>/dev/null)" || return 1
    [[ "$head" == "$name" && "$(git -C "$candidate" rev-parse --path-format=absolute --git-common-dir)" == "$common" ]] \
      || { echo 'ERROR: release identity differs from its registered worktree' >&2; return 1; }
    if git -C "$checkout" merge-base --is-ancestor "$floor" "$head"; then continue; fi
    [[ "$candidate" != "$current" && "$candidate" != "$previous" ]] \
      || { echo 'ERROR: an active release predates the worker security foundation' >&2; return 1; }
    [[ -z "$(git -C "$candidate" status --porcelain)" ]] \
      || { echo 'ERROR: unsafe release holds local changes; preserve them before pruning' >&2; return 1; }
    if grep -qx "$name" <<< "$mounted"; then
      echo "kept unsafe release $name: a container's bind mount may still use it (recreate that container; a later deploy removes it)"; continue
    fi
    git --git-dir="$common" worktree remove --force "$candidate" \
      || { echo 'ERROR: unsafe release worktree removal failed' >&2; return 1; }
    rm -f "$dir/.built-$name" "$dir/.build-$name.log"
    echo "removed unsafe release $name"
  done
}

hawa_release_check_worker_identity() { # release
  [[ ! -f "$(hawa_shared_dir)/infra/docker/.worker-identity-v2" ]] || \
    [[ -f "$1/packages/db/migrations/073_restricted_worker_database.sql" && -f "$1/packages/db/src/provision-worker-role.ts" ]] || {
      echo 'ERROR: this release predates independent worker identities; rollback requires a compatible forward release' >&2; return 1;
    }
}
