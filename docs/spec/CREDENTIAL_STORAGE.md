---
title: "Credential and Result File Storage"
---

# Credential and result file storage

This document specifies how PSI-Link writes its owner-only credential and result
files: the POSIX exclusive-create, exact-mode, and atomic-rename discipline, the
platform-dependent `fsync` durability and cross-write crash-ordering guarantee
laid over it, the macOS `F_FULLFSYNC` caveat and NFSv4-ACL strip, the
writable-and-readable-parent pre-flight, and the Windows ACL-narrowing and
load-check internals. It is the implementation-level complement to the
**Key file security** overview in
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#key-file-security), which says what
these files protect and carries the operator-facing required permissions,
warnings, and remediation commands; this document covers how each write is
constructed. The same construction governs every owner-only artifact written in
one shot -- the key file (`.psilink.key`), the signing identity, the
self-attested exchange record and the private verification-keys file beside it
(see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)), the dual-signed receipt, and the
operator config `psilink.yaml` -- so it is specified once here and referenced
from each. The result CSV is owner-only on the same principle but is streamed to
its destination rather than written through that construction; its writer is
specified in [Result CSV output](#result-csv-output). This document does not
cover what the files contain or the threat model (see
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md)). Intended readers are security
auditors and implementors.

## POSIX write discipline

The CLI writes `.psilink.key` with mode `0600` (owner-read-only). The write goes
to a sibling temp file created on an exclusive, non-following descriptor
(`O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW`) whose mode is set on the descriptor
before any content is written, then atomically renamed into place, mirroring the
Windows create-then-restrict discipline below: a symlink planted at the temp
path cannot redirect the write to another file.

Each of those three properties is POSIX.1-2017 (IEEE Std 1003.1-2017) behavior,
and portable as such. `open()` makes the existence check and the creation atomic
against another thread opening the same name with `O_CREAT | O_EXCL`, and fails
with `[EEXIST]` when the path names a symlink whatever its contents;
`O_NOFOLLOW` refuses a symlinked final component with `[ELOOP]` on any open, so
the refusal does not rest on the exclusive create alone. `fchmod()` on the open
descriptor sets the exact mode, where the mode passed to `open()` is masked by
the process file-mode creation mask. `rename()` keeps the destination name
resolving throughout to either the file it named before the call or the one
being renamed onto it, so no window exposes a partially written or wrongly
permissioned file at the destination path.

Durability across a power loss is a separate property, and it is the platform's
rather than POSIX's. The temp file's data is `fsync`'d before the rename and the
parent directory is `fsync`'d after it, so on Linux -- the CLI's production
target (the Docker image) -- a crash cannot surface the rename while losing the
file's contents. Because each write flushes its own directory entry before
returning, two sequential writes are crash-ordered there: if the second's rename
is durable, the first's is too. That is the guarantee the self-attested exchange
record relies on (it writes the private verification-keys file before the
summary record, so a crash between the two preserves the salts; see
[EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)), and the one that keeps a freshly
rotated token from being lost.

Neither half of it is POSIX-grounded. `fsync()` belongs to the File
Synchronization option, the nature of the transfer it requests is
implementation-defined, and its RATIONALE states that a null implementation is
explicitly intended to be permitted; in the middle ground between the extremes
it describes, `fsync()` "might or might not actually cause data to be written
where it is safe from a power failure". What an `fsync()` on a directory
descriptor commits is not specified at all, so the directory-entry flush the
cross-write ordering depends on rests entirely on the platform. The macOS and
Windows sections below scope what holds away from Linux: on macOS the ordering
survives process death but not necessarily a true power loss, and on Windows the
directory flush is unreachable.

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

## macOS extended-ACL strip

On Unix the owner-only guarantee is enforced through the POSIX mode bits
(`0600`), which is sufficient on Linux -- the production/Docker target, where
`chmod` also collapses any POSIX ACL mask. On macOS an extended (NFSv4) ACL is
governed separately from the mode bits, so an ACL entry a file inherits from its
parent directory's inheritable ACEs grants another principal access that a
`0600` mode does not remove. Every owner-only artifact written into such a
directory would otherwise carry it, since each lands either in place or on a
fresh inode that still inherits the directory's ACEs.

