#!/bin/sh
# Container-side checks for cmd_Setup-PsilinkFileDrop.cmd.
#
# This runs inside a throwaway Alpine container, not on Windows. The setup
# script feeds it on standard input through "tr -d '\r' | sh", so a checkout
# with core.autocrlf on cannot break it: sh does not treat a carriage return as
# whitespace, and a CRLF copy reaching sh directly reports an unterminated if.
#
# Every value arrives in the environment rather than on a command line, so the
# password is never an argument here.
set -u
AUTH=/tmp/psilink-auth
LITTER=""
TARGET=""
LISTING=""

emit() { printf '%s\n' "$*"; }
step() { emit ""; emit "-- $1"; }
indent() { printf '%s\n' "$1" | sed 's/^/      /'; }

# The credentials file and anything this probe writes to the share are removed
# on every exit path, including a timeout or an interrupt. The share belongs to
# someone else and their partner can see it.
cleanup() {
  if [ -n "$LITTER" ] && [ -f "$AUTH" ]; then
    for leftover in $LITTER; do
      smb_at -c "del $leftover" >/dev/null 2>&1 || true
    done
  fi
  rm -f "$AUTH"
}
trap cleanup EXIT

for required in SMB_SERVER SMB_SHARE SMB_USER; do
  eval "supplied=\${$required:-}"
  [ -n "$supplied" ] && continue
  emit "FAIL: the setup script did not pass $required to the container."
  emit ""
  emit "MEANING: this is a defect in cmd_Setup-PsilinkFileDrop.cmd rather than a"
  emit "         problem with your share or your credentials."
  emit "ACTION:  report it, with the command you ran."
  exit 10
done
: "${SMB_PATH:=}"
: "${SMB_DOMAIN:=}"
: "${SMB_PASS:=}"
: "${SMB_DIALECT:=}"
: "${SMB_MARKER:=}"
: "${SMB_TOKEN:=}"

# -m sets the MAXIMUM protocol only; the client minimum stays at SMB2_02, so
# asking for NT1 with -m alone is a contradiction the client rejects out of
# hand with INVALID_PARAMETER_MIX, against every server including one that
# speaks nothing else. The minimum has to move too. The option name takes
# spaces, not underscores.
smb_list() {
  if [ -n "$SMB_DIALECT" ]; then
    timeout 30 smbclient -L "//$SMB_SERVER" -A "$AUTH" \
      -m "$SMB_DIALECT" --option="client min protocol=$SMB_DIALECT" 2>&1
  else
    timeout 30 smbclient -L "//$SMB_SERVER" -A "$AUTH" 2>&1
  fi
}
smb() {
  if [ -n "$SMB_DIALECT" ]; then
    timeout 30 smbclient "//$SMB_SERVER/$SMB_SHARE" -A "$AUTH" \
      -m "$SMB_DIALECT" --option="client min protocol=$SMB_DIALECT" "$@" 2>&1
  else
    timeout 30 smbclient "//$SMB_SERVER/$SMB_SHARE" -A "$AUTH" "$@" 2>&1
  fi
}
# -D rather than a "cd" command: smbclient splits -c on semicolons even inside
# a quoted argument, so a folder legitimately named "q3;final" would be
# reported as missing, and a crafted one could append commands of its own.
smb_at() {
  if [ -n "$TARGET" ]; then smb -D "$TARGET" "$@"; else smb "$@"; fi
}

# NT_STATUS_OK appears in ordinary successful output and is not a failure.
status_of() {
  printf '%s' "$1" | grep -o 'NT_STATUS_[A-Z_]*' | grep -v '^NT_STATUS_OK$' | head -1
}

# An empty status means "the server supplied no verdict", never "the command
# succeeded". A transport that dies before the server answers -- a firewall that
# completes the TCP handshake and then swallows the session, a server wedged
# mid-negotiation -- returns no NT_STATUS token at all, so scraping alone reads
# it as success and every later step reports an OK it never established. The
# exit status is the only evidence that the command ran, so both are consulted:
# nonzero with no status token is a transport failure, nonzero with one is an
# ordinary server refusal that the caller's own case block classifies.
transport_failed() {
  [ "$1" -eq 0 ] && return 1
  [ -n "$(status_of "$2")" ] && return 1
  return 0
}

