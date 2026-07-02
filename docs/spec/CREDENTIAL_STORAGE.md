---
title: "Credential and Result File Storage"
---

# Credential and result file storage

This document specifies how PSI-Link writes its owner-only credential and result
files: the POSIX exclusive-create and atomic-rename discipline, the `fsync`
durability and cross-write crash-ordering guarantee, the macOS `F_FULLFSYNC` and
NFSv4-ACL caveats, the writable-and-readable-parent pre-flight, and the Windows
ACL-narrowing and load-check internals. It is the implementation-level
complement to the **Key file security** overview in
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#key-file-security), which says what
these files protect and carries the operator-facing required permissions,
warnings, and remediation commands; this document covers how each write is
constructed. The same construction governs four owner-only artifacts -- the key
file (`.psilink.key`), the signing identity, the self-attested exchange record
(see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)), and the result CSV -- so it is
specified once here and referenced from each. It does not cover what the files
contain or the threat model (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md)).
Intended readers are security auditors and implementors.

## POSIX write discipline

The CLI writes `.psilink.key` with mode `0600` (owner-read-only). The write goes
to a sibling temp file created on an exclusive, non-following descriptor
(`O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW`) whose mode is set on the descriptor
before any content is written, then atomically renamed into place, mirroring the
Windows create-then-restrict discipline below: a symlink planted at the temp
path cannot redirect the write to another file.

The write is also durable across a power loss: the temp file's data is `fsync`'d
before the rename and the parent directory is `fsync`'d after it, so a crash
cannot surface the rename while losing the file's contents. Because each write
flushes its own directory entry before returning, two sequential writes are
crash-ordered -- if the second's rename is durable, the first's is too. This is
the guarantee the self-attested exchange record relies on (it writes the private
verification-keys file before the summary record, so a crash between the two
preserves the salts; see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)), and the one
that keeps a freshly rotated token from being lost.

## macOS durability

Node's `fs` exposes `fsync` (`fsync(2)`), not the macOS `F_FULLFSYNC`, so on
macOS the flush moves the data from the OS to the drive but does not force the
drive to commit its volatile cache to stable media and does not stop the drive
reordering writes; databases such as SQLite and Postgres use `F_FULLFSYNC` on
macOS precisely for that stronger guarantee. So on macOS the crash-ordering
above holds against process death but not necessarily a true power loss -- a
power loss may surface a later write while losing an earlier one -- which is
recoverable by re-running. Linux, the CLI's production target (the Docker
image), flushes durably with `fsync`, so the guarantee holds there in full.

## macOS extended-ACL caveat

On Unix the owner-only guarantee is enforced through the POSIX mode bits
(`0600`), which is sufficient on Linux -- the production/Docker target, where
`chmod` also collapses any POSIX ACL mask. On macOS an extended (NFSv4) ACL is
governed separately from the mode bits, so an ACL entry a file inherits from its
parent directory's inheritable ACEs can grant another principal access that a
`0600` mode does not remove. This affects every owner-only artifact written into
such a directory (the key file, signing identity, exchange records, and the
result CSV), since each lands either in place or on a fresh inode that still
inherits the directory's ACEs. The operator-facing remediation (`ls -le` to
inspect, `chmod -N` to clear) is in
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#required-permissions).

## Writable-and-readable-parent pre-flight

Before a recurring exchange's handshake, psilink validates that the key file can
be written, because a write that fails after the handshake has rotated the
shared secret can desynchronize the two parties' tokens and force a
re-invitation. On POSIX the key file's parent directory must be both writable
and readable by the owner: the post-write parent-directory `fsync` opens the
parent for reading, so a write-only (mode `0o300`) parent that passes a naive
writability check would still fail the durability flush after rotation. The
pre-flight therefore rejects a writable-but-not-readable parent up front.

## Windows write discipline and load check

The CLI enforces ACLs on write: it creates an empty placeholder file, narrows
its ACL with `icacls /inheritance:r /grant:r` to grant Modify (`M`) to the
current user only, then writes the token into the already-protected file. This
ensures the token is never on disk while the file still carries inherited ACEs
(e.g. the default `BUILTIN\Users` read). If the `icacls` call fails (for example
in a restricted container environment), the placeholder is deleted and an error
is raised; no key material is written.

