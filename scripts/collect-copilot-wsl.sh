#!/bin/sh
# Collect GitHub Copilot usage artifacts from INSIDE a WSL distro (or any Linux host).
#
# Companion to collect-copilot-wsl.mjs, which runs on Windows and reaches into distros over
# \\wsl.localhost. This one runs inside the distro instead:
#
#   - no Node needed in the distro (it often is not installed there)
#   - reads the filesystem directly, so it still works when the 9P/UNC share is blocked
#   - can read a home it owns that /root's mode 700 hides from Windows
#
# It therefore does NOT probe the UNC path the analytics reader uses. Run the .mjs version on
# Windows for that; run this one when you just need the data.
#
# POSIX sh, no bashisms, no dependencies beyond coreutils. sqlite3 is optional (see below).
#
# Usage, from inside the distro:
#   sh collect-copilot-wsl.sh                       # this user's ~/.copilot
#   sh collect-copilot-wsl.sh --all-homes           # every /home/*/.copilot readable here
#   sh collect-copilot-wsl.sh --home /path/.copilot # an explicit home (repeatable)
#   sh collect-copilot-wsl.sh --days 30             # sessions touched in the last 30 days
#   sh collect-copilot-wsl.sh --max-sessions 20     # cap transcripts per home (default 40)
#   sh collect-copilot-wsl.sh --out /tmp/probe      # output directory
#   sh collect-copilot-wsl.sh --vscode-remote       # also probe VS Code Remote-WSL chat data
#   sh collect-copilot-wsl.sh --raw                 # verbatim copies, prompts included
#
# Also probes for VS Code's "Remote - WSL" chat data, which lives inside the distro at
# ~/.vscode-server*/data/User/... and which nothing in this repo reads yet (the analytics
# reader only knows the Windows/macOS/Linux DESKTOP VS Code paths, not the remote-server one).
# Pass --vscode-remote to look for it; it is off by default because, unlike the Copilot
# artifacts above, that store's content cannot be safely line-filtered (see below).
#
# WHAT THE SAFE DEFAULT COLLECTS
#
# Copilot interleaves usage numbers with prompt and response text, so the default keeps only
# the fields the scanners read:
#
#   session-store.db  -> JSONL of the allowlisted assistant_usage_events columns plus
#                        sessions.id/cwd/repository/branch/host_type, via sqlite3. The `turns`
#                        table (user messages, assistant responses) and sessions.summary are
#                        never queried. Without sqlite3 the store is skipped unless --raw.
#   events.jsonl      -> only lines whose type is session.start, session.usage_record,
#                        session.usage_checkpoint or session.shutdown. session.start carries no
#                        message content (just sessionId/producer/version/context), so it is
#                        kept whole; everything else, including all message text, is dropped.
#   workspace.yaml    -> only its client_name line.
#   data.db           -> NOT read. The desktop app's database holds a GitHub access token. Only
#                        its presence and size are recorded.
#
# WHAT --vscode-remote ADDS
#
# VS Code's chat-session store is an append-log of JSON PATCHES (kind:0 full snapshot, kind:1
# property update, kind:2 appended batch), not flat records like events.jsonl. There is no safe
# line-level filter for it: the prompt and response text live inside the SAME request objects
# as the token counts a verification run needs, so stripping one without full JSON replay would
# either keep the text or lose the tokens. Rather than ship a partial filter, this flag always
# reports file counts and sizes (safe), and copies file CONTENT only together with --raw.
#
# Working directories, repository names and branch names ARE collected: the scanners read them,
# so verification has to be able to check that they arrive.
#
# --raw copies session-store.db (+ -wal/-shm), whole events.jsonl files and whole
# workspace.yaml files. That includes prompts, responses and session titles. Treat it as
# sensitive.
#
# Nothing is written into the Copilot home. The store is copied to a temporary directory before
# being read, because the live file is locked and in WAL mode while Copilot runs.

set -eu

OUT=""
RAW=0
DAYS=""
MAX_SESSIONS=40
ALL_HOMES=0
EXPLICIT_HOMES=""
VSCODE_REMOTE=0

