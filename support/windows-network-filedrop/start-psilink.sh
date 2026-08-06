#!/usr/bin/env bash
#
# start-psilink.sh -- open the psilink console in your browser, on macOS or
# Linux. It picks the folders, checks them with the container's own doctor, then
# starts the console and opens it.
#
# It is plaintext on purpose, so that whoever has to approve it can read all of
# it: it fetches nothing itself, keeps nothing between runs, and never updates
# itself. The container image it runs is pinned by digest, stamped in by the
# release that published this file. A new version arrives the way everything
# else in your organisation does -- somebody hands you a new copy.
#
# Sourcing this file defines its functions and runs nothing; executing it runs
# the launcher. That is what lets the repository's test suite drive the pieces
# below one at a time.
#
# Windows is not this script's job. Use Start-Psilink.ps1 there: a Windows path
# can name a mapped drive, a UNC share or a DFS namespace, none of which Docker
# can bind-mount, and resolving those is most of what that script does.

set -u

# --- Release stamp ---------------------------------------------------------
# The release workflow rewrites the digest line below, whole, to the digest it
# signed with cosign. A copy that still carries the placeholder did not come
# from a release and refuses to run: an unpinned launcher would run whatever is
# behind a floating tag today, which is the one thing an operator reading this
# file cannot check for themselves.
PSILINK_IMAGE_REPOSITORY='docker.io/vdorie/psi-link'
PSILINK_IMAGE_DIGEST='@@PSILINK_IMAGE_DIGEST@@'

PSILINK_RELEASES_URL='https://github.com/georgetown-mdi/jspsi/releases'
PSILINK_TROUBLESHOOTING_URL='https://github.com/georgetown-mdi/jspsi/blob/main/support/windows-network-filedrop/troubleshooting.md'

# The verdict schema this launcher was written against. `psilink doctor --json`
# carries its own; anything else is refused rather than parsed on, because a
# later version may have re-meaned a field this one reads.
PSILINK_VERDICT_VERSION='1'

PSILINK_DEFAULT_PORT='3000'
# How long to wait for the console to answer before saying so. A first run also
# fetches the image, which is why this is minutes rather than seconds.
PSILINK_CONSOLE_WAIT_SECONDS='600'

PSILINK_ENGINE=''
PSILINK_PORT="$PSILINK_DEFAULT_PORT"
PSILINK_OPEN_BROWSER='yes'
PSILINK_HELP_ONLY='no'
PSILINK_DATA_ROOT=''
PSILINK_INPUT_DIR=''
PSILINK_RENDEZVOUS_DIR=''
PSILINK_CONTAINER_NAME=''
PSILINK_CONSOLE_PID=''
PSILINK_ANSWER=''
PSILINK_DIRECTORY=''
PSILINK_VERDICT_OVERALL=''
PSILINK_JSON_SKELETON=''
PSILINK_JSON_STRINGS=()
PSILINK_CONSOLE_ARGUMENTS=()

# ===========================================================================
# Output
# ===========================================================================

psilink_say() { printf '%s\n' "$*"; }
psilink_head() {
  printf '\n%s\n' '======================================================================'
  printf '%s\n' "$*"
  printf '%s\n' '======================================================================'
}
psilink_good() { printf '  OK    %s\n' "$*"; }
psilink_bad() { printf '  FAIL  %s\n' "$*"; }
psilink_warn() { printf '  WARN  %s\n' "$*"; }
psilink_note() { printf '        %s\n' "$*"; }

# Text the container supplied, shown as the container wrote it. Control bytes
# are dropped rather than displayed: this is classified prose the image owns,
# but it passes through a terminal that reads an escape sequence as a command
# and nothing downstream re-checks it. Tab and newline survive; the JSON decoder
# below has already turned every escaped control character into a space, so this
# covers the raw ones only.
psilink_say_from_container() {
  printf '%s\n' "$1" | LC_ALL=C tr -d '\000-\010\013-\037\177'
}

