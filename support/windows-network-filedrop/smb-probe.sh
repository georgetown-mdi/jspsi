#!/bin/sh
# Container-side SMB probe for psilink filedrop rendezvous directories.
# Runs inside alpine. Inputs arrive as environment variables:
#   SMB_SERVER SMB_SHARE SMB_PATH SMB_USER SMB_DOMAIN SMB_PASS SMB_VERS
# Emits human-readable progress plus machine-readable RESULT: lines.

set -u

AUTH=/tmp/psilink-auth
FAILED=0

emit() { printf '%s\n' "$*"; }
result() { emit "RESULT:$1:$2"; }
step() { emit ""; emit "== $1"; }

emit "psilink SMB probe"
emit "server=$SMB_SERVER share=$SMB_SHARE path=${SMB_PATH:-<share root>}"
emit "user=${SMB_DOMAIN:+$SMB_DOMAIN\\}$SMB_USER dialect=${SMB_VERS:-auto}"

apk add --no-cache samba-client >/dev/null 2>&1 || {
  result deps FAIL
  emit "Could not install samba-client. The Docker VM has no internet access."
  exit 1
}

umask 077
{
  printf 'username=%s\n' "$SMB_USER"
  printf 'password=%s\n' "$SMB_PASS"
  [ -n "${SMB_DOMAIN:-}" ] && printf 'domain=%s\n' "$SMB_DOMAIN"
} > "$AUTH"

VERSOPT=""
[ -n "${SMB_VERS:-}" ] && VERSOPT="-m $SMB_VERS"

# ---------------------------------------------------------------- 1. DNS
step "1. Name resolution (from inside the Docker VM)"
if printf '%s' "$SMB_SERVER" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  emit "$SMB_SERVER is a literal IP address; no lookup needed."
  result dns SKIP
elif getent hosts "$SMB_SERVER" >/dev/null 2>&1; then
  emit "Resolved: $(getent hosts "$SMB_SERVER" | head -1)"
  result dns PASS
else
  emit "Could not resolve '$SMB_SERVER'."
  emit "The Docker VM uses its own resolver and does not inherit Windows'"
  emit "DNS suffix search list or NetBIOS name resolution. A short hostname"
  emit "that works in File Explorer often fails here."
  emit "ACTION: re-run with the fully-qualified name or the IP address."
  result dns FAIL
  FAILED=1
  exit 1
fi

# ---------------------------------------------------------------- 2. TCP 445
step "2. TCP reachability on port 445"
if nc -z -w 8 "$SMB_SERVER" 445 2>/dev/null; then
  emit "Port 445 is open."
  result tcp PASS
else
  emit "Cannot reach $SMB_SERVER:445 from inside the Docker VM."
  emit "The VM reaches the network through Docker's NAT, so it is a different"
  emit "client than Windows. A host firewall rule, a VPN that only routes the"
  emit "Windows side, or a server-side IP restriction will block it here while"
  emit "File Explorer still works."
  emit "ACTION: confirm the share is reachable without the VPN, or use the"
  emit "        local-folder approach in the runbook."
  result tcp FAIL
  exit 1
fi

# ---------------------------------------------------------------- 3. Auth
step "3. Authentication and share listing"
OUT=$(timeout 30 smbclient -L "//$SMB_SERVER" -A "$AUTH" $VERSOPT 2>&1)
STATUS=$(printf '%s' "$OUT" | grep -o 'NT_STATUS_[A-Z_]*' | head -1)

if [ -z "$STATUS" ] && printf '%s' "$OUT" | grep -q 'Sharename'; then
  emit "Authenticated successfully. Shares visible to this account:"
  printf '%s\n' "$OUT" | sed -n '/Sharename/,/^$/p' | sed 's/^/    /'
  result auth PASS
