#!/usr/bin/env bash
# Build this checkout and link it into DSH profiles as a live plugin.
#
# Usage: scripts/symlink.sh [--force] [--no-build] [profile...]
#
# With no profile arguments every profile under $DSH_HOME/profiles is used.
# A profile already linked to this checkout is left alone unless --force.

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
dsh_home="${DSH_HOME:-$HOME/.dsh}"
profiles_dir="$dsh_home/profiles"

force=0
build=1
profiles=()

while [ $# -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    --no-build) build=0 ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) printf 'symlink: unknown option %s\n' "$1" >&2; exit 2 ;;
    *) profiles+=("$1") ;;
  esac
  shift
done

package_name="$(node -p 'require("./package.json").name' 2>/dev/null || true)"
if [ -z "$package_name" ]; then
  printf 'symlink: cannot read package name from %s/package.json\n' "$repo_root" >&2
  exit 1
fi

if ! command -v dsh >/dev/null 2>&1; then
  printf 'symlink: dsh is not on PATH\n' >&2
  exit 1
fi

if [ ! -d "$profiles_dir" ]; then
  printf 'symlink: no profiles directory at %s (set DSH_HOME?)\n' "$profiles_dir" >&2
  exit 1
fi

# Every directory holding a package.json is a profile; node_modules is not one.
if [ ${#profiles[@]} -eq 0 ]; then
  for candidate in "$profiles_dir"/*/; do
    name="$(basename "$candidate")"
    [ "$name" = "node_modules" ] && continue
    [ -f "$candidate/package.json" ] || continue
    profiles+=("$name")
  done
fi

if [ ${#profiles[@]} -eq 0 ]; then
  printf 'symlink: no profiles found under %s\n' "$profiles_dir" >&2
  exit 1
fi

if [ "$build" -eq 1 ]; then
  printf '==> building %s\n' "$package_name"
  (cd "$repo_root" && pnpm run build)
fi

# Absolute path of an existing symlink target, or empty when unresolvable.
resolve_link() {
  local link="$1" dir target
  [ -e "$link" ] || return 0
  dir="$(dirname "$link")"
  target="$(cd "$dir" && cd "$(readlink "$link" 2>/dev/null || printf '%s' "$link")" 2>/dev/null && pwd -P)" || return 0
  printf '%s' "$target"
}

status=0
for profile in "${profiles[@]}"; do
  profile_dir="$profiles_dir/$profile"
  if [ ! -f "$profile_dir/package.json" ]; then
    printf '==> %s: skipped, no package.json\n' "$profile"
    status=1
    continue
  fi

  installed="$(resolve_link "$profile_dir/node_modules/$package_name")"
  if [ "$installed" = "$repo_root" ] && [ "$force" -eq 0 ]; then
    printf '==> %s: already linked\n' "$profile"
  else
    printf '==> %s: linking\n' "$profile"
    (cd "$repo_root" && dsh plugin --profile "$profile" add "link:$repo_root")
  fi

  linked="$(resolve_link "$profile_dir/node_modules/$package_name")"
  if [ "$linked" != "$repo_root" ]; then
    printf '    FAILED: resolves to %s\n' "${linked:-nothing}"
    status=1
    continue
  fi
  if [ ! -f "$profile_dir/node_modules/$package_name/lib/index.mjs" ]; then
    printf '    FAILED: no lib/index.mjs — run a build\n'
    status=1
    continue
  fi
  if ! grep -q "\"$package_name\"" "$profile_dir/package.json"; then
    printf '    WARNING: not listed in dsh.profile.bundles; the profile will not load it\n'
    status=1
    continue
  fi
  printf '    ok\n'
done

if [ "$status" -eq 0 ]; then
  printf '\nRestart each DSH TUI to pick up the new build.\n'
fi
exit "$status"