# Prompt, and read one line into PSILINK_ANSWER. A closed input -- a run with
# nothing on stdin -- answers nothing and fails, so a caller stops rather than
# spinning on a prompt nobody will ever answer.
psilink_ask() {
  printf '%s' "$1"
  if ! IFS= read -r PSILINK_ANSWER; then
    PSILINK_ANSWER=''
    printf '\n'
    return 1
  fi
  return 0
}

# $1 prompt, $2 default ('yes' or 'no'). Anything unrecognised takes the
# default. A closed input answers no whatever the default: a caller that
# re-asks on its default would otherwise spin on a prompt nobody will answer.
psilink_confirm() {
  local prompt="$1" fallback="$2"
  if ! psilink_ask "$prompt"; then
    return 1
  fi
  case "$PSILINK_ANSWER" in
    [Yy] | [Yy][Ee][Ss]) return 0 ;;
    [Nn] | [Nn][Oo]) return 1 ;;
    *) [ "$fallback" = 'yes' ] ;;
  esac
}

# ===========================================================================
# The image reference
# ===========================================================================

# Fully qualified, registry included: podman requires the prefix and docker
# accepts it, so one reference serves both.
psilink_image() { printf '%s@%s' "$PSILINK_IMAGE_REPOSITORY" "$PSILINK_IMAGE_DIGEST"; }

# A stamped digest, established positively rather than by looking for the
# placeholder: a half-applied stamp is then refused on the same branch as an
# unstamped one, and the placeholder token appears in this file exactly once,
# where the release step expects it.
psilink_stamp_is_release() {
  local hex=''
  case "$PSILINK_IMAGE_DIGEST" in
    sha256:*) hex=${PSILINK_IMAGE_DIGEST#sha256:} ;;
    *) return 1 ;;
  esac
  [ "${#hex}" -eq 64 ] || return 1
  case "$hex" in
    *[!0-9a-f]*) return 1 ;;
  esac
  return 0
}

psilink_require_release_stamp() {
  if psilink_stamp_is_release; then
    psilink_good "Image pinned to $(psilink_image)"
    return 0
  fi
  psilink_bad 'This copy of the launcher did not come from a release.'
  psilink_note 'It carries no image digest, so there is nothing here to say which'
  psilink_note 'psilink it would run. Rather than run whatever is behind a'
  psilink_note 'floating tag today, it stops.'
  psilink_say ''
  psilink_note 'A release copy has the digest filled in. Download one from:'
  psilink_note "    $PSILINK_RELEASES_URL"
  psilink_note 'or ask whoever in your organisation distributes psilink for the'
  psilink_note 'copy they approved.'
  return 1
}

# ===========================================================================
# Container engine
# ===========================================================================

# An engine counts only when it answers: a name on PATH that cannot reach a
# daemon is the ordinary "Docker Desktop is not started yet" case, and must not
# be chosen over one that works.
psilink_engine_answers() {
  command -v "$1" >/dev/null 2>&1 || return 1
  "$1" version >/dev/null 2>&1
}

psilink_select_engine() {
  local candidate=''
  for candidate in docker podman; do
    if psilink_engine_answers "$candidate"; then
      PSILINK_ENGINE="$candidate"
      psilink_good "Using $candidate."
      return 0
    fi
  done
  PSILINK_ENGINE=''
  psilink_bad 'Neither docker nor podman answered on this machine.'
  psilink_note 'Install Docker Desktop (or podman) and start it, then run this'
  psilink_note 'again. If one is installed and running, your account may not be'
  psilink_note 'allowed to use it -- on Linux that is the docker group.'
  return 1
}