# Line-anchored event-type match. Deliberately matches the "type" FIELD rather than the bare
# words, so a message that happens to mention one of these names is not mistaken for the event.
# The .mjs version re-parses each line and checks event.type; this is the sh-level equivalent.
EVENT_RE='"type"[[:space:]]*:[[:space:]]*"(session\.start|session\.usage_record|session\.usage_checkpoint|session\.shutdown)"'

USAGE_COLUMNS='id, session_id, turn_index, agent_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, request_multiplier, duration_ms, initiator, created_at, event_id, content_filter_triggered, finish_reason'
SESSION_COLUMNS='id, cwd, repository, branch, host_type, created_at, updated_at'

die() {
  echo "error: $*" >&2
  exit 2
}

usage() {
  sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:-}"; [ -n "$OUT" ] || die "--out needs a directory"; shift 2 ;;
    --home) [ -n "${2:-}" ] || die "--home needs a directory"
            EXPLICIT_HOMES="$EXPLICIT_HOMES
$2"; shift 2 ;;
    --days) DAYS="${2:-}"; shift 2 ;;
    --max-sessions) MAX_SESSIONS="${2:-}"; shift 2 ;;
    --all-homes) ALL_HOMES=1; shift ;;
    --vscode-remote) VSCODE_REMOTE=1; shift ;;
    --raw) RAW=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$DAYS" in
  "") ;;
  *[!0-9]*|0) die "--days must be a positive whole number" ;;
esac
case "$MAX_SESSIONS" in
  *[!0-9]*|""|0) die "--max-sessions must be a positive whole number" ;;
esac

# --- small helpers -----------------------------------------------------------------------

# Escape a string for embedding in JSON (backslash, quote, control chars out).
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | tr -d '\000-\010\013\014\016-\037'
}

# ISO-8601 UTC timestamp N days ago. GNU date first, then BSD date, else empty.
iso_days_ago() {
  _n="$1"
  date -u -d "@$(( $(date -u +%s) - _n * 86400 ))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null && return 0
  date -u -v-"${_n}"d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null && return 0
  printf ''
}

# Size in bytes of a file, or empty when it is absent.
file_bytes() {
  [ -f "$1" ] || { printf ''; return 0; }
  wc -c < "$1" 2>/dev/null | tr -d ' \t' || printf ''
}

# "present" facts for the manifest: bytes and mtime, never the path itself.
file_facts_json() {
  if [ -f "$1" ]; then
    _b=$(file_bytes "$1")
    _m=$(date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '')
    printf '{"present":true,"bytes":%s,"mtime":"%s"}' "${_b:-0}" "$_m"
  else
    printf '{"present":false}'
  fi
}

# --- environment -------------------------------------------------------------------------

DISTRO="${WSL_DISTRO_NAME:-}"
if [ -z "$DISTRO" ] && [ -r /etc/os-release ]; then
  DISTRO=$(. /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-${NAME:-}}")
fi
[ -n "$DISTRO" ] || DISTRO="unknown"

IN_WSL=0
if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
  IN_WSL=1
fi

HAVE_SQLITE=0
if command -v sqlite3 >/dev/null 2>&1; then
  HAVE_SQLITE=1
fi

STAMP=$(date -u +%Y-%m-%dT%H-%M-%S)
[ -n "$OUT" ] || OUT="$PWD/copilot-wsl-collection-$STAMP"
mkdir -p "$OUT"

SINCE=""
if [ -n "$DAYS" ]; then
  SINCE=$(iso_days_ago "$DAYS")
fi

echo "distro:  $DISTRO (in WSL: $IN_WSL)"
echo "sqlite3: $( [ "$HAVE_SQLITE" -eq 1 ] && echo present || echo MISSING )"
echo "mode:    $( [ "$RAW" -eq 1 ] && echo 'raw (includes prompt text)' || echo 'filtered (no prompt text)' )"
echo "output:  $OUT"
echo

# --- which homes -------------------------------------------------------------------------

HOMES=""
add_home() {
  [ -d "$1" ] || return 0
  HOMES="$HOMES
$1"
}

if [ -n "$EXPLICIT_HOMES" ]; then
  printf '%s\n' "$EXPLICIT_HOMES" | while IFS= read -r h; do [ -n "$h" ] && echo "$h"; done > "$OUT/.homes.tmp"
  while IFS= read -r h; do add_home "$h"; done < "$OUT/.homes.tmp"
  rm -f "$OUT/.homes.tmp"