Each writer therefore clears the file's extended ACL at the point where it
enforces the mode, on macOS alone: `execFileSync("/bin/chmod", [...flags, "-N",
"--", file])`, run on the temp file after its `fchmod` and before any content is
written, and on the streamed result CSV between its `fchmod` and its truncate.
`-N` deletes the ACL entirely -- on an artifact psilink writes, no ACE is
intended, so the mode is meant to be the file's whole access story. `--` ends the
options so an operator-supplied path beginning with `-` is read as an operand,
and the absolute `/bin/chmod` keeps the resolution off `PATH`. There is no
shell -- the operand is a single argument. It is a subprocess rather than a
syscall because Node's `fs` exposes no ACL API.

Whether the strip follows a symlink at the path is per call site, and each one
takes the posture its own write took, so the ACL cleared belongs to the file the
content lands in:

| Call site | Flags | Why |
| --------- | ----- | --- |
| Temp-file writers (`writeFileOwnerOnly`, `writeFileAtomic`) | `-h -N --` | The path is psilink's own temp path, opened with `O_EXCL` and `O_NOFOLLOW`; a symlink at it is one planted in the create window. `-h` acts on the named entry, so following one cannot redirect the strip onto another file's ACL while the content goes to the temp file. |
| Streamed result CSV (`createOwnerOnlyWriteStream`) | `-N --` | The path is an operator-supplied output path, opened without `O_NOFOLLOW` and `fchmod`'d on the descriptor, so a pre-existing symlink there is deliberately followed (see [Result CSV output](#result-csv-output)). `chmod` resolves the path for the same reason: acting on the link node would clear an ACL that governs nothing while the rows landed in a target whose ACEs still stood. Because the strip re-resolves the path rather than acting on the already-`fchmod`'d descriptor -- Node's `fs` exposes no fd-based ACL API -- a destPath swapped between the `fchmod` and the strip aims the two at different files. |

The strip covers every artifact this document's write construction produces --
the key file, the signing identity, the exchange record and its verification
keys, the dual-signed receipt, the operator config, and the result CSV -- and
the exported public certificate as well. It runs at any mode, including that
certificate's public `0644`, because an inherited ACE can grant access (write
included) that the explicit mode withholds.

A failed strip is fail-closed, exactly as a failed `icacls` narrowing is on
Windows: no content is written, and the error names the file and the `ls -le` /
`chmod -N` remediation. The temp-file writers unlink the temp file on the way
out, so nothing reaches the destination. The streamed CSV aborts before its
truncate, so an existing destination keeps its rows; only a file that call
itself created is left behind, empty, mirroring the Windows placeholder.

Off macOS no strip is attempted: on Linux the numeric `chmod` already collapses
the POSIX ACL mask, and Windows owner-only enforcement is the `icacls`
narrowing below. The operator-facing remediation for a file psilink did not
write (`ls -le` to inspect, `chmod -N` to clear) is in
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
cross-write crash-ordering guarantee above is confined to the Unix write path,
and NTFS metadata journaling governs the durability of the directory entry here.
The operation is recoverable in any case -- a lost rotated token or exchange
record is re-produced by re-running -- so the residual Windows gap is a
durability one, not a confidentiality one.

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
inherited and foreign ACEs; on macOS the [extended-ACL
strip](#macos-extended-acl-strip) above clears a pre-existing or
directory-inherited ACE that the `0600` mode would not, before the file is
truncated. That strip resolves the output path rather than acting on the entry
named, so where the path is a symlink it clears the ACL of the target the rows
go to, matching the `fchmod` on the descriptor.

Unlike the credential writers, the CSV is streamed directly to the output path
(the result set may be large) rather than written through the
temp-file-and-rename they use, and on POSIX the operator-supplied output path is
not symlink-hardened: the destination is opened `O_WRONLY | O_CREAT` with
neither `O_NOFOLLOW` nor `O_EXCL`, so a symlink already at that path is
followed. On Windows a link at that path is not followed: any existing
destination is unlinked (which removes the link itself, not its target) and
recreated on an exclusive descriptor before its ACL is narrowed. The owner-only
guarantee is the same on both. Writing the result to
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
