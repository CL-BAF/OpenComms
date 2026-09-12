#!/bin/sh
# OpenComms Linux installer v2 (Workstream L, Platform).
#
# One-command install (curl-pipe-bash safe, also runnable from a checkout):
#   curl -fsSL https://raw.githubusercontent.com/CL-BAF/OpenComms/main/scripts/install.sh | bash
#
# What it does, strictly in order, fail-closed at every step:
#   1. Platform guard (Linux x86_64 only; unsupported arch fails with a clear message)
#   2. Resolve latest release version from GitHub Releases (api.github.com)
#   3. Download tarball + SHA256SUMS (single trusted source, HTTPS, same-origin)
#   4. VERIFY checksums BEFORE extract (sha256sum -c semantics)
#   5. Extract into a private staging dir and EXECUTE-BEFORE-INSTALL
#      (`version` + `doctor` must exit 0 before any system change)
#   6. Atomic replace into the bin dir with rollback-on-failure
#   7. Post-install validation (`opencomms version`, downgrade guard)
#   8. Idempotent PATH handling (no duplicate appends; writes ~/.profile only)
#   9. Summary + update hint
#
# Optional --service: ALSO install the systemd USER unit (previous approved
# behaviour; orthogonal). curl|bash defaults to binary-only; run install.sh
# from a checkout or a downloaded tarball for --service.
#
# Privilege policy: NEVER runs privileged commands (no sudo) and NEVER
# enables or starts the service; systemctl/linger actions are PRINTED. The
# only systemctl action executed anywhere remains the unprivileged
# `systemctl --user daemon-reload` when REPLACING an existing unit.
# Running as root is allowed but loud: the target bin dir resolves to the
# INVOKING user's home (or --bin-dir), never silently to /root/.local/bin.
# Secrets are never written. Project .opencomms state is never touched.
set -eu

REPO="CL-BAF/OpenComms"
RELEASES_BASE="https://github.com/${REPO}/releases/download"

usage() {
  cat <<'EOF'
Usage: install.sh [--version vX.Y.Z] [--bin-dir <dir>] [--exe <path>] [--project <dir>] [--service] [--uninstall] [--no-path-edit]

  (no flags)          Download the LATEST release, verify, and install to ~/.local/bin
  --version vX.Y.Z    Install a specific release instead of latest
  --bin-dir <dir>     Install directory (default: $OPENCOMMS_INSTALL_DIR or ~/.local/bin)
  --exe <path>        Install an ALREADY-BUILT binary (skips download; repo/dev mode)
  --project <dir>     Project directory for the systemd unit (required with --service)
  --service           Also install the systemd user unit (binary-only default)
  --uninstall         Remove the binary and unit (prints systemctl instructions first)
  --no-path-edit      Do not offer/perform the ~/.profile PATH line

Environment:
  OPENCOMMS_INSTALL_DIR   default bin dir override
  OPENCOMMS_ALLOW_DOWNGRADE=1  permit installing an older version than installed
EOF
}

fail() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

info() {
  printf '[opencomms-install] %s\n' "$1"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' is not available. Install it (e.g. via your distro package manager) and re-run."
}

require_cmd uname
require_cmd mktemp
require_cmd sha256sum
require_cmd tar
# curl or wget: use whichever exists (curl preferred for -f semantics).
if command -v curl >/dev/null 2>&1; then
  FETCH="curl"
elif command -v wget >/dev/null 2>&1; then
  FETCH="wget"
else
  fail "neither curl nor wget is available. Install one and re-run."
fi

fetch() {
  # fetch <url> <outfile> — 3 attempts with 2s/8s/30s backoff, fail-closed.
  url=$1
  out=$2
  attempt=1
  while [ "$attempt" -le 3 ]; do
    case "$FETCH" in
      curl)
        # -f: HTTP errors fail (never parse an HTML error page as an artifact).
        # --max-filesize: hostile-origin disk-fill defense (Reviewer P4).
        if curl -fsSL --connect-timeout 15 --retry 0 --max-filesize 209715200 -o "$out" "$url"; then return 0; fi
        ;;
      wget)
        if wget -q --max-filesize=209715200 -O "$out" "$url"; then return 0; fi
        ;;
    esac
    if [ "$attempt" -lt 3 ]; then
      case "$attempt" in
        1) delay=2 ;;
        2) delay=8 ;;
      esac
      info "download attempt $attempt failed; retrying in ${delay}s"
      sleep "$delay"
    fi
    attempt=$((attempt + 1))
  done
  fail "could not download $url after 3 attempts (2s/8s/30s backoff). Check network/proxy access to github.com and api.github.com."
}