else
  emit "Authentication failed: ${STATUS:-unknown error}"
  emit ""
  printf '%s\n' "$OUT" | sed 's/^/    /'
  emit ""
  case "$STATUS" in
    NT_STATUS_LOGON_FAILURE)
      emit "MEANING: the username, password, or domain is genuinely wrong."
      emit "ACTION: if this is a domain account, re-run with the domain set."
      emit "        If the share opens in Explorer without ever prompting you"
      emit "        for a password, Windows is using Kerberos single sign-on"
      emit "        and there may be no password that works here -- see the"
      emit "        runbook section 'No password exists'." ;;
    NT_STATUS_ACCESS_DENIED)
      emit "MEANING: the credentials were accepted but access was refused."
      emit "ACTION: the account likely lacks rights from a non-domain-joined"
      emit "        client, or the server requires Kerberos. See the runbook"
      emit "        section 'Credentials correct, still denied'." ;;
    NT_STATUS_ACCOUNT_LOCKED_OUT)
      emit "MEANING: the account is locked out, probably from earlier retries."
      emit "ACTION: wait for the lockout to expire or ask IT to unlock, then"
      emit "        re-run. Do not keep retrying." ;;
    NT_STATUS_PASSWORD_EXPIRED|NT_STATUS_PASSWORD_MUST_CHANGE)
      emit "MEANING: the password is expired."
      emit "ACTION: change it in Windows, then re-run." ;;
    NT_STATUS_NOT_SUPPORTED)
      emit "MEANING: the server refused the authentication mechanism, not the"
      emit "         credentials. NTLM is probably disabled server-side."
      emit "ACTION: see the runbook section 'No password exists'." ;;
    NT_STATUS_CONNECTION_RESET|NT_STATUS_IO_TIMEOUT|NT_STATUS_INVALID_NETWORK_RESPONSE)
      emit "MEANING: the SMB dialect was probably rejected."
      emit "ACTION: re-run with a different dialect (SMB3, SMB2, NT1)." ;;
    *)
      emit "ACTION: match the status code above against the runbook table." ;;
  esac
  result auth FAIL
  exit 1
fi

# ---------------------------------------------------------------- 4. Share
step "4. Connecting to share '$SMB_SHARE'"
OUT=$(timeout 30 smbclient "//$SMB_SERVER/$SMB_SHARE" -A "$AUTH" $VERSOPT -c 'ls' 2>&1)
STATUS=$(printf '%s' "$OUT" | grep -o 'NT_STATUS_[A-Z_]*' | head -1)
if [ -n "$STATUS" ]; then
  emit "Could not open the share: $STATUS"
  printf '%s\n' "$OUT" | sed 's/^/    /'
  emit "ACTION: check the share name spelling against the listing in step 3."
  result share FAIL
  exit 1
fi
emit "Share opened."
result share PASS

# ---------------------------------------------------------------- 5. Path
if [ -n "${SMB_PATH:-}" ]; then
  step "5. Subdirectory '$SMB_PATH'"
  OUT=$(timeout 30 smbclient "//$SMB_SERVER/$SMB_SHARE" -A "$AUTH" $VERSOPT \
        -c "cd \"$SMB_PATH\"; ls" 2>&1)
  STATUS=$(printf '%s' "$OUT" | grep -o 'NT_STATUS_[A-Z_]*' | head -1)
  if [ -n "$STATUS" ]; then
    emit "Could not enter '$SMB_PATH': $STATUS"
    emit "ACTION: the share is reachable but this subdirectory is not."
    emit "        Check the spelling, or that the account has rights to it"
    emit "        specifically -- share access does not imply subfolder access."
    result path FAIL
    exit 1
  fi
  emit "Directory exists and is listable. Contents:"
  printf '%s\n' "$OUT" | sed 's/^/    /'
  result path PASS
  TARGET="$SMB_PATH"
else
  TARGET=""
fi

# ---------------------------------------------------------------- 6. Write
step "6. Write test"
emit "psilink must create, rename, and delete files here, so read access is"
emit "not enough."
PROBE=psilink-write-probe.tmp
printf 'psilink write probe\n' > /tmp/$PROBE
CMD="put /tmp/$PROBE $PROBE; rename $PROBE $PROBE.renamed; del $PROBE.renamed"
[ -n "$TARGET" ] && CMD="cd \"$TARGET\"; $CMD"
OUT=$(timeout 30 smbclient "//$SMB_SERVER/$SMB_SHARE" -A "$AUTH" $VERSOPT -c "$CMD" 2>&1)
STATUS=$(printf '%s' "$OUT" | grep -o 'NT_STATUS_[A-Z_]*' | head -1)
if [ -n "$STATUS" ]; then
  emit "Write test failed: $STATUS"
  printf '%s\n' "$OUT" | sed 's/^/    /'
  if [ "$STATUS" = "NT_STATUS_ACCESS_DENIED" ] || [ "$STATUS" = "NT_STATUS_MEDIA_WRITE_PROTECTED" ]; then
    emit "MEANING: the account can read this directory but not write to it."
    emit "ACTION: ask whoever administers the share for write permission."
    emit "        Mount options such as file_mode cannot grant this -- they"
    emit "        only change how permissions appear inside the container."
  fi
  result write FAIL
  exit 1
fi
emit "Created, renamed, and deleted a file successfully."
emit "Rename works, which is what psilink's atomic message writes need."
result write PASS

emit ""
emit "All SMB checks passed."
