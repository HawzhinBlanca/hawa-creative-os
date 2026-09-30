#!/usr/bin/env bash
# Production release directories by hand (ADR-158; runbooks/PRODUCTION_RELEASE_DIRECTORIES.md).
# deploy.sh does all of this itself; these are the one-time switch-over and the manual steps.
#
#   bash infra/ops/release.sh status                  # current, previous, the releases on disk, recent activations
#   bash infra/ops/release.sh adopt <checkout>        # once: move the checkout's host-local files into ~/.hawa/shared
#   bash infra/ops/release.sh activate <commit>       # point ~/.hawa/current at an existing release (no deploy)
#   bash infra/ops/release.sh prune [keep]            # remove all but current, previous, the newest [keep] (5) and any a container binds
#   bash infra/ops/release.sh runtime-sync [commit]   # copy the files compose binds into ~/.hawa/runtime, in place (default: current)
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$HERE/release_lib.sh"
die() { echo "ERROR: $1" >&2; exit 1; }

case "${1:-status}" in
  status)
    echo "current:  $(readlink "$(hawa_current_link)" 2>/dev/null || echo none)"
    echo "previous: $(readlink "$(hawa_previous_link)" 2>/dev/null || echo none)"
    echo "shared:   $(hawa_shared_dir)"
    echo "runtime:  $(hawa_runtime_dir)"
    echo "releases in $(hawa_releases_dir):"
    ls -1t "$(hawa_releases_dir)" 2>/dev/null | grep -E '^[0-9a-f]{40}$' | sed 's/^/  /' || true
    echo "recent activations:"
    tail -5 "$(hawa_releases_dir)/.history" 2>/dev/null | sed 's/^/  /' || true
    ;;
  adopt)
    # The checkout production ran from keeps the files it has until the lead deletes them; directories
    # are moved (same disk: a rename) and a link is left at the old place, so a script still reading
    # the checkout's path finds the same files.
    checkout="$(hawa_physical "${2:?adopt needs the checkout production ran from}")" || die "no directory $2"
    shared="$(hawa_shared_dir)"; mkdir -p "$shared"; chmod 700 "$shared"
    for rel in "${HAWA_SHARED_REQUIRED[@]}" .env.test; do
      src="$checkout/$rel"; dst="$shared/$rel"
      [[ -f "$src" ]] || { [[ "$rel" == .env.test ]] && continue; die "$src is missing"; }
      mkdir -p "$(dirname "$dst")"
      if [[ -e "$dst" ]]; then
        cmp -s "$src" "$dst" || die "$dst exists and differs from $src; compare them by hand, nothing was changed"
        echo "✓ $rel already in $shared"
      else
        cp -p "$src" "$dst" && chmod 600 "$dst" && echo "✓ copied $rel (mode 600)"
      fi
    done
    for rel in "${HAWA_SHARED_DIRS[@]}"; do
      src="$checkout/$rel"; dst="$shared/$rel"
      if [[ -L "$src" ]]; then echo "✓ $rel is already a link ($(readlink "$src"))"; continue; fi
      mkdir -p "$(dirname "$dst")"
      if [[ -d "$src" && ! -e "$dst" ]]; then mv "$src" "$dst"
      elif [[ -d "$src" ]]; then die "both $src and $dst exist; merge them by hand, nothing was moved"
      else mkdir -p "$dst"; fi
      chmod 700 "$dst"; ln -s "$dst" "$src"
      echo "✓ moved $rel to $dst, linked from the checkout"
    done
    for rel in "${HAWA_SHARED_OPTIONAL[@]}"; do
      [[ "$rel" != .env.test && -d "$checkout/$rel" && ! -e "$shared/$rel" ]] || continue
      mkdir -p "$(dirname "$shared/$rel")" && cp -Rp "$checkout/$rel" "$shared/$rel" && echo "✓ copied $rel"
    done
    ;;
  activate)
    commit="${2:?activate needs a commit}"; release="$(hawa_release_path "$commit")"
    [[ -d "$release" ]] || die "no release at $release"
    hawa_release_activate "$release"
    echo "✓ $(hawa_current_link) -> $release"
    echo "  Containers are not changed by this; deploy that release (bash $release/infra/docker/deploy.sh --apply) to run it."
    ;;
  prune) hawa_release_prune "${2:-}" ;;
  runtime-sync)
    # What deploy.sh does just before `up -d` (addendum 3), for a runtime directory lost or edited by hand.
    # It does not reload anything: a changed nginx.conf or office proof needs `nginx -t` and a reload
    # (or a restart) of nginx, a changed vector.yaml a restart of vector; the init files are read only
    # when Postgres starts on an empty data directory.
    if [[ -n "${2:-}" ]]; then release="$(hawa_release_path "$2")"; else release="$(hawa_physical "$(hawa_current_link)")" || die "no current release"; fi
    [[ -d "$release" ]] || die "no release at $release"
    changed="$(hawa_runtime_sync "$release")" || die "the runtime files were not all copied (above)"
    echo "✓ $(hawa_runtime_dir) holds the files of $release${changed:+; changed:}"
    [[ -z "$changed" ]] || sed 's/^changed /  /' <<< "$changed"
    ;;
  *) die "unknown command $1 (status, adopt, activate, prune, runtime-sync)" ;;
esac
