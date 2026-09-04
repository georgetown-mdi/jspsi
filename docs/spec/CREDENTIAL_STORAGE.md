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
these files protect and states the operator-facing required permissions,
warnings, and remediation commands; this document covers how each write is
constructed. The same construction governs every owner-only artifact written in
one shot -- the key file (`.psilink.key`), the signing identity, the
self-attested exchange record and the private verification-keys file beside it
(see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)), the dual-signed receipt, the
operator config `psilink.yaml`, and the credentials file that holds the
operator's SMB password to `smbclient` for `doctor probe` -- so it is specified
once here and referenced from each. Two owner-only artifacts are written on the
same principle without taking that construction, and each is specified where it
diverges: the result CSV, streamed to its destination rather than renamed onto
it ([Result CSV output](#result-csv-output)), and the `--log-file` descriptor,
opened in append mode and carrying the extended-ACL strip at that open
([macOS extended-ACL strip](#macos-extended-acl-strip)). This document does not
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
target (the Docker image) -- a crash cannot expose the rename while losing the
file's contents. Because each write flushes its own directory entry before
returning, two sequential writes are crash-ordered there: if the second's rename
is durable, the first's is too. That is the guarantee the self-attested exchange
record relies on (it writes the private verification-keys file before the
summary record, so a crash between the two preserves the salts; see
[EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)), and the one that keeps a freshly
rotated token from being lost.

Neither half of it is POSIX-grounded. `fsync()` belongs to the File
Synchronization option, the nature of the transfer it requests is
implementation-defined, and its rationale states that a null implementation is
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
power loss may show a later write while losing an earlier one -- which is
recoverable by re-running. Linux, the CLI's production target (the Docker
image), flushes durably with `fsync`, so the guarantee holds there in full.

## macOS extended-ACL strip

On Unix the owner-only guarantee is enforced through the POSIX mode bits
(`0600`), which is sufficient on Linux -- the production/Docker target, where
`chmod` also collapses any POSIX ACL mask. On macOS an extended (NFSv4) ACL is
governed separately from the mode bits, so an ACL entry a file inherits from its
parent directory's inheritable ACEs grants another principal access that a
`0600` mode does not remove. Every owner-only artifact written into such a
directory would otherwise hold it, since each lands either in place or on a
fresh inode that still inherits the directory's ACEs.

Each writer therefore clears the file's extended ACL at the point where it
enforces the mode, on macOS alone: `execFileSync("/bin/chmod", [...flags, "-N",
file])`, run on the temp file after its `fchmod` and before any content is
written, and on the streamed result CSV between its `fchmod` and its truncate.
`-N` deletes the ACL entirely -- on an artifact psilink writes, no ACE is
intended, so the mode is meant to be the file's whole access story. There is no
`--` separator: macOS's `chmod` has none and fails trying to open it as a file
(driven on the real tool, 2026-08-17, recorded on the introducing pull
request). A relative operand is absolutized by prefixing the process working
directory and nothing else -- no path join, no normalization, no resolution, so
no `..` segment is collapsed and no separator is rewritten. The one exception is
a working directory of `/`, the only one that already ends in a separator: its
own trailing separator is dropped, so the prefix emits `/name` rather than a
`//name` whose leading double separator POSIX leaves to the implementation. The
operand is thus the writer's own path against the same working directory, and
the kernel resolves it exactly as it resolved the writer's open, `..` through a
symlink included; a lexical collapse would instead aim the strip at a different
file than the one the content lands in. It also begins with `/`, so it cannot
land in the option position, regardless of how any chmod build parses a
dash-leading operand. The absolute `/bin/chmod` keeps the resolution off `PATH`,
and there is no shell -- the operand is a single argument. It is a subprocess
rather than a syscall because Node's `fs` exposes no ACL API.

Building that operand is itself inside the fail-closed boundary, because it can
fail on its own: `process.cwd()` raises `ENOENT` once the working directory has
been removed and a `chdir` has invalidated Node's cached value, and that is a
strip which did not run rather than a bare errno escaping past the writers'
contract. Only a relative path reaches for the working directory, so a path that
is already absolute is stripped without consulting it, and a removed working
directory cannot refuse that write.

Whether the strip follows a symlink at the path is per call site, and each one
takes the posture its own write took, so the ACL cleared belongs to the file the
content lands in:

| Call site | Flags | Why |
| --------- | ----- | --- |
| Temp-file writers (`writeFileOwnerOnly`, `writeFileAtomic`) | `-h -N` | The path is psilink's own temp path, opened with `O_EXCL` and `O_NOFOLLOW`; a symlink at it is one planted in the create window. `-h` acts on the named entry, so following one cannot redirect the strip onto another file's ACL while the content goes to the temp file. |
| Streamed result CSV (`createOwnerOnlyWriteStream`) | `-N` | The path is an operator-supplied output path, opened without `O_NOFOLLOW` and `fchmod`'d on the descriptor, so a pre-existing symlink there is followed by design (see [Result CSV output](#result-csv-output)). `chmod` resolves the path for the same reason: acting on the link node would clear an ACL that governs nothing while the rows landed in a target whose ACEs still stood. Because the strip re-resolves the path rather than acting on the already-`fchmod`'d descriptor -- Node's `fs` exposes no fd-based ACL API -- a destPath swapped between the `fchmod` and the strip aims the two at different files. |
| `--log-file` descriptor (`configureLogFile`) | `-N` | The path is an operator-supplied flag value, opened `"a"` with neither `O_NOFOLLOW` nor `O_EXCL`, so a symlink there is followed and the lines land in its target. The strip resolves the path for the same reason the streamed CSV's does, and inherits the same known limitation: it re-resolves the path rather than acting on the open descriptor. |
| `doctor probe` work directory (`runProbe`) | `-h -N` | The path is one `mkdtemp` created itself, so a symlink at it is one planted in the window after that create. `-h` acts on the named entry, so following one cannot clear an unrelated directory's ACL while the credentials file is created under an inheritable ACE that still stands. |

The strip covers every artifact this document's write construction produces --
the key file, the signing identity, the exchange record and its verification
keys, the dual-signed receipt, the operator config, the `doctor probe`
credentials file, and the result CSV -- and the exported public certificate as
well. It runs at any mode, including that certificate's public `0644`, because
an inherited ACE can grant access (write included) that the explicit mode
withholds. The credentials file is the case where the directory rather than the
destination has the ACE: it is written into a `mkdtemp` directory under the
operator's `TMPDIR`, so an inheritable ACE set there reaches the password
through it.

That directory is therefore stripped in its own right, at `mkdtemp` and before
the credentials file exists. Deleting its ACL removes both the ACE on the
directory an `smbclient` run reads through and the `file_inherit` /
`directory_inherit` flags that would otherwise copy that ACE onto everything
created inside it -- the credentials file, the write probe, and the marker file
-- since an inherited ACE is resolved at creation time from the parent's ACL.
The operand is the directory's own entry: there is no `-R`, and at that point the
directory is empty. The credentials file keeps the writer's own strip as well, so
neither the inheritance nor the file's own ACL depends on the other being
cleared.

A refused strip's message does not name that directory: the fail-closed path
removes it before the message is composed, so `reportedPath` there is
`os.tmpdir()` -- the surviving parent that holds the inheritable ACE, not the
removed `mkdtemp` directory -- and that is the path the generic `ls -le` /
`chmod -N` remediation copy points the operator at. On a shared or system
`TMPDIR` (`TMPDIR=/tmp`, say), that parent is not psilink's own: running
`chmod -N` against it would clear every principal's ACEs on a directory other
software shares, not just the inheritable one this run left behind. The
operator should inspect and remove only the inheritable entries at that path,
or relocate `TMPDIR` for the run, rather than clearing a directory other
software depends on.

That the directory-operand form works at all -- that `/bin/chmod -h -N` accepts
a directory as its operand, and that clearing the ACL there drops both the
`file_inherit` and `directory_inherit` flags -- was driven against the real tool
on 2026-09-01: `npx vitest run apps/cli/test/unit/extendedAclCoverage.test.ts`
on a macOS host, 10 passed and 1 skipped, the skip being the Linux-only "no
strip is attempted on the host's real platform" leg. Both facts come from the
"nothing under an inheriting TMPDIR has an ACE" leg, which pins the
inheritance first -- a control directory and a control file created under the
same root do have the ACE -- and then finds no ACE on the stripped work
directory, on the credentials file, or on a file created beside it afterwards.
No CI runner executes those macOS-gated legs, so they run on demand rather than
continuously, and a regression in them would be caught at the next such run.

The `--log-file` descriptor is stripped at its own open instead, between that
open and the installation of the sink that writes the first line -- the same
placement, the point where the file's mode is enforced. Its content is the run's
diagnostics, which at `debug`/`trace` hold partner identity, linkage keys, and
data categories. That strip runs on a file the open created and one it appends
to alike, unlike the `0600` mode, which the open applies on creation only: the
mode an operator leaves on a file they supplied is a value they can read and set,
while an ACE grants access the mode cannot express on a file the run is about to
write those diagnostics into.

A failed strip is fail-closed, exactly as a failed `icacls` narrowing is on
Windows: no content is written. The temp-file writers unlink the temp file on the
way out, so nothing reaches the destination -- and for the `doctor probe`
credentials file the run goes with it, its whole `mkdtemp` directory removed and
the checks abandoned, rather than a password being delivered through a file whose
ACL could not be cleared. A refused strip of the work directory ends the run on
the same terms one step earlier, the directory removed before the password has
been composed into a file at all. The streamed CSV aborts before its
truncate, so an existing destination keeps its rows; only a file that call itself
created is left behind, empty and already `0600`, mirroring the Windows
placeholder.

The `--log-file` open is refused on the same terms. The descriptor is released
and the diagnostic sink is never installed, so no line can reach the file: an
existing one keeps its content and a file the open created is left behind empty
and `0600`, as the streamed CSV's is. The command reports it as a usage error
(exit 64) before any exchange work begins, with the strip's refusal as its
cause, which is how that open reports a log file it cannot open at all.

The refusal names the file and attaches the underlying failure as its `cause`, so
the display sink renders that failure as its own chain link. Which of two
messages it states turns on whether `chmod` was spawned at all, which
`execFileSync` reports through two fields: the exit status of a child that ran
to completion, and the termination signal of one that died on a kill. A spawned
child sets one of them whatever else went wrong, so the discriminant is either
field being present rather than the value in it:

| Failure | Refusal |
| ------- | ------- |
| `chmod` was spawned: it has an exit status (a numeric `status`, `0` included) or a termination signal (a `signal` string). A nonzero exit is one shape; the 5 s timeout is two more, since the kill leaves a signal and no status on a child that dies on it, but the exit status the child chose and no signal on one that ignores `SIGTERM` and finishes afterwards | "Could not clear extended ACLs on _file_", followed by the `ls -le` / `chmod -N` remediation |
| The strip never ran, with neither a status nor a signal: no `/bin/chmod`, an exec the OS refused, or a `process.cwd()` that threw before the command line existed | "Could not run the extended-ACL strip on _file_; no content was written" |
| Either shape above, at the `doctor probe` work-directory strip: `reportedPath` there is `os.tmpdir()`, not the `mkdtemp` directory the strip operand names, because a refused strip removes that directory before either message is composed | Names the operator's temp root (`os.tmpdir()`), the surviving ancestor that holds the inheritable ACE, in place of _file_ -- not the removed `mkdtemp` directory |

Those field shapes are captured from `execFileSync` in the CLI unit tests and
fed to the classifier rather than modeled there, so a runtime that reshaped them
reddens the suite instead of silently re-routing a refusal.

The split exists because only the first case puts the remedy in the operator's
hands: a spawned `chmod -N` may have begun altering an existing destination's
ACL before it exited, was killed, or outlived the kill, so the ACL is the
obstacle to inspect, while sending them after `ls -le` on a host that could not
run `chmod` at all points them at something that was never in the way. The errno
separating the second case's causes rides in on the `cause` rather than being
enumerated in the message.

What that `cause` discloses is Node's own text for the failure, in one of two
forms. A child that ran to completion untimed renders
`Command failed: /bin/chmod <flags> <operand>`, so the whole command line
reaches the operator -- and for the temp-file writers the operand is the temp
path, `<destination>.tmp.<pid>`. A spawn failure and both timeout shapes render
`spawnSync /bin/chmod <errno>` instead, naming the binary and no operand. The
temp path is psilink's own construction and holds no content when the strip
refuses, and the refusal message already names the destination it derives from,
so what the first form adds beyond the errno is this process's pid.

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
ensures the token is never on disk while the file still has inherited ACEs
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