# ===========================================================================
# The verdict document
#
# One line of JSON, per docs/spec/CLI_DOCTOR.md. It is read rather than
# pattern-matched: the meaning and action strings are prose that can hold a
# brace, a comma or a quote, and a grep for one of those would cut a sentence
# in half.
#
# psilink_json_load walks the document once and replaces every string literal
# with an @index@ marker, leaving a skeleton of structure behind. The skeleton
# then splits on plain characters, and a string is decoded only when one is
# actually printed.
# ===========================================================================

psilink_json_load() {
  local doc="$1"
  local length=${#doc}
  local position=0
  local character=''
  local skeleton=''
  local current=''
  local in_string=0
  local index=0

  PSILINK_JSON_STRINGS=()
  PSILINK_JSON_SKELETON=''

  while [ "$position" -lt "$length" ]; do
    character=${doc:position:1}
    if [ "$in_string" -eq 1 ]; then
      if [ "$character" = '\' ]; then
        current="$current${doc:position:2}"
        position=$((position + 2))
        continue
      fi
      if [ "$character" = '"' ]; then
        PSILINK_JSON_STRINGS[$index]="$current"
        skeleton="$skeleton@$index@"
        index=$((index + 1))
        current=''
        in_string=0
        position=$((position + 1))
        continue
      fi
      current="$current$character"
      position=$((position + 1))
      continue
    fi
    case "$character" in
      '"') in_string=1 ;;
      ' ' | $'\t') ;;
      *) skeleton="$skeleton$character" ;;
    esac
    position=$((position + 1))
  done

  [ "$in_string" -eq 0 ] || return 1
  case "$skeleton" in
    '{'*'}') ;;
    *) return 1 ;;
  esac
  PSILINK_JSON_SKELETON="$skeleton"
  return 0
}

# Split a skeleton's top-level elements on their separating commas, one per
# line. Safe as lines because psilink_json_load has already taken every string
# out: what is left holds no newline.
psilink_json_split() {
  local body="$1"
  local length=${#body}
  local position=0
  local depth=0
  local character=''
  local piece=''

  while [ "$position" -lt "$length" ]; do
    character=${body:position:1}
    case "$character" in
      '{' | '[')
        depth=$((depth + 1))
        piece="$piece$character"
        ;;
      '}' | ']')
        depth=$((depth - 1))
        piece="$piece$character"
        ;;
      ',')
        if [ "$depth" -eq 0 ]; then
          printf '%s\n' "$piece"
          piece=''
        else
          piece="$piece$character"
        fi
        ;;
      *) piece="$piece$character" ;;
    esac
    position=$((position + 1))
  done
  [ -z "$piece" ] || printf '%s\n' "$piece"
}

# The value of one member of an object skeleton, or failure when the object does
# not carry that member. An explicit null reports as absent too: the verdict
# omits an optional field rather than nulling it, so a null is a document this
# launcher does not understand and must not read as a value.
psilink_json_member() {
  local object="$1" key="$2"
  local body=${object#\{}
  body=${body%\}}

  local piece='' name='' value='' index=''
  while IFS= read -r piece; do
    [ -n "$piece" ] || continue
    name=${piece%%:*}
    value=${piece#*:}
    case "$name" in
      @*@)
        index=${name#@}
        index=${index%@}
        ;;
      *) continue ;;
    esac
    if [ "${PSILINK_JSON_STRINGS[$index]}" = "$key" ]; then
      [ "$value" != 'null' ] || return 1
      printf '%s' "$value"
      return 0
    fi
  done <<PSILINK_MEMBERS
$(psilink_json_split "$body")
PSILINK_MEMBERS
  return 1
}

# Each element of an array skeleton, one per line.
psilink_json_elements() {
  local array="$1"
  local body=${array#\[}
  body=${body%\]}
  psilink_json_split "$body"
}

# The decoded text of a string value, or failure when the value is not a string.
psilink_json_text() {
  local value="$1" index=''
  case "$value" in
    @*@)
      index=${value#@}
      index=${index%@}
      ;;
    *) return 1 ;;
  esac
  psilink_json_unescape "${PSILINK_JSON_STRINGS[$index]}"
}