else
  add_home "${HOME:-/root}/.copilot"
  if [ "$ALL_HOMES" -eq 1 ]; then
    for d in /home/*/.copilot /root/.copilot; do
      [ -d "$d" ] || continue
      # Skip the one already added, and anything unreadable.
      [ "$d" = "${HOME:-/root}/.copilot" ] && continue
      [ -r "$d" ] || continue
      add_home "$d"
    done
  fi
fi

HOMES=$(printf '%s\n' "$HOMES" | sed '/^$/d')
HOME_COUNT=$(printf '%s\n' "$HOMES" | sed '/^$/d' | wc -l | tr -d ' \t')
if [ "${HOME_COUNT:-0}" -eq 0 ]; then
  echo "No Copilot home found. Looked for \${HOME}/.copilot${ALL_HOMES:+ and /home/*/.copilot}."
  echo "Pass --home /path/to/.copilot if it lives elsewhere."
fi

# --- per-home collection -----------------------------------------------------------------

HOME_JSON=""
INDEX=0

collect_home() {
  home="$1"
  INDEX=$((INDEX + 1))
  dir="$OUT/home-$INDEX"
  mkdir -p "$dir"

  db="$home/session-store.db"
  store_mode="absent"
  store_rows=""
  store_sessions=""
  store_version=""
  store_error=""

  if [ -f "$db" ]; then
    if [ "$RAW" -eq 1 ]; then
      store_mode="raw-copy"
      cp "$db" "$dir/session-store.db" 2>/dev/null || store_error="copy failed"
      for sfx in -wal -shm; do
        [ -f "$db$sfx" ] && cp "$db$sfx" "$dir/session-store.db$sfx" 2>/dev/null || true
      done
    elif [ "$HAVE_SQLITE" -eq 0 ]; then
      store_mode="skipped-no-sqlite3"
      store_error="sqlite3 is not installed here; install it (apt-get install -y sqlite3) or pass --raw"
    else
      store_mode="filtered-export"
      # Snapshot first: the live store is locked and in WAL mode while Copilot runs, and the
      # -wal sibling holds the newest sessions.
      tmp=$(mktemp -d)
      if cp "$db" "$tmp/s.db" 2>/dev/null; then
        for sfx in -wal -shm; do
          [ -f "$db$sfx" ] && cp "$db$sfx" "$tmp/s.db$sfx" 2>/dev/null || true
        done
        store_version=$(sqlite3 "$tmp/s.db" 'SELECT version FROM schema_version LIMIT 1' 2>/dev/null || printf '')
        for t in assistant_usage_events sessions; do
          sqlite3 -json "$tmp/s.db" "PRAGMA table_info($t)" > "$dir/table_info.$t.json" 2>/dev/null || true
        done
        where=""
        [ -n "$SINCE" ] && where=" WHERE created_at >= '$SINCE'"
        if sqlite3 -json "$tmp/s.db" \
            "SELECT $USAGE_COLUMNS FROM assistant_usage_events$where ORDER BY id" \
            > "$dir/assistant_usage_events.json" 2>"$tmp/err"; then
          store_rows=$(grep -o '"session_id"' "$dir/assistant_usage_events.json" 2>/dev/null | wc -l | tr -d ' \t')
        else
          store_error=$(head -c 200 "$tmp/err" 2>/dev/null | tr '\n' ' ')
        fi
        if sqlite3 -json "$tmp/s.db" "SELECT $SESSION_COLUMNS FROM sessions" \
            > "$dir/sessions.json" 2>/dev/null; then
          store_sessions=$(grep -o '"host_type"' "$dir/sessions.json" 2>/dev/null | wc -l | tr -d ' \t')
        fi
      else
        store_error="could not copy the store for reading"
      fi
      rm -rf "$tmp"
    fi
  fi

  # --- transcripts and workspace.yaml ---
  state="$home/session-state"
  t_found=0
  t_collected=0
  t_lines_seen=0
  t_lines_kept=0
  w_found=0
  w_named=0

  if [ -d "$state" ]; then
    mkdir -p "$dir/events"
    : > "$dir/workspace-client-names.tsv"
    printf 'session_id\tclient_name\n' >> "$dir/workspace-client-names.tsv"

    # Newest first, so a run capped by --max-sessions keeps the most recent sessions rather
    # than whichever UUIDs happen to sort first. `ls -1t` orders by mtime and is POSIX, unlike
    # the `find -printf '%T@'` trick, which is a GNU extension.
    ls -1t "$state" 2>/dev/null > "$dir/.sessions.tmp" || : > "$dir/.sessions.tmp"
    while IFS= read -r sid; do
      [ -n "$sid" ] || continue
      sdir="$state/$sid"
      # `ls` lists every entry; only session directories are of interest. The test follows
      # symlinks, so a symlinked session-state is handled too.
      [ -d "$sdir" ] || continue

      yaml="$sdir/workspace.yaml"
      if [ -f "$yaml" ]; then
        w_found=$((w_found + 1))
        # Only the client_name line, and only near the top: name/summary below it are
        # prompt-derived. Same 64-line bound the reader uses.
        cname=$(head -n 64 "$yaml" 2>/dev/null | sed -n 's/^client_name:[[:space:]]*//p' | head -n 1 || printf '')
        if [ -n "$cname" ]; then
          w_named=$((w_named + 1))
          printf '%s\t%s\n' "$sid" "$cname" >> "$dir/workspace-client-names.tsv"
        fi
        if [ "$RAW" -eq 1 ]; then
          mkdir -p "$dir/workspace"
          cp "$yaml" "$dir/workspace/$sid.workspace.yaml" 2>/dev/null || true
        fi
      fi

      ev="$sdir/events.jsonl"
      [ -f "$ev" ] || continue
      if [ -n "$DAYS" ]; then
        # -mtime is the portable age test; a transcript untouched in the window is skipped.
        find -L "$ev" -mtime -"$DAYS" 2>/dev/null | grep -q . || continue
      fi
      t_found=$((t_found + 1))
      [ "$t_collected" -ge "$MAX_SESSIONS" ] && continue

      seen=$(wc -l < "$ev" 2>/dev/null | tr -d ' \t')
      t_lines_seen=$((t_lines_seen + ${seen:-0}))
      if [ "$RAW" -eq 1 ]; then
        cp "$ev" "$dir/events/$sid.events.jsonl" 2>/dev/null || continue
        t_lines_kept=$((t_lines_kept + ${seen:-0}))
      else
        # The whole filter: keep the four usage event types, drop every other line. This is the
        # same prefilter the events reader applies before it parses anything.
        grep -E "$EVENT_RE" "$ev" > "$dir/events/$sid.usage.jsonl" 2>/dev/null || : > "$dir/events/$sid.usage.jsonl"
        kept=$(wc -l < "$dir/events/$sid.usage.jsonl" 2>/dev/null | tr -d ' \t')
        t_lines_kept=$((t_lines_kept + ${kept:-0}))
      fi
      t_collected=$((t_collected + 1))
    done < "$dir/.sessions.tmp"
    rm -f "$dir/.sessions.tmp"
    # An empty table is noise; drop it when nothing named a client.
    if [ "$w_named" -eq 0 ]; then
      rm -f "$dir/workspace-client-names.tsv"
    fi
  fi

  printf '    home-%s: store %s%s; %s/%s transcript(s); %s/%s workspace.yaml with client_name\n' \
    "$INDEX" \
    "$( [ -n "$store_rows" ] && printf '%s usage row(s)' "$store_rows" || printf '%s' "$store_mode" )" \
    "$( [ -n "$store_version" ] && printf ' (schema v%s)' "$store_version" || printf '' )" \
    "$t_collected" "$t_found" "$w_named" "$w_found"
  if [ -n "$store_error" ]; then
    printf '      store: %s\n' "$store_error"
  fi

  # Location label only: a home path carries the distro user's name.
  case "$home" in
    /root/*) loc="/root/.copilot" ;;
    *) loc="/home/<user>/.copilot" ;;
  esac

  HOME_JSON="$HOME_JSON{\"index\":$INDEX,\"location\":\"$(json_escape "$loc")\",\
\"files\":{\"session-store.db\":$(file_facts_json "$db"),\
\"session-store.db-wal\":$(file_facts_json "$db-wal"),\
\"data.db\":$(file_facts_json "$home/data.db")},\
\"store\":{\"mode\":\"$store_mode\",\"schemaVersion\":${store_version:-null},\
\"rows\":${store_rows:-null},\"sessions\":${store_sessions:-null},\
\"error\":$( [ -n "$store_error" ] && printf '"%s"' "$(json_escape "$store_error")" || printf 'null' )},\
\"transcripts\":{\"found\":$t_found,\"collected\":$t_collected,\"linesSeen\":$t_lines_seen,\"linesKept\":$t_lines_kept},\
\"workspaceYaml\":{\"found\":$w_found,\"withClientName\":$w_named}},"
}

echo "homes:"
if [ "${HOME_COUNT:-0}" -gt 0 ]; then
  # A pipeline would run collect_home in a subshell and lose every counter, so feed the loop
  # from a file instead.
  printf '%s\n' "$HOMES" > "$OUT/.homelist.tmp"
  while IFS= read -r h; do
    [ -n "$h" ] || continue
    collect_home "$h"
  done < "$OUT/.homelist.tmp"
  rm -f "$OUT/.homelist.tmp"
else
  echo "    (none)"
fi


# --- VS Code Remote-WSL chat data (opt-in; see --vscode-remote above) --------------------

VSCODE_REMOTE_JSON="null"

# One scan root per edition x profile, mirroring profileRoots()/vsCodeChatLocations() in
# copilot-local-paths.ts so this probe answers the same question that code would ask, just
# from inside the distro instead of over a UNC share.
vscode_remote_locations() {
  for server_dir in "${HOME:-}/.vscode-server" "${HOME:-}/.vscode-server-insiders"; do
    [ -d "$server_dir/data/User" ] || continue
    for profile_root in "$server_dir/data/User" "$server_dir/data/User/profiles"/*; do
      [ -d "$profile_root" ] || continue
      if [ -d "$profile_root/workspaceStorage" ]; then
        for ws in "$profile_root/workspaceStorage"/*/chatSessions; do
          [ -d "$ws" ] || continue
          echo "$ws"
        done
      fi
      for g in emptyWindowChatSessions transferredChatSessions; do
        [ -d "$profile_root/globalStorage/$g" ] && echo "$profile_root/globalStorage/$g"
      done
    done
  done
}

