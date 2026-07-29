#!/bin/sh
# Inspects the password and mints the run token, for cmd_Setup-PsilinkFileDrop.cmd.
#
# This runs in a container rather than in cmd because cmd cannot inspect the
# string safely: expanding a variable holding "&", "|" or ">" into a command
# line makes cmd re-parse the password as syntax, and the batch aborts with
# "& was unexpected at this time" rather than reporting anything. Here the
# value arrives in the environment, which is never re-parsed.
set -u
: "${SMB_PASS:=}"

VERDICT=OK
case "$SMB_PASS" in
  "")   VERDICT=EMPTY ;;
  *,*)  VERDICT=COMMA ;;
  *\"*) VERDICT=QUOTE ;;
esac

WARN=
case "$SMB_PASS" in
  " "*) WARN=LEADSPACE ;;
esac

printf 'VERDICT=%s\n' "$VERDICT"
printf 'WARN=%s\n' "$WARN"
printf 'TOKEN=%s\n' "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