api_get() {
  # api_get <path> <outfile> — same retry policy for the API endpoint.
  fetch "https://api.github.com${1}" "$2"
}

# ---------- argument parsing ----------
version_arg=""
bin_dir_override=""
exe_override=""
project_dir_arg=""
do_service=0
do_uninstall=0
no_path_edit=0

while [ $# -gt 0 ]; do
  case "$1" in
    --version) version_arg="${2:-}"; shift 2 ;;
    --bin-dir) bin_dir_override="${2:-}"; shift 2 ;;
    --exe) exe_override="${2:-}"; shift 2 ;;
    --project) project_dir_arg="${2:-}"; shift 2 ;;
    --service) do_service=1; shift ;;
    --uninstall) do_uninstall=1; shift ;;
    --no-path-edit) no_path_edit=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

case "$(uname -s)" in
  Linux*) ;;
  *) fail "this installer supports Linux only. Windows: download OpenComms-Setup-<version>.exe from GitHub Releases. macOS: build on the target OS." ;;
esac
case "$(uname -m)" in
  x86_64) tar_arch="x86_64" ;;
  *) fail "unsupported architecture '$(uname -m)' (v1 ships x86_64 only; arm64 is planned once proven clean)" ;;
esac

# Invoking-user home resolution (Reviewer-safe root handling): as root,
# resolve the REAL invoking user's home when available so we never silently
# install into /root/.local/bin while claiming to install "for the user".
resolve_home() {
  if [ -n "${SUDO_USER:-}" ] && [ "$(id -u)" = "0" ]; then
    getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6
  else
    printf '%s' "${HOME:-}"
  fi
}
real_home=$(resolve_home)
[ -n "$real_home" ] || fail "cannot resolve the invoking user's home directory (no HOME, no SUDO_USER)."
if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ]; then
  info "running as root for invoking user ${SUDO_USER}; using their home: ${real_home}"
fi

if [ "$do_uninstall" -eq 1 ]; then
  bin_dir=${bin_dir_override:-${OPENCOMMS_INSTALL_DIR:-"$real_home/.local/bin"}}
  target="$bin_dir/opencomms"
  unit_file="${XDG_CONFIG_HOME:-"$real_home/.config"}/systemd/user/opencomms.service"
  removed=""
  if [ -f "$target" ]; then rm -f "$target" && removed="$target"; fi
  if [ -f "$unit_file" ]; then rm -f "$unit_file" && removed="$removed $unit_file"; fi
  if [ -n "$removed" ]; then
    info "Removed:$removed"
  else
    info "Nothing installed at $target or $unit_file."
  fi
  printf 'If the service was enabled, run: systemctl --user daemon-reload && systemctl --user disable --now opencomms\n'
  printf 'Optionally (only if no other user services need it): loginctl disable-linger %s\n' "${SUDO_USER:-$(id -un)}"
  printf 'Project .opencomms state and archives were NOT touched.\n'
  exit 0
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

# ---------- staging ----------
staging=$(mktemp -d) || fail "could not create a staging directory (mktemp)."
cleanup() { rm -rf -- "$staging"; }
trap cleanup EXIT INT TERM

# ---------- resolve version + download ----------
if [ -n "$exe_override" ]; then
  # Dev/repo mode: install an already-built binary; skip download entirely.
  exe=$exe_override
  exe=$(CDPATH= cd -- "$(dirname -- "$exe")" && pwd -P)/$(basename -- "$exe")
  [ -f "$exe" ] || fail "executable not found: $exe (--exe mode)"
  resolved_version=""