if [ "$VSCODE_REMOTE" -eq 1 ]; then
  echo
  echo "vscode-remote:"
  vr_dir="$OUT/vscode-remote"
  vr_locations=0
  vr_files=0
  vr_bytes=0
  vr_json=""

  vscode_remote_locations > "$OUT/.vrlocs.tmp" 2>/dev/null || : > "$OUT/.vrlocs.tmp"
  while IFS= read -r loc; do
    [ -n "$loc" ] || continue
    vr_locations=$((vr_locations + 1))
    loc_files=0
    loc_bytes=0
    for f in "$loc"/*.jsonl; do
      [ -f "$f" ] || continue
      loc_files=$((loc_files + 1))
      b=$(file_bytes "$f")
      loc_bytes=$((loc_bytes + ${b:-0}))
      if [ "$RAW" -eq 1 ]; then
        mkdir -p "$vr_dir"
        # Flatten into one directory; a workspace hash is not sensitive on its own, but keeping
        # the tree shallow makes the collection easier to skim.
        cp "$f" "$vr_dir/$(basename "$loc")_$(basename "$f")" 2>/dev/null || true
      fi
    done
    vr_files=$((vr_files + loc_files))
    vr_bytes=$((vr_bytes + loc_bytes))
    # <server-dir>/<workspace-hash-or-globalStorage-child>/<chatSessions>, e.g.
    # ".vscode-server/ws-hash-1/chatSessions" or ".vscode-server/emptyWindowChatSessions" -
    # enough to tell locations apart without a profile id (never exposed, matching the Python
    # original's D-14) or the user's home directory name.
    label=$(echo "$loc" | sed -E 's#.*/(\.vscode-server[^/]*)/.*/([^/]+/[^/]+)$#\1/\2#')
    printf '  %-45s %s file(s), %s byte(s)\n' "$label" "$loc_files" "$loc_bytes"
    vr_json="$vr_json{\"location\":\"$(json_escape "$label")\",\"files\":$loc_files,\"bytes\":$loc_bytes},"
  done < "$OUT/.vrlocs.tmp"
  rm -f "$OUT/.vrlocs.tmp"

  if [ "$vr_locations" -eq 0 ]; then
    echo "    (none found under ~/.vscode-server*/data/User)"
  elif [ "$RAW" -eq 0 ]; then
    echo "    content not copied (pass --raw too; this store cannot be safely line-filtered - see script header)"
  fi
  VSCODE_REMOTE_JSON="{\"probed\":true,\"locations\":$vr_locations,\"files\":$vr_files,\"bytes\":$vr_bytes,\"contentCollected\":$( [ "$RAW" -eq 1 ] && echo true || echo false ),\"byLocation\":[ $(printf '%s' "$vr_json" | sed 's/,$//') ]}"