On Windows the token's data is flushed the same way as on Unix -- the writer
reopens the ACL-narrowed file to write the content and `FlushFileBuffers` it
through a handle before the rename -- but the parent-directory flush is not
reachable: Node's `fs` exposes no way to open a directory handle and
`FlushFileBuffers` it (the directory `fsync` the Unix path performs). So the
cross-write crash-ordering guarantee above is POSIX-only and NTFS metadata
journaling governs the durability of the directory entry here. The operation is
recoverable in any case -- a lost rotated token or exchange record is re-produced
by re-running -- so the residual Windows gap is a durability one, not a
confidentiality one.

On load, the CLI first attempts to use PowerShell's `Get-Acl` with SID
translation, which checks both inherited and explicit ACEs in a
locale-independent way; SYSTEM (`S-1-5-18`) and Administrators (`S-1-5-32-544`)
are not flagged. If PowerShell is unavailable -- for example in Nano Server
containers or environments with strict application control policies -- the CLI
falls back to `icacls`, which checks only explicit (non-inherited) non-owner
ACEs. `fs.statSync` is not used for either check because it returns simulated
POSIX mode bits that do not reflect the actual ACL.

The `icacls` remediation the overview shows uses `%USERDOMAIN%\%USERNAME%`, the
domain-qualified name (e.g. `CORP\alice` or `COMPUTER\alice`) that `icacls`
requires to resolve domain accounts unambiguously; this matches the value the
CLI obtains internally via `whoami`. On a standalone (non-domain) machine
`%USERDOMAIN%` equals the computer name, which is correct.

## Result CSV output

The matched-records CSV that `psilink exchange` writes to an output path -- the
most sensitive artifact the tool produces -- is created owner-only on the same
principle as the key file: `0600` on Unix and an `icacls`-narrowed ACL on
Windows, applied before any rows are written, so the output is not left world- or
group-readable by an inherited umask. On Windows the ACL is recreated free of
inherited and foreign ACEs; on Unix the macOS extended-ACL caveat above applies
to it exactly as to every other owner-only artifact (a pre-existing or
directory-inherited extended ACL on macOS is not stripped by the `0600` mode).

Unlike the credential writers, the CSV is streamed directly to the output path
(the result set may be large) rather than written through the
temp-file-and-rename they use, and the operator-supplied output path is not
symlink-hardened; the owner-only guarantee is the same. Writing the result to
stdout (no output path given) applies no permission handling -- in particular,
redirecting stdout to a file with a shell `>` leaves that file at the shell's
umask, since the shell, not the CLI, creates it; pass an output path to get the
owner-only treatment. Because that exposure is silent, the CLI detects the
redirect at runtime -- `fs.fstatSync(1).isFile()` is true for a `> file`
redirect but false for a TTY, a pipe, or `/dev/null` -- and emits a one-line
notice naming the umask exposure and pointing at the OUTPUT_FILE-path
alternative. The notice goes through the logger, so it lands on stderr under the
default sink and is captured by `--log-file`, and never corrupts the result CSV
on stdout; it is emitted at error level rather than warn so a routine
`--log-level error` (which suppresses warn) does not hide a sensitive-data
exposure -- the same error-level-for-a-must-stay-visible-advisory choice the
exchange recovery hint makes. `--log-level silent`, which suppresses every
level, does suppress it, consistent with that flag meaning emit nothing: an
operator who silences all diagnostics forgoes this one too. A TTY, a pipe, and
`/dev/null` do not fire; only a redirect that leaves an under-permissioned
regular file behind. The check is
fd-1-local: a redirect applied outside this process -- e.g. on the host across a
container boundary, where the CLI's own fd 1 is a pipe to the runtime -- is
undetectable and does not fire, so the absence of the notice is not a guarantee
the output is owner-only.

## See also

- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#key-file-security) - what these files protect, and the operator-facing permissions, warnings, and remediation
- [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md) - the self-attested record whose two-file write relies on the cross-write crash-ordering guarantee
- [PROTOCOL.md](PROTOCOL.md#shared-secret-rotation) - the rotated token this write path persists
