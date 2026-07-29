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
#
# The exclusive-create test is mkdir and not "set -C" on a file, though the file
# is what psilink itself uses. busybox ash implements set -C by calling stat and
# refusing in the shell, so the second attempt never issues a syscall and the
# share is never asked -- which made EXCL_WEAK unreachable and the whole check a
# no-op on exactly the sync-backed shares it exists to catch. mkdir takes EEXIST
# from the server. Both map to an SMB create with FILE_CREATE disposition, so
# this is a proxy for O_EXCL rather than the same call, and a share that
# arbitrates the two differently would slip through.
set -u
: "${MARKER:=}"
: "${TOKEN:=}"

cd /rz || { echo NOMOUNT; exit 1; }

# A marker holding someone else's token is left where it is. It is the one file
# a concurrent operator may be relying on right now, and removing it turns their
# own volume check into MARKER_MISSING -- a verdict that blames their server for
# reaching the wrong folder.
if [ -n "$MARKER" ] && [ -f "$MARKER" ]; then
  if grep -q "$TOKEN" "$MARKER" 2>/dev/null; then
    echo MARKER_OK
    rm -f "$MARKER"
  else
    echo MARKER_MISMATCH
  fi
else
  echo MARKER_MISSING
fi

echo probe > .psilink-w.tmp && mv .psilink-w.tmp .psilink-w2.tmp && rm .psilink-w2.tmp && echo WRITE_OK

rm -rf .psilink-x.d
if mkdir .psilink-x.d 2>/dev/null; then
  if mkdir .psilink-x.d 2>/dev/null; then echo EXCL_WEAK; else echo EXCL_OK; fi
else
  echo EXCL_UNTESTED
fi
rm -rf .psilink-x.d

rm -f .psilink-a.tmp .psilink-b.tmp
if echo a > .psilink-a.tmp && echo b > .psilink-b.tmp; then
  if mv -f .psilink-a.tmp .psilink-b.tmp 2>/dev/null; then echo RENAME_OK; else echo RENAME_FAIL; fi
fi
rm -f .psilink-a.tmp .psilink-b.tmp