fi

# --- manifest and wrap-up ----------------------------------------------------------------

cat > "$OUT/manifest.json" <<JSON
{
  "tool": "collect-copilot-wsl.sh",
  "version": 1,
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "mode": "$( [ "$RAW" -eq 1 ] && echo 'raw (includes prompt text)' || echo 'filtered (no prompt text)' )",
  "options": { "days": ${DAYS:-null}, "maxSessions": $MAX_SESSIONS, "raw": $( [ "$RAW" -eq 1 ] && echo true || echo false ), "allHomes": $( [ "$ALL_HOMES" -eq 1 ] && echo true || echo false ) },
  "host": {
    "collectedInsideWsl": $( [ "$IN_WSL" -eq 1 ] && echo true || echo false ),
    "distro": "$(json_escape "$DISTRO")",
    "kernel": "$(json_escape "$(uname -sr 2>/dev/null || printf '')")",
    "sqlite3": $( [ "$HAVE_SQLITE" -eq 1 ] && echo "\"$(json_escape "$(sqlite3 --version 2>/dev/null | cut -d' ' -f1)")\"" || echo null )
  },
  "note": "Collected from inside the distro, so the \\\\\\\\wsl.localhost UNC path the analytics reader uses was NOT exercised. Run collect-copilot-wsl.mjs on Windows to probe that.",
  "vscodeRemote": $VSCODE_REMOTE_JSON,
  "homes": [ $(printf '%s' "$HOME_JSON" | sed 's/,$//') ]
}
JSON