else
  if [ -n "$version_arg" ]; then
    resolved_version=$version_arg
  else
    api_file="$staging/latest.json"
    api_get "/repos/${REPO}/releases/latest" "$api_file" || fail "cannot reach GitHub Releases to determine the latest version."
    # Parse tag_name from the release JSON without jq (v1): "tag_name": "vX.Y.Z"
    resolved_version=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$api_file" | head -n 1)
    [ -n "$resolved_version" ] || fail "could not parse latest release version from api.github.com (unexpected response)."
  fi
  case "$resolved_version" in
    v[0-9]*.[0-9]*.[0-9]*) ;;
    *) fail "refusing to install unparseable version '$resolved_version' (expected vX.Y.Z)." ;;
  esac
  ver=${resolved_version#v}
  tarball_name="opencomms-linux-${ver}-${tar_arch}.tar.gz"
  tarball_url="${RELEASES_BASE}/${resolved_version}/${tarball_name}"
  sums_url="${RELEASES_BASE}/${resolved_version}/SHA256SUMS"
  info "installing version ${resolved_version} from ${REPO} Releases"
  fetch "$tarball_url" "$staging/$tarball_name" || fail "could not download $tarball_name after retries."
  fetch "$sums_url" "$staging/SHA256SUMS" || fail "could not download SHA256SUMS after retries."
  ( cd "$staging" && sha256sum -c SHA256SUMS >/dev/null 2>&1 ) || fail "checksum verification FAILED for the downloaded artifacts. Nothing was installed. This may indicate a corrupted download or a tampered artifact — do not retry blindly; report it."
  extract_dir="$staging/payload"
  mkdir -p "$extract_dir"
  tar -xzf "$staging/$tarball_name" -C "$extract_dir" || fail "tarball extraction failed (downloaded artifact is not a valid gzip tarball)."
  exe="$extract_dir/opencomms/opencomms"
  [ -f "$exe" ] || fail "tarball layout unexpected: opencomms/opencomms missing. Artifact may be incomplete — refusing to install."
  resolved_version_note="downloaded ${resolved_version}"
fi

# ---------- execute-before-install ----------
chmod 755 -- "$exe"
if ! "$exe" version >/dev/null 2>&1; then
  fail "candidate binary failed 'opencomms version' BEFORE install (staging: $exe). Nothing was installed; the artifact is defective."
fi
if ! "$exe" doctor >/dev/null 2>&1; then
  fail "candidate binary failed 'opencomms doctor' BEFORE install (staging: $exe). Nothing was installed — artifact is defective."
fi
info "candidate binary passed execute-before-install checks."

# ---------- atomic install with rollback ----------
bin_dir=${bin_dir_override:-${OPENCOMMS_INSTALL_DIR:-"$real_home/.local/bin"}}
if [ "$(id -u)" = "0" ] && [ -z "$bin_dir_override" ] && [ -z "${OPENCOMMS_INSTALL_DIR:-}" ]; then
  info "root without an explicit bin dir: defaulting to ${real_home}/.local/bin (invoking user's home)."
fi
mkdir -p "$bin_dir" || fail "could not create $bin_dir"
target="$bin_dir/opencomms"
# Reviewer P3-A: staging names are PID-predictable and cp would write
# through a PRE-PLANTED symlink. mktemp creates the file itself (O_EXCL),
# so a planted name cannot exist beforehand; the path is unpredictable.
new_file=$(mktemp "$bin_dir/.opencomms-new-XXXXXXXX") || fail "could not create the staging file in $bin_dir"
rm -f -- "$new_file" || true
if [ -f "$target" ]; then
  prev_backup=$(mktemp "$bin_dir/.opencomms-prev-XXXXXXXX") || fail "could not create the backup staging file in $bin_dir"
  rm -f -- "$prev_backup" || true
else
  prev_backup=""
fi

# Back up the existing binary BEFORE replacing (rollback source).
if [ -n "$prev_backup" ]; then
  cp -p -- "$target" "$prev_backup" || fail "could not back up the existing binary at $target (aborting without changes)."
fi

cp -- "$exe" "$new_file" || fail "could not copy the candidate into $bin_dir"
chmod 755 -- "$new_file" || fail "could not chmod the staged binary"
# Atomic replace: rename(2) within the same filesystem is atomic.
if ! mv -f -- "$new_file" "$target" 2>/dev/null; then
  fail "atomic replace of $target failed. Existing installation is UNCHANGED."
fi

# Post-install validation with rollback.
validate() {
  "$target" version >/dev/null 2>&1
}
if ! validate; then
  if [ -n "$prev_backup" ] && [ -f "$prev_backup" ]; then
    mv -f -- "$prev_backup" "$target" 2>/dev/null || true
    info "post-install validation FAILED; rolled back to the previous binary."
  else
    rm -f -- "$target" 2>/dev/null || true
    info "post-install validation FAILED; no previous binary existed, new binary removed."
  fi
  fail "installed binary did not answer 'version' — installation rolled back."
fi
if [ -n "$prev_backup" ]; then
  rm -f -- "$prev_backup" 2>/dev/null || true
fi

# Downgrade guard (post-validation): refuse silent downgrades.
if [ -n "$resolved_version" ] && [ "${OPENCOMMS_ALLOW_DOWNGRADE:-0}" != "1" ]; then
  installed_line=$("$target" version 2>/dev/null | head -n 1)
  installed_ver=$(printf '%s' "$installed_line" | sed -n 's/^opencomms \([0-9]*\.[0-9]*\.[0-9]*\).*/\1/p')
  requested_ver=${resolved_version#v}
  if [ -n "$installed_ver" ]; then
    older=$(printf '%s\n%s\n' "$requested_ver" "$installed_ver" | sort -V | head -n 1)
    if [ "$older" = "$requested_ver" ] && [ "$requested_ver" != "$installed_ver" ]; then
      fail "requested version $resolved_version is OLDER than the installed $installed_ver. Refusing downgrade (set OPENCOMMS_ALLOW_DOWNGRADE=1 to force)."
    fi
  fi
fi

# ---------- idempotent PATH handling ----------
path_note=""
if [ "$no_path_edit" -eq 0 ]; then
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      profile="$real_home/.profile"
      if grep -qsF -- "$bin_dir" "$profile"; then
        path_note="$bin_dir is in ~/.profile but not the current PATH; open a new shell or: export PATH=\"\$PATH:$bin_dir\""
      else
        printf '\n# OpenComms CLI\nexport PATH="$PATH:%s"\n' "$bin_dir" >> "$profile"
        path_note="added $bin_dir to $profile (takes effect in new shells; now: export PATH=\"\$PATH:$bin_dir\")"
      fi
      ;;
  esac
fi

# ---------- optional systemd service (orthogonal; tarball/checkout mode) ----------
if [ "$do_service" -eq 1 ]; then
  if [ -z "$project_dir_arg" ]; then
    fail "--project <dir> is required with --service (the unit anchors WorkingDirectory there)"
  fi
  project_dir=$(CDPATH= cd -- "$project_dir_arg" && pwd -P)
  template=""
  for candidate in "$script_dir/opencomms.service" "$script_dir/../installer/linux/opencomms.service"; do
    if [ -f "$candidate" ]; then
      template=$candidate
      break
    fi
  done
  if [ -z "$template" ]; then
    fail "unit template opencomms.service not found next to install.sh or at ../installer/linux/. Use --service from a checkout or the extracted tarball, not the curl-piped form."
  fi
  unit_dir="${XDG_CONFIG_HOME:-"$real_home/.config"}/systemd/user"
  unit_file="$unit_dir/opencomms.service"
  if [ -f "$unit_file" ]; then
    had_unit=1
  else
    had_unit=0
  fi
  mkdir -p "$unit_dir"
  esc_sed() {
    printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
  }
  bin_esc=$(esc_sed "$target")
  project_esc=$(esc_sed "$project_dir")
  sed -e "s|@BIN@|$bin_esc|g" -e "s|@PROJECT_DIR@|$project_esc|g" -- "$template" > "$unit_file"
  if [ "$had_unit" -eq 1 ]; then
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  info "unit written: $unit_file"
  printf 'Enable it with:\n  systemctl --user daemon-reload\n  systemctl --user enable --now opencomms\n'
  printf 'Pre-login (headless) operation, optional: loginctl enable-linger %s\n' "${SUDO_USER:-$(id -un)}"
fi

# ---------- summary ----------
info "installed: $target"
if [ -n "$resolved_version" ]; then
  info "$resolved_version"
fi
if [ -n "$path_note" ]; then
  info "$path_note"
fi
printf 'Try: opencomms version && opencomms doctor\n'
printf 'Updates: opencomms update (or re-run this installer)\n'
printf 'Project .opencomms state is never touched by install/update.\n'