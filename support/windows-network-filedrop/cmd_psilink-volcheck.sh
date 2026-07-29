#!/bin/sh
# Runs over the mounted volume, for cmd_Setup-PsilinkFileDrop.cmd.
#
# These are the operations psilink's default rendezvous is built on, exercised
# over the real CIFS mount rather than over smbclient -- smbclient refuses a
# rename onto an existing file whatever the server would have allowed, so a
# rename check built on it produces a false negative. A share can pass every
# check in the probe and still fail here.
#
# The marker name and the run token arrive in the environment rather than being
# pasted into this text, so a value containing a quote cannot break the script.
set -u
: "${MARKER:=}"
: "${TOKEN:=}"

cd /rz || { echo NOMOUNT; exit 1; }

if [ -n "$MARKER" ] && [ -f "$MARKER" ]; then
  if grep -q "$TOKEN" "$MARKER" 2>/dev/null; then echo MARKER_OK; else echo MARKER_MISMATCH; fi
  rm -f "$MARKER"
else
  echo MARKER_MISSING
fi

echo probe > .psilink-w.tmp && mv .psilink-w.tmp .psilink-w2.tmp && rm .psilink-w2.tmp && echo WRITE_OK

rm -f .psilink-x.tmp
if ( set -C; : > .psilink-x.tmp ) 2>/dev/null; then
  if ( set -C; : > .psilink-x.tmp ) 2>/dev/null; then echo EXCL_WEAK; else echo EXCL_OK; fi
else
  echo EXCL_UNTESTED
fi
rm -f .psilink-x.tmp

: > .psilink-a.tmp; : > .psilink-b.tmp
if mv -f .psilink-a.tmp .psilink-b.tmp 2>/dev/null; then echo RENAME_OK; else echo RENAME_FAIL; fi
rm -f .psilink-a.tmp .psilink-b.tmp