report_transport_failure() {
  emit "FAIL: the connection to $SMB_SERVER stopped responding."
  emit ""
  indent "$2"
  emit ""
  if [ "$1" -eq 124 ]; then
    emit "MEANING: the server accepted the connection and then sent nothing back"
    emit "         within the time allowed. Nothing about your credentials or"
    emit "         your folder has been established either way."
  else
    emit "MEANING: smbclient could not finish the request and the server gave no"
    emit "         reason for it (exit $1). Nothing about your credentials or"
    emit "         your folder has been established either way."
  fi
  emit "ACTION:  see the troubleshooting page, 'The container cannot reach"
  emit "         the server'. A firewall or VPN that allows the connection"
  emit "         and then drops the traffic behaves exactly like this."
}

report_space() {
  set -- $(printf '%s\n' "$1" | sed -n \
    's/.*blocks of size \([0-9][0-9]*\)\. *\([0-9][0-9]*\) blocks available.*/\1 \2/p' | head -1)
  [ $# -eq 2 ] || return 0
  free_mb=$(( $1 * $2 / 1048576 ))
  if [ "$free_mb" -eq 0 ]; then
    emit "WARN: the share reports no free space. A tiny test file still fits in"
    emit "      slack, so these checks can pass while a real exchange fails"
    emit "      partway through. Ask for quota before running one."
  elif [ "$free_mb" -lt 100 ]; then
    emit "NOTE: ${free_mb} MB free on this share."
  fi
}

step "1. Name resolution from inside the Docker VM"
if printf '%s' "$SMB_SERVER" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  emit "OK: $SMB_SERVER is a literal IP address."
elif getent hosts "$SMB_SERVER" >/dev/null 2>&1; then
  emit "OK: resolved to $(getent hosts "$SMB_SERVER" | awk '{print $1}' | head -1)"
else
  emit "FAIL: cannot resolve '$SMB_SERVER'."
  emit ""
  emit "The Docker VM runs its own resolver. It does not inherit Windows' DNS"
  emit "suffix search list and has no NetBIOS name resolution, so a short"
  emit "server name that works in File Explorer often fails here."
  emit ""
  emit "ACTION: on Windows, run"
  emit ""
  emit "          nslookup $SMB_SERVER"
  emit ""
  emit "        and run this script again giving the full name or the address"
  emit "        it prints:"
  emit ""
  emit "          cmd_Setup-PsilinkFileDrop.cmd -Server <full-name-or-IP> -Share $SMB_SHARE"
  emit ""
  emit "        See the troubleshooting page, 'The container cannot find"
  emit "        the server'."
  exit 2
fi

step "2. TCP reachability on port 445"
if nc -z -w 8 "$SMB_SERVER" 445 2>/dev/null; then
  emit "OK: port 445 is open."
else
  emit "FAIL: cannot reach $SMB_SERVER:445 from inside the Docker VM."
  emit ""
  emit "The VM reaches the network through Docker's network translation, so to"
  emit "the file server it looks like a different machine than Windows does. A"
  emit "VPN that routes only the Windows side, a host firewall rule, or a"
  emit "server-side address restriction blocks the VM while File Explorer keeps"
  emit "working."
  emit ""
  emit "ACTION: if you are on a VPN, that is the likely cause. See the"
  emit "        troubleshooting page, 'The container cannot reach the server'."
  exit 3
fi

# The psilink image carries smbclient, so on the default helper image nothing is
# fetched here at all. The install is the fallback for a stock-Alpine
# -HelperImage, or for a copy of the psilink image predating the package.
#
# Deliberately after the two checks above, both of which use tools already in
# the image: a machine that cannot resolve or route to the server would fail
# here first, and "could not install samba-client" is a far worse description
# of that than "cannot resolve the name".
if ! command -v smbclient >/dev/null 2>&1; then
  APKOUT=$(apk add --no-cache samba-client 2>&1) || {
    emit ""
    emit "FAIL: could not install samba-client inside the container."
    emit ""
    indent "$APKOUT"
    emit ""
    emit "MEANING: smbclient is not in the image the checks are running in, and"
    emit "         the container could not fetch it from the Alpine package"
    emit "         mirror."
    emit ""
    emit "         The psilink image carries smbclient, so the likeliest cause is"
    emit "         an older copy of that image on this PC: the helper image is"
    emit "         fetched only when it is missing, never to refresh one that is"
    emit "         already here."
    emit ""
    emit "         Failing that, the message above names why the mirror could not"
    emit "         be reached. 'certificate' or 'TLS' means something is"
    emit "         intercepting HTTPS -- a corporate proxy, usually. 'DNS' or"
    emit "         'temporary error' means name resolution inside the Docker VM."
    emit ""
    emit "ACTION:  run 'docker pull vdorie/psi-link:latest' and try again. If the"
    emit "         image was already current, see the troubleshooting page, 'The"
    emit "         container cannot install its tools'."
    exit 1
  }
fi

umask 077
{
  printf 'username=%s\n' "$SMB_USER"
  printf 'password=%s\n' "$SMB_PASS"
  [ -n "$SMB_DOMAIN" ] && printf 'domain=%s\n' "$SMB_DOMAIN"
} > "$AUTH"

step "3. Authentication"
OUT=$(smb_list); RC=$?
STATUS=$(status_of "$OUT")

# Ahead of the negotiation check on purpose: a server that dies mid-negotiation
# and one that refuses the dialect both mention negotiation, and only the second
# carries an NT_STATUS token. Classifying on the token rather than on the word
# keeps a wedged server from being reported as a dialect disagreement.
if transport_failed "$RC" "$OUT"; then
  report_transport_failure "$RC" "$OUT"
  exit 3
fi

if printf '%s' "$OUT" | grep -qi 'protocol negotiation'; then
  emit "FAIL: the client and the server could not agree on an SMB dialect."
  emit ""
  indent "$OUT"
  emit ""
  emit "MEANING: this is not an authentication problem. The dialect asked for"
  emit "         is one the server will not speak."
  emit "ACTION:  run the script again without -Dialect to let them negotiate,"
  emit "         or with -Dialect SMB3 if you were told to pin one."
  exit 4
fi

case "$STATUS" in
  NT_STATUS_LOGON_FAILURE)
    emit "FAIL: $STATUS"
    emit ""
    indent "$OUT"
    emit ""
    emit "MEANING: the username, password, or domain is wrong. This is the one"
    emit "         status that really does mean bad credentials."
    emit ""
    emit "ACTION:  if this is a domain account, run the script again with"
    emit "         -Domain set. If the folder opens in File Explorer WITHOUT"
    emit "         ever asking for a password, Windows is signing you in"
    emit "         automatically with Kerberos and there may be no password"
    emit "         that works here. See the troubleshooting page, 'The share"
    emit "         never asks for a password'."
    emit ""
    emit "         Do not work through passwords one at a time. Each run is one"
    emit "         failed sign-in against the account, and a handful of those"
    emit "         locks it out."
    exit 4 ;;
  NT_STATUS_ACCOUNT_LOCKED_OUT)
    emit "FAIL: $STATUS"
    emit ""
    emit "MEANING: the account is locked out, most likely from earlier failed"
    emit "         attempts, which may now be masking the original cause."
    emit "ACTION:  stop retrying. Wait for the lockout to expire or ask IT to"
    emit "         unlock, then run this script once."
    exit 4 ;;
  NT_STATUS_PASSWORD_EXPIRED|NT_STATUS_PASSWORD_MUST_CHANGE)
    emit "FAIL: $STATUS"
    emit ""
    emit "MEANING: the password is expired."
    emit "ACTION:  change it in Windows, then run this script again."
    exit 4 ;;
  NT_STATUS_ACCOUNT_DISABLED|NT_STATUS_ACCOUNT_EXPIRED|NT_STATUS_ACCOUNT_RESTRICTION|NT_STATUS_INVALID_LOGON_HOURS|NT_STATUS_INVALID_WORKSTATION|NT_STATUS_PASSWORD_RESTRICTION)
    emit "FAIL: $STATUS"
    emit ""
    indent "$OUT"
    emit ""
    emit "MEANING: the account itself is not permitted to sign in -- disabled,"
    emit "         expired, restricted to certain hours, or restricted to"
    emit "         certain machines. The password is not the problem and"
    emit "         neither are the rights on your folder."
    emit "ACTION:  ask whoever issued the account to lift that restriction, or"
    emit "         ask for a service account instead -- it is item 1 of the IT"
    emit "         request on the troubleshooting page. Without this, every"
    emit "         later check would report the same status and blame your"
    emit "         folder for it."
    exit 4 ;;
  NT_STATUS_NOT_SUPPORTED|NT_STATUS_LOGON_TYPE_NOT_GRANTED)
    emit "FAIL: $STATUS"
    emit ""
    indent "$OUT"
    emit ""
    emit "MEANING: the server rejected the authentication METHOD, not the"
    emit "         credentials. NTLM is probably disabled server-side, or this"
    emit "         account is not allowed to sign in over the network."
    emit "ACTION:  see the troubleshooting page, 'The share never asks for a"
    emit "         password'."
    exit 4 ;;