cat > "$OUT/README.txt" <<'TXT'
GitHub Copilot WSL collection (sh collector)
============================================

Produced by collect-copilot-wsl.sh from INSIDE the distro, for verifying the
"codemie analytics copilot" scanners against real WSL data.

manifest.json   what was found: distro, sqlite3 version, per-home file facts and counts.
home-N/
  assistant_usage_events.json   allowlisted usage columns (no prompt text)
  sessions.json                 session id, cwd, repository, branch, host_type
  table_info.*.json             column lists, so schema drift is visible
  events/<session>.usage.jsonl  only session.start/usage_record/usage_checkpoint/shutdown lines
  workspace-client-names.tsv    session id -> client_name, the surface signal

In the default mode no prompt or response text is collected, and the desktop app's data.db is
not read at all (it holds a GitHub access token). Working directories, repository names and
branch names ARE included - the scanners read them, so verification needs them.

Because this ran inside the distro, it did not exercise the \\wsl.localhost UNC path the
analytics reader uses. Run collect-copilot-wsl.mjs on Windows for that.

vscode-remote/   (--vscode-remote only) VS Code's "Remote - WSL" chat-session files, found
                 under ~/.vscode-server*/data/User/.../chatSessions. This path is not read by
                 anything in codemie-code yet - only the desktop VS Code paths are. manifest.json
                 always records counts and sizes; file CONTENT is copied only with --raw too,
                 because that store's prompt text and token counts live in the same JSON
                 objects and cannot be safely separated by a line filter.

If this was produced with --raw it contains verbatim databases and transcripts, INCLUDING
prompts, responses and session titles. Treat it as sensitive.
TXT

BYTES=$(du -sk "$OUT" 2>/dev/null | cut -f1 || printf '0')
echo
echo "Wrote $OUT (${BYTES} KB)"
echo "Pack it with:"
echo "  tar -czf '$OUT.tar.gz' -C '$(dirname "$OUT")' '$(basename "$OUT")'"
if [ "$RAW" -eq 1 ]; then
  echo
  echo "WARNING: --raw output contains prompts, responses and session titles. Treat it as sensitive."
fi