# JSON's own escapes, decoded. Every escape denoting a control character -- \b,
# \f, \r, and the \uXXXX form, which JSON.stringify emits for control characters
# and nothing else -- becomes a space rather than the character it names: this
# text is printed to a terminal, where a decoded escape sequence is a command
# rather than prose.
psilink_json_unescape() {
  local raw="$1"
  local length=${#raw}
  local position=0
  local out=''
  local character=''
  local escape=''

  while [ "$position" -lt "$length" ]; do
    character=${raw:position:1}
    if [ "$character" != '\' ]; then
      out="$out$character"
      position=$((position + 1))
      continue
    fi
    escape=${raw:position+1:1}
    case "$escape" in
      '"') out="$out\"" ;;
      '\') out="$out\\" ;;
      '/') out="$out/" ;;
      n) out="$out"$'\n' ;;
      t) out="$out"$'\t' ;;
      b | f | r) out="$out " ;;
      u)
        out="$out "
        position=$((position + 4))
        ;;
      *) out="$out$escape" ;;
    esac
    position=$((position + 2))
  done
  printf '%s' "$out"
}

# ===========================================================================
# The doctor
# ===========================================================================

# One check, as the operator reads it, with MEANING and ACTION as the container
# wrote them. The status alone decides the label: a consumer never infers
# severity from which optional fields a check happens to carry.
psilink_show_check() {
  local check="$1"
  local identifier='' status='' meaning='' action=''

  identifier=$(psilink_json_text "$(psilink_json_member "$check" id)") || return 1
  status=$(psilink_json_text "$(psilink_json_member "$check" status)") || return 1

  case "$status" in
    fail) psilink_bad "$identifier" ;;
    warn) psilink_warn "$identifier" ;;
    skipped) psilink_note "SKIP  $identifier" ;;
    *) psilink_good "$identifier" ;;
  esac

  if meaning=$(psilink_json_member "$check" meaning); then
    psilink_say_from_container "        MEANING: $(psilink_json_text "$meaning")"
  fi
  if action=$(psilink_json_member "$check" action); then
    psilink_say_from_container "        ACTION:  $(psilink_json_text "$action")"
  fi
  return 0
}

# Show every check whose status is one of those named, reporting whether any
# was. Checks are found by their status and printed in verdict order; nothing
# keys on an entry's position, which the spec does not fix.
psilink_show_checks_with_status() {
  local checks="$1"
  shift
  local wanted=" $* "
  local element='' status='' shown=1

  while IFS= read -r element; do
    [ -n "$element" ] || continue
    status=$(psilink_json_text "$(psilink_json_member "$element" status)") || continue
    case "$wanted" in
      *" $status "*)
        psilink_show_check "$element"
        shown=0
        ;;
    esac
  done <<PSILINK_CHECKS
$(psilink_json_elements "$checks")
PSILINK_CHECKS
  return $shown
}