esac

# Anything else is not decided here. A server that authenticates fine can still
# refuse the share list -- refusing IPC$ to ordinary accounts is common, and
# reports as ACCESS_DENIED -- and aborting on that sends the operator to ask
# for rights they already have. Step 4 opens the share the exchange will
# actually use, and that is the question worth answering.
if printf '%s' "$OUT" | grep -q 'Sharename'; then
  # A derived fact rather than the list itself. This runs against an agency file
  # server, the share names can identify programs and departments, and the
  # runbook asks the operator to send this output to whoever is helping them --
  # who is not a party to their exchange. The only thing worth reading off the
  # list is whether the share they named is on it.
  if printf '%s\n' "$OUT" | sed -n 's/^\t\([^ \t]*\).*/\1/p' | grep -qxF "$SMB_SHARE"; then
    emit "OK: authenticated, and '$SMB_SHARE' is one of the shares this account"
    emit "    can see."
  else
    emit "OK: authenticated."
    emit ""
    emit "NOTE: '$SMB_SHARE' is not among the shares this account can see. That"
    emit "      does not decide anything -- a share can be reachable without"
    emit "      being listed. Step 4 opens it, and that is the test that counts."
  fi
elif [ -n "$STATUS" ]; then
  emit "OK: the credentials were accepted."
  emit ""
  emit "NOTE: the server would not list its shares ($STATUS). That is common"
  emit "      and is not a problem by itself -- many servers refuse the list to"
  emit "      ordinary accounts. Opening your share is the test that counts."