# Run one battery and classify it. Sets PSILINK_VERDICT_OVERALL and returns:
#   0  a verdict was read, and PSILINK_VERDICT_OVERALL says what it was
#   1  nothing was established (the engine, the version, or a line that is not
#      a verdict this launcher understands)
psilink_run_doctor_mount() {
  local directory="$1"
  local verdict='' status=0 version='' overall='' checks=''

  PSILINK_VERDICT_OVERALL=''
  psilink_say "Checking $directory with the container's own checks..."
  verdict=$("$PSILINK_ENGINE" run --rm --volume "$directory:/rz" "$(psilink_image)" \
    doctor mount /rz --json)
  status=$?

  # Docker reserves 125 and above for its own failure to start a container, and
  # every verdict code is below it -- so this is "the checks never ran" rather
  # than anything about the folder.
  if [ "$status" -ge 125 ]; then
    psilink_bad "The container could not be started (exit $status)."
    psilink_note 'Nothing about your folder was tested. The message the engine'
    psilink_note 'printed above is the one to read. A first run also fetches the'
    psilink_note 'image, which needs a network that can reach the registry.'
    return 1
  fi
  if [ -z "$verdict" ]; then
    psilink_bad "The checks printed no verdict (exit $status)."
    psilink_note 'They exit 64 when an input is malformed, having run no check at'
    psilink_note 'all, so nothing was established about the folder.'
    return 1
  fi
  if ! psilink_json_load "$verdict"; then
    psilink_bad 'The verdict could not be read.'
    psilink_note 'This launcher and that image do not agree on the verdict'
    psilink_note 'format. Use the launcher published with the image you are'
    psilink_note 'running.'
    return 1
  fi

  version=$(psilink_json_member "$PSILINK_JSON_SKELETON" version) || version=''
  if [ "$version" != "$PSILINK_VERDICT_VERSION" ]; then
    psilink_bad "The checks reported verdict version ${version:-none}."
    psilink_note "This launcher reads version $PSILINK_VERDICT_VERSION, and stops"
    psilink_note 'rather than guessing at a later one whose fields may not mean'
    psilink_note 'what these do. Use the launcher published with this image.'
    return 1
  fi

  checks=$(psilink_json_member "$PSILINK_JSON_SKELETON" checks) || checks='[]'
  overall=$(psilink_json_text "$(psilink_json_member "$PSILINK_JSON_SKELETON" overall)") || overall=''

  case "$overall" in
    ok)
      # A warn does not stop an exchange and still has to be read, so it is
      # surfaced here rather than swallowed by the roll-up.
      psilink_show_checks_with_status "$checks" warn && psilink_say ''
      psilink_good 'Nothing here blocks an exchange.'
      ;;
    fix_and_retry)
      psilink_say ''
      psilink_show_checks_with_status "$checks" fail warn
      psilink_say ''
      psilink_say 'Do what the ACTION lines say, then run the checks again.'
      ;;
    fatal)
      psilink_say ''
      psilink_show_checks_with_status "$checks" fail
      psilink_say ''
      psilink_bad 'The checks could not be run, so nothing was established.'
      psilink_note 'There is no ACTION to follow: the checks that would have'
      psilink_note 'produced one never ran.'
      psilink_note "See $PSILINK_TROUBLESHOOTING_URL"
      ;;
    *)
      psilink_bad "The checks reported an overall verdict of '${overall:-none}'."
      psilink_note 'This launcher knows ok, fix_and_retry and fatal, and stops on'
      psilink_note 'anything else rather than treating it as one of them.'
      return 1
      ;;
  esac

  PSILINK_VERDICT_OVERALL="$overall"
  return 0
}

# The mount battery is the one that applies here. `doctor probe` asks an SMB
# server directly, over credentials this launcher never collects; on macOS and
# Linux the rendezvous folder is bind-mounted as the host already sees it, so
# the kernel's view is the only view there is. That is what `doctor mount`
# checks -- the write, the exclusive create and the rename onto an existing file
# that psilink's rendezvous is built on.
psilink_doctor_loop() {
  local directory="$1"

  while :; do
    if ! psilink_run_doctor_mount "$directory"; then
      return 1
    fi
    case "$PSILINK_VERDICT_OVERALL" in
      ok) return 0 ;;
      fatal) return 1 ;;
    esac
    psilink_say ''
    if ! psilink_confirm 'Run the checks again? [Y/n] ' yes; then
      psilink_say ''
      psilink_note 'Stopping without starting the console.'
      return 1
    fi
  done
}

# ===========================================================================
# Folders
# ===========================================================================

# A folder the host can see is bind-mounted as it stands. There is deliberately
# no resolution machinery here: on macOS and Linux the engine's view of a path
# is the host's, so a folder your shell can list is a folder the container can.
# What that cannot reach is a share the host has not mounted -- so say which
# kind of folder this is, rather than model what the engine would make of it.
psilink_report_mount_kind() {
  local directory="$1" source=''

  command -v df >/dev/null 2>&1 || return 0
  source=$(df -P "$directory" 2>/dev/null | awk 'NR == 2 { print $1 }')
  [ -n "$source" ] || return 0

  case "$source" in
    //* | *:/*)
      psilink_warn "$directory is on a network mount ($source)."
      psilink_note 'It is mounted here as it stands, which works as long as this'
      psilink_note 'machine keeps it mounted. This launcher does no share'
      psilink_note 'resolution: if the checks below cannot see the folder, mount'
      psilink_note 'the share on this machine first and point this at the mount.'
      ;;
  esac
  return 0
}

# Sets PSILINK_DIRECTORY to an existing directory, or fails.
psilink_read_directory() {
  local prompt="$1" candidate=''

  while :; do
    psilink_ask "$prompt" || return 1
    candidate="$PSILINK_ANSWER"
    # A path dragged into a terminal arrives quoted.
    candidate=${candidate%\"}
    candidate=${candidate#\"}
    candidate=${candidate%\'}
    candidate=${candidate#\'}
    case "$candidate" in
      '~/'*) candidate="$HOME/${candidate#\~/}" ;;
      '~') candidate="$HOME" ;;
    esac
    if [ -z "$candidate" ]; then
      psilink_note 'Enter a folder path.'
      continue
    fi
    if [ ! -d "$candidate" ]; then
      psilink_bad "There is no folder at $candidate."
      psilink_note 'Create it first, or enter a different one.'
      continue
    fi
    PSILINK_DIRECTORY="$candidate"
    return 0
  done
}

psilink_require_directory() {
  local label="$1" directory="$2"
  [ -z "$directory" ] && return 0
  [ -d "$directory" ] && return 0
  psilink_bad "There is no folder at $directory ($label)."
  return 1
}

psilink_collect_directories() {
  # Anything given on the command line is taken as given; the rest is asked for.
  if [ -z "$PSILINK_DATA_ROOT" ]; then
    psilink_head 'The folders the console works in'
    psilink_say 'The console needs somewhere to keep this exchange: your input CSV,'
    psilink_say 'the key file, and the results it writes back.'
    psilink_say ''
    psilink_say 'One folder for all of it is the simplest console, and the one to'
    psilink_say 'start with. Separate folders keep the partner-written rendezvous'
    psilink_say 'away from your own files, which is worth doing once this works.'
    psilink_say ''
    if psilink_confirm 'Use one folder for everything? [Y/n] ' yes; then
      psilink_read_directory 'Folder: ' || return 1
      PSILINK_DATA_ROOT="$PSILINK_DIRECTORY"
    else
      psilink_read_directory 'Working folder (key file and results): ' || return 1
      PSILINK_DATA_ROOT="$PSILINK_DIRECTORY"
      psilink_read_directory 'Input folder (your CSVs, read in place): ' || return 1
      PSILINK_INPUT_DIR="$PSILINK_DIRECTORY"
      psilink_read_directory 'Rendezvous folder (shared with your partner): ' || return 1
      PSILINK_RENDEZVOUS_DIR="$PSILINK_DIRECTORY"
    fi
  fi

  psilink_require_directory 'working folder' "$PSILINK_DATA_ROOT" || return 1
  psilink_require_directory 'input folder' "$PSILINK_INPUT_DIR" || return 1
  psilink_require_directory 'rendezvous folder' "$PSILINK_RENDEZVOUS_DIR" || return 1

  psilink_say ''
  psilink_good "Working folder:    $PSILINK_DATA_ROOT"
  psilink_good "Input folder:      ${PSILINK_INPUT_DIR:-$PSILINK_DATA_ROOT (the working folder)}"
  psilink_good "Rendezvous folder: ${PSILINK_RENDEZVOUS_DIR:-$PSILINK_DATA_ROOT (the working folder)}"

  psilink_report_mount_kind "$PSILINK_DATA_ROOT"
  [ -z "$PSILINK_INPUT_DIR" ] || psilink_report_mount_kind "$PSILINK_INPUT_DIR"
  [ -z "$PSILINK_RENDEZVOUS_DIR" ] || psilink_report_mount_kind "$PSILINK_RENDEZVOUS_DIR"
  return 0
}

psilink_rendezvous_directory() {
  if [ -n "$PSILINK_RENDEZVOUS_DIR" ]; then
    printf '%s' "$PSILINK_RENDEZVOUS_DIR"
  else
    printf '%s' "$PSILINK_DATA_ROOT"
  fi
}

# ===========================================================================
# The console
# ===========================================================================

psilink_console_url() { printf 'http://127.0.0.1:%s' "$PSILINK_PORT"; }

# Whether anything answers on the loopback port. bash's own /dev/tcp is used
# where it works and curl where it does not, so no extra tool has to be present.
psilink_port_answers() {
  local port="$1"
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    return 0
  fi
  if command -v curl >/dev/null 2>&1; then
    curl --silent --output /dev/null --max-time 2 "http://127.0.0.1:$port/" && return 0
  fi
  return 1
}

psilink_wait_for_console() {
  local waited=0
  while [ "$waited" -lt "$PSILINK_CONSOLE_WAIT_SECONDS" ]; do
    if psilink_port_answers "$PSILINK_PORT"; then
      return 0
    fi
    # A container that has already exited is the other way this wait ends;
    # without it the launcher would sit out the whole budget after a failure the
    # operator has already seen printed above.
    if [ -n "$PSILINK_CONSOLE_PID" ] && ! kill -0 "$PSILINK_CONSOLE_PID" 2>/dev/null; then
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

psilink_open_browser() {
  local url="$1"
  [ "$PSILINK_OPEN_BROWSER" = 'yes' ] || return 0
  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 && return 0
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 && return 0
  fi
  return 1
}

psilink_stop_console() {
  [ -n "$PSILINK_CONTAINER_NAME" ] || return 0
  "$PSILINK_ENGINE" stop "$PSILINK_CONTAINER_NAME" >/dev/null 2>&1
  return 0
}

# The engine's argument vector for the console, built into an array so a folder
# path is one argument whatever it holds.
#
# The publish binding carries the whole of the console's reachability: the job
# API has no authentication, and the 127.0.0.1: prefix is what keeps it on this
# machine. --rm is the other half of the posture -- the container keeps nothing,
# and everything the exchange produces is in the operator's own folders.
psilink_build_console_arguments() {
  PSILINK_CONSOLE_ARGUMENTS=(
    run --rm --name "$PSILINK_CONTAINER_NAME"
    --publish "127.0.0.1:$PSILINK_PORT:3000"
    --env JOB_DATA_ROOT=/data --volume "$PSILINK_DATA_ROOT:/data"
  )
  if [ -n "$PSILINK_INPUT_DIR" ]; then
    PSILINK_CONSOLE_ARGUMENTS+=(--env JOB_INPUT_DIR=/input --volume "$PSILINK_INPUT_DIR:/input")
  fi
  if [ -n "$PSILINK_RENDEZVOUS_DIR" ]; then
    PSILINK_CONSOLE_ARGUMENTS+=(
      --env JOB_RENDEZVOUS_DIR=/rendezvous
      --volume "$PSILINK_RENDEZVOUS_DIR:/rendezvous"
    )
  fi
  PSILINK_CONSOLE_ARGUMENTS+=("$(psilink_image)" serve)
}

psilink_start_console() {
  local status=0

  PSILINK_CONTAINER_NAME="psilink-console-$$"
  psilink_build_console_arguments

  psilink_head 'Starting the console'
  psilink_say 'Nothing is kept between runs: the container is removed when it'
  psilink_say 'stops, and everything the exchange produces is in your own folders.'
  psilink_say ''

  "$PSILINK_ENGINE" "${PSILINK_CONSOLE_ARGUMENTS[@]}" &
  PSILINK_CONSOLE_PID=$!
  trap 'psilink_stop_console' INT TERM

  if psilink_wait_for_console; then
    psilink_say ''
    psilink_good "The console is at $(psilink_console_url)"
    if ! psilink_open_browser "$(psilink_console_url)"; then
      psilink_note 'Open that address in your browser.'
    fi
    psilink_say ''
    psilink_note 'Leave this window open while you use it. Press Ctrl-C here when'
    psilink_note 'you are done, which stops the console and removes the container.'
  else
    psilink_say ''
    psilink_bad "Nothing answered on $(psilink_console_url)."
    psilink_note 'What the engine printed above says why. If it is still running:'
    psilink_note "    $PSILINK_ENGINE stop $PSILINK_CONTAINER_NAME"
  fi

  wait "$PSILINK_CONSOLE_PID"
  status=$?
  trap - INT TERM
  psilink_say ''
  psilink_say 'The console has stopped.'
  return $status
}

# ===========================================================================
# Options and flow
# ===========================================================================

psilink_usage() {
  cat <<'PSILINK_USAGE'
Usage: start-psilink.sh [options]

  --data-root DIR        working folder: key file, job files, results
  --input-dir DIR        input CSVs, read in place (defaults to --data-root)
  --rendezvous-dir DIR   folder shared with your partner (defaults to --data-root)
  --port PORT            host loopback port for the console (default 3000)
  --no-browser           do not open a browser; print the address instead
  --help                 this text

With no options it asks for the folders it needs.
PSILINK_USAGE
}

psilink_parse_options() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --data-root | --input-dir | --rendezvous-dir | --port)
        if [ "$#" -lt 2 ]; then
          psilink_bad "$1 needs a value."
          return 1
        fi
        case "$1" in
          --data-root) PSILINK_DATA_ROOT="$2" ;;
          --input-dir) PSILINK_INPUT_DIR="$2" ;;
          --rendezvous-dir) PSILINK_RENDEZVOUS_DIR="$2" ;;
          --port)
            case "$2" in
              '' | *[!0-9]*)
                psilink_bad "--port takes a number, not '$2'."
                return 1
                ;;
            esac
            # The length guard keeps the range test inside [ ]'s integer width.
            if [ "${#2}" -gt 5 ] || [ "$2" -lt 1 ] || [ "$2" -gt 65535 ]; then
              psilink_bad "--port takes a port between 1 and 65535, not '$2'."
              return 1
            fi
            PSILINK_PORT="$2"
            ;;
        esac
        shift 2
        ;;
      --no-browser)
        PSILINK_OPEN_BROWSER='no'
        shift
        ;;
      --help | -h)
        PSILINK_HELP_ONLY='yes'
        shift
        ;;
      *)
        psilink_bad "Unrecognised option '$1'."
        psilink_usage
        return 1
        ;;
    esac
  done
  return 0
}

psilink_main() {
  psilink_parse_options "$@" || return 64
  if [ "$PSILINK_HELP_ONLY" = 'yes' ]; then
    psilink_usage
    return 0
  fi

  psilink_head 'psilink console'
  psilink_require_release_stamp || return 1
  psilink_select_engine || return 1
  psilink_collect_directories || return 1

  psilink_head 'Checking the folders'
  psilink_doctor_loop "$(psilink_rendezvous_directory)" || return 1

  psilink_start_console
}

# Sourced: the definitions above and nothing else, which is how the test suite
# reaches them. Executed: the launcher. The guard compares BASH_SOURCE with $0
# rather than reading a flag, so nothing an operator types can skip the flow.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  psilink_main "$@"
  exit $?
fi