else
  emit "OK: the credentials were accepted."
  emit ""
  emit "NOTE: no share list came back. Opening your share is the test that"
  emit "      counts."
fi

step "4. Opening share '$SMB_SHARE'"
OUT=$(smb -c 'ls'); RC=$?
STATUS=$(status_of "$OUT")
if transport_failed "$RC" "$OUT"; then
  report_transport_failure "$RC" "$OUT"
  exit 3
fi
if [ -n "$STATUS" ]; then
  case "$STATUS" in
    NT_STATUS_BAD_NETWORK_NAME|NT_STATUS_OBJECT_NAME_NOT_FOUND)
      emit "FAIL: $STATUS"
      emit ""
      indent "$OUT"
      emit ""
      emit "MEANING: there is no share called '$SMB_SHARE' on this server."
      emit "ACTION:  the share is the FIRST path component only, not the whole"
      emit "         folder path: in \\\\server\\exchange\\dropbox the share is"
      emit "         'exchange' and 'dropbox' is the subfolder. Step 3 above"
      emit "         says whether this name was one the server offered."
      exit 5 ;;
    NT_STATUS_PATH_NOT_COVERED)
      emit "FAIL: $STATUS"
      emit ""
      emit "MEANING: the server is telling us outright that this path is a DFS"
      emit "         link -- it does not hold the data itself and expects the"
      emit "         client to follow a referral to whichever server does. The"
      emit "         Docker VM cannot follow one; it has no DFS client."
      emit ""
      emit "ACTION:  find the real server by hand and pass it directly. Open"
      emit "         the folder in File Explorer, right-click, Properties, DFS"
      emit "         tab, and read the referral. Then run:"
      emit ""
      emit "           cmd_Setup-PsilinkFileDrop.cmd -Server <server> -Share <share> -SubPath <folder>"
      emit ""
      emit "         See the troubleshooting page, 'Reading the real path"
      emit "         from Windows'."
      exit 5 ;;
    NT_STATUS_NOT_A_DIRECTORY)
      emit "FAIL: $STATUS"
      emit ""
      emit "MEANING: '$SMB_SHARE' names a file rather than a share or folder."
      emit "ACTION:  give the folder the exchange runs in, not a file inside it."
      exit 5 ;;
  esac

  if [ -n "$SMB_PATH" ]; then
    # The ordinary shape of an agency grant is rights to your own folder and
    # nothing above it. Listing the share root is not something psilink needs,
    # so a refusal here decides nothing; step 5 opens the folder that matters.
    emit "NOTE: the share root would not list."
    emit "      ($STATUS)"
    emit ""
    emit "      That is usual when you have been granted rights to your own"
    emit "      folder rather than to the whole share, and it does not stop"
    emit "      anything. Continuing to '$SMB_PATH'."
  else
    emit "FAIL: $STATUS"
    emit ""
    indent "$OUT"
    emit ""
    emit "MEANING: the credentials were accepted and access to the share was"
    emit "         then refused. This is not a wrong password."
    emit ""
    emit "ACTION:  the account probably lacks rights when connecting from a"
    emit "         machine that is not domain-joined, or the server requires"
    emit "         Kerberos. See the troubleshooting page, 'The password works"
    emit "         but access is refused'."
    exit 5
  fi
else
  emit "OK: share opened."
  LISTING="$OUT"
fi

if [ -n "$SMB_PATH" ]; then
  step "5. Entering subdirectory '$SMB_PATH'"
  OUT=$(smb -D "$SMB_PATH" -c 'ls'); RC=$?
  STATUS=$(status_of "$OUT")
  if transport_failed "$RC" "$OUT"; then
    report_transport_failure "$RC" "$OUT"
    exit 3
  fi
  if [ -n "$STATUS" ]; then
    emit "FAIL: $STATUS"
    emit ""
    indent "$OUT"
    emit ""
    case "$STATUS" in
      NT_STATUS_OBJECT_NAME_NOT_FOUND|NT_STATUS_OBJECT_PATH_NOT_FOUND)
        emit "MEANING: the share is fine but this subfolder does not exist."
        emit "ACTION:  check the spelling, or create it in File Explorer first." ;;
      NT_STATUS_NOT_A_DIRECTORY)
        emit "MEANING: '$SMB_PATH' names a file, not a folder."
        emit "ACTION:  give the folder the exchange runs in, not a file in it." ;;
      NT_STATUS_PATH_NOT_COVERED)
        emit "MEANING: this subfolder is a DFS link pointing at another server,"
        emit "         and the Docker VM has no DFS client to follow it."
        emit "ACTION:  read the real path from the folder's Properties, DFS tab"
        emit "         and pass it with -Server, -Share and -SubPath. See the"
        emit "         troubleshooting page, 'Reading the real path from"
        emit "         Windows'." ;;
      *)
        emit "MEANING: the subfolder exists but this account cannot open it."
        emit "ACTION:  access to a share does not imply access to every folder"
        emit "         in it. Ask for rights on this folder specifically." ;;
    esac
    exit 6
  fi
  # A count, deliberately, and not the listing. These are the operator's own
  # filenames on their own share, and the runbook asks them to send this output
  # to whoever is helping them -- who is not a party to their exchange and has
  # no business holding the names. Nothing downstream reads them: report_space
  # parses LISTING, not what was printed here.
  entries=$(printf '%s\n' "$OUT" |
    awk '/^  [^ ]/ { if ($1 != "." && $1 != "..") n++ } END { print n+0 }')
  emit "OK: directory listed, $entries file(s) in it."
  if [ "$entries" -gt 8192 ]; then
    emit ""
    emit "WARN: psilink will not read a rendezvous folder holding more than 8192"
    emit "      entries, so an exchange here will fail however the permissions"
    emit "      come out. Use a folder dedicated to the exchange."
  fi
  TARGET="$SMB_PATH"
  LISTING="$OUT"
else
  step "5. Subdirectory"
  emit "SKIP: using the share root."
fi

[ -n "$LISTING" ] && report_space "$LISTING"

step "6. Write, rename, and delete"
emit "psilink writes each message under a temporary name and renames it into"
emit "place, so read access alone is not enough."

# Fixed names this setup can leave on the share, swept before the staged test
# rather than after it. Left in place, one of them makes the rename stage fail
# and the probe report a read-only share that is nothing of the kind -- a trap
# that sustains itself once sprung, since the failed run litters again.
STALE=$(smb_at -c "del psilink-probe-*.tmp*"); STALE_RC=$?
if [ "$STALE_RC" -eq 0 ] && [ -z "$(status_of "$STALE")" ]; then
  emit "NOTE: removed probe files left behind by an earlier run."
fi

# Named from the per-run token rather than $$, which is not a source of
# uniqueness here: the probe runs as a child of "sh -c", where it draws the same
# small pid on every run on every machine. A fixed name makes two operators
# setting up the same share collide, and the one who loses the race is told the
# share is create-only. The sweep above is by mask for the same reason -- it has
# to match what a *previous* run named, which a fixed list cannot do.
#
# The marker file is deliberately not swept. It is the one file another operator
# may be relying on right now, and deleting it turns their volume check into a
# MARKER_MISSING verdict that blames their server for a wrong folder. The volume
# check owns the marker's lifecycle.
PROBE="psilink-probe-${SMB_TOKEN:-$$}.tmp"
RENAMED="$PROBE.renamed"
printf 'psilink write probe\n' > "/tmp/$PROBE"

LITTER="$PROBE $RENAMED"
OUT=$(smb_at -c "put /tmp/$PROBE $PROBE"); RC=$?
STATUS=$(status_of "$OUT")
if transport_failed "$RC" "$OUT"; then
  report_transport_failure "$RC" "$OUT"
  exit 3
fi
if [ -n "$STATUS" ]; then
  emit "FAIL: $STATUS -- could not create a file."
  emit ""
  indent "$OUT"
  emit ""
  emit "MEANING: this account can read the folder but not write to it."
  emit ""
  emit "ACTION:  ask whoever administers the share for write permission on"
  emit "         this folder. Mount options such as file_mode cannot grant"
  emit "         it -- they only change how permissions look inside the"
  emit "         container, not what the server allows."
  exit 7
fi
emit "OK: created a file."

OUT=$(smb_at -c "rename $PROBE $RENAMED"); RC=$?
STATUS=$(status_of "$OUT")
if transport_failed "$RC" "$OUT"; then
  report_transport_failure "$RC" "$OUT"
  exit 3
fi
if [ -n "$STATUS" ]; then
  emit "FAIL: $STATUS -- created a file but could not rename it."
  emit ""
  indent "$OUT"
  emit ""
  emit "MEANING: creating files is allowed here and renaming them is not."
  emit "         psilink renames every message into place, so this stops an"
  emit "         exchange even though the folder looks writable."
  emit ""
  emit "ACTION:  ask for full change rights on this folder rather than"
  emit "         create-only. On a Windows share this is usually the DELETE"
  emit "         right being withheld, which a rename needs."
  exit 7
fi
emit "OK: renamed it."

OUT=$(smb_at -c "del $RENAMED"); RC=$?
STATUS=$(status_of "$OUT")
if transport_failed "$RC" "$OUT"; then
  report_transport_failure "$RC" "$OUT"
  exit 3
fi
if [ -n "$STATUS" ]; then
  emit "FAIL: $STATUS -- created and renamed a file but could not delete it."
  emit ""
  indent "$OUT"
  emit ""
  emit "MEANING: psilink removes each message once the other side has read it."
  emit "         Without delete rights the folder fills up and a second"
  emit "         exchange in it will not start."
  emit ""
  emit "ACTION:  ask for delete rights on this folder. If they cannot be"
  emit "         granted, the exchange can still be run with"
  emit "         --retain-files, but the folder has to be emptied by hand"
  emit "         between exchanges."
  exit 7
fi
LITTER=""
emit "OK: deleted it."

# Left in place on purpose: the volume mounts //server/share/subpath while
# these checks tested //server/share with a subpath, and nothing so far proves
# those are the same directory. The volume test looks for this file, and its
# absence means the two halves are pointing at different places -- which is the
# one way a wrong server or share gets caught before an exchange does it.
if [ -n "$SMB_MARKER" ]; then
  printf '%s\n' "$SMB_TOKEN" > "/tmp/$SMB_MARKER"
  OUT=$(smb_at -c "put /tmp/$SMB_MARKER $SMB_MARKER")
  if [ -n "$(status_of "$OUT")" ]; then
    emit "NOTE: could not leave the marker file for the volume check."
  fi
fi

emit ""
emit "ALL CHECKS PASSED"
