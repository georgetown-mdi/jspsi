# Maintainer notes: the Command Prompt file-drop setup on Windows

Notes on `cmd_Setup-PsilinkFileDrop.cmd` and its three container-side scripts in
[`support/windows-network-filedrop`](../windows-network-filedrop/README.md).
They live outside that folder for the same reason the PowerShell notes do: the
guide is handed to an operator as a unit, and what is here -- what is
unverified, what was tried and failed -- is addressed to whoever maintains it
next.

The PowerShell notes are [`windows-network-filedrop.md`](windows-network-filedrop.md).
Read them first. Everything they say about the problem, about DFS, and about
what Docker does with the password applies here unchanged; this file covers
only what is different because the script is a batch file.

## Why there is a second script

`Setup-PsilinkFileDrop.ps1` cannot run where Windows PowerShell is absent or
blocked. The runbook already had a section for the blocked case, but its advice
was to do the work by hand using PowerShell commands, which is no help on a
machine where PowerShell is the obstacle. The Command Prompt script closes
that: it does the same four parts against the same container checks, using
nothing but `cmd`, `net use`, `fsutil`, `findstr` and `docker`.

## What is here

- `cmd_Setup-PsilinkFileDrop.cmd` -- the operator-facing script. Same four
  parts, same exit codes, same runbook section names as the PowerShell version.
- `cmd_psilink-probe.sh` -- the container checks, steps 1 to 6. A port of the
  `$probe` here-string in the PowerShell script.
- `cmd_psilink-credcheck.sh` -- inspects the password and mints the run token.
- `cmd_psilink-volcheck.sh` -- the checks that run over the mounted volume.

The three shell scripts are separate files rather than text embedded in the
batch file. Embedding them would mean escaping every `%`, `>`, `&`, `|` and
`^` in four hundred lines of shell, and each of those escapes is a defect
waiting to happen -- see the hazards below, three of which were found in this
script's own guidance text.

## State

**Verified end to end against a real Samba server**, driven from `cmd.exe` on
Windows 11 with Docker Desktop 28.3.2, against a Samba 4.21.9 container on the
Docker bridge. The share password used throughout was `Pa!ss&w%rd^1`, chosen
because it contains every character the measurements below identify as
dangerous in `cmd`.

Covered: a full pass ending in a mounted CIFS volume, from `-Server`/`-Share`
/`-SubPath` and from `-DropPath`; the same against the share root, with no
subfolder; `-Dialect SMB3`, confirmed to reach the volume as `vers=3.1.1`; the
confirmation prompt, both accepted and declined; a wrong password reported as
`NT_STATUS_LOGON_FAILURE`; an empty password, one containing a comma, and one
containing a double quote, each refused before anything was created; a mapped
drive letter resolved to its UNC root; a local path, an absent drive letter,
and a UNC naming a server but no share, each classified correctly; a subfolder
several levels deep folded to forward slashes; an existing CIFS volume replaced
on a second run; a volume of the same name that this script did not make, left
alone with its contents intact; and the usage text and an unrecognised option.

The password stored in the volume metadata was read back and compared: it
arrives as `Pa!ss&w%rd^1`, unaltered.

`cmd_psilink-volcheck.sh` was verified directly over a real CIFS mount, in all
three marker states -- absent, matching the run token, and holding a different
token -- along with `WRITE_OK`, `EXCL_OK` and `RENAME_OK`. The script's routing
of `MARKER_OK` was exercised by the full runs. Its routing of `MARKER_MISSING`
was not: forcing it needs the volume and the probe to disagree about which
directory they reached, which is the DFS case, and the DFS case cannot be
mocked here. The PowerShell notes reach the same limit by the same route.

Still unverified: the Windows-containers branch, which needs Docker Desktop
switched to Windows containers to reach; the localised-Windows behaviour
discussed under `net use` and `fsutil` below; and DFS, which the PowerShell
notes explain at length and which nothing here changes.

## What cmd does to a password, measured

These were established by driving `docker volume create` from a batch file with
each password in turn and reading the value back with `docker volume inspect`.
They are the reason the script is shaped the way it is, and none of them is
safe to reason about instead of measuring.

With delayed expansion **disabled** and the mount option passed as one quoted
argument, every one of these round-trips intact: `!`, `&`, `|`, `>`, `%`, `^`,
`;`, `(`, `)`, `~`, a backtick, `=`, `$`, a backslash, and a space.

Two characters do not:

- **A double quote breaks the argument.** It ends the quoted option early,
  Docker reads the remainder as separate words, and creates an *anonymous*
  volume -- a stray with a hex name -- instead of the one asked for. The run
  then fails looking for a volume that was never created. The script refuses a
  password containing a double quote for this reason, alongside the comma the
  PowerShell script already refused.
- **An exclamation mark disappears under delayed expansion.** With
  `enabledelayedexpansion`, `Pa!ss` reaches Docker as `Pass`. Nothing is
  printed and nothing fails; the mount is simply attempted with the wrong
  password and reports as a logon failure. This is why delayed expansion stays
  off for the whole run and is enabled only inside `:resolve_mapped`, where no
  password is live.

A third result decided where the password is inspected. **Expanding a variable
holding `&`, `|` or `>` into any parsed line breaks the batch file**: `if not
"%PW%"=="%PW: =%"` aborts with `& was unexpected at this time` rather than
reporting anything. `cmd` re-parses whatever an expansion produces, so `cmd`
cannot examine a password at all. That is what `cmd_psilink-credcheck.sh` is
for: the value reaches the container through the environment, which is never
re-parsed, and the shell inspects it there.

The same reasoning covers how the password reaches the checks. `set /p` stores
what is typed literally -- it is only expansion that is dangerous -- so the
script reads it straight into `SMB_PASS` and passes it with `docker run --env
SMB_PASS`, naming the variable without a value. It is never on a command line
until the volume is created, which matches what the PowerShell script does.

One consequence for anyone scripting a test: **a `%` in a batch file literal is
eaten**. `set "SMB_PASS=Pa!ss&w%rd^1"` stores `Pa!ss&wrd^1`, which presents as
a wrong password. It has to be written `%%` in a file, or read at run time.
This bit the first verification harness written for this script.

## Hazards in cmd that this script had to be shaped around

Each of these was a real defect in this script before it was a note here.

**A batch file must have CRLF line endings.** With LF alone, `cmd` stops at the
first `goto` with `The system cannot find the batch label specified`. This is
the mirror image of the fault the PowerShell pass found, where `sh` choked on
carriage returns. Both now hold: `.gitattributes` marks the `.cmd` file `-text`
so it is stored and served with CRLF -- which matters because the runbook tells
operators to download the raw file, and a raw download serves the stored blob,
not a converted checkout -- and the shell scripts are stored LF and are also
fed through `tr -d '\r'` at run time, so a copy that picks up CRLF some other
way still runs.

**A redirection character in printed text redirects.** Text containing `>` or
`<` survives being passed to a subroutine as a quoted argument, but the `echo`
that prints it there re-parses the line: the text vanishes into a file and the
run ends with `'1' is not recognized as an internal or external command`. A
caret escape written inside the quoted argument does not help, because the
escape is consumed before the echo sees it. Two lines of guidance text hit this
and were reworded; the one place that genuinely needs to print a redirection
does so with a direct `echo(` at the top level, where the escape is read.

**`echo` with an empty argument prints `ECHO is off.`** Every blank line in the
guidance came out that way. All the printing subroutines now open with `echo(`.

**A doubled quote inside a quoted argument stays doubled.** `%~1` strips only
the outer pair, so `""Synced folders""` printed as-is. The prose uses single
quotes for quoted phrases now.

**`%errorlevel%` on an `&`-joined line reads 0.** It expands when the line is
parsed, before the command has run. In a batch file with one command per line
it is correct -- measured at 2 and 0 against a failing and a succeeding
container. Nothing in the script joins commands with `&` except flag
assignments, which set no exit code.

## Two lookups that have no PowerShell equivalent here

`Resolve-MappedDrive` in the PowerShell script has three independent methods
and falls back between them. `cmd` has one: `net use H:`, whose output looks
like

```text
Local name        H:
Remote name       \\127.0.0.1@8080\Exchange
Resource type     Disk
```

The script finds the UNC by looking for the token beginning `\\`, not by
matching the words `Remote name`, which are translated on a localised Windows.
It was verified against a real drive mapping, served over WebDAV -- Windows
holds port 445 for its own file sharing, so a container cannot serve SMB to the
host, which is the same obstacle the PowerShell notes record. SMB-specific
mapping behaviour is therefore still untested, as it is there.

`Get-DriveKind` becomes `fsutil fsinfo drivetype`, which works without
elevation and returns `Fixed Drive`, `Remote/Network Drive` or `No such Root
Directory` for the three cases the script distinguishes. Its exit code is 0 in
all three, so the string has to be read -- and that string is localised. On a
non-English Windows the script will fall through to its last message, which
tells the operator the drive is not there. That is wrong but not harmful, and
fixing it properly means a lookup that does not exist in `cmd`.

## Decisions worth not relitigating

**The probe is a second copy, not a shared file.** The maintainer of this branch
asked for a standalone `cmd_`-prefixed set, and that is what this is. It is
worth being clear about the cost: the PowerShell notes record that a second,
hand-maintained copy of the container diagnostic already drifted once -- it read
`SMB_VERS` where the script exported `SMB_DIALECT`, so the dialect was silently
ignored -- and was deleted rather than resynchronised. `cmd_psilink-probe.sh`
is that same text again, and nothing currently detects the two falling out of
step. A check that extracts the `$probe` here-string from the `.ps1` and
compares it to this file, ignoring only the script-name references, would close
it. It has not been built, because adding a repository check was not part of
what was asked for.

**The password is visible as it is typed.** `cmd` has no equivalent of
`Read-Host -AsSecureString`, and `set /p` echoes. No reliable way to suppress
the echo in plain `cmd` was found that does not depend on something else being
installed. The script warns before prompting and suggests `cls` afterwards.
Given the operator is the machine's own user, this is a warn-and-guide case
rather than a reason to refuse.

**The password is not masked out of Docker's error text; the line is dropped.**
The PowerShell script does a string substitution to mask it. `cmd` cannot
substitute inside a variable that may itself hold the characters `cmd` parses,
which is the whole difficulty above. So `:show_safely` prints every line of
Docker's output except those containing `password=`, and says that a line was
withheld. It loses some diagnostic detail in exchange for not printing the
password.

## If you pick this up

Everything needed to re-run the verification is a Samba container on the Docker
bridge and, for the drive-letter half, Apache with `mod_dav` published on any
port with `net use H: \\127.0.0.1@8080\Exchange`. The PowerShell notes describe
both rigs in more detail, including the `force user` trap that makes every
write return `ACCESS_DENIED` and reads exactly like a genuine permissions
finding.

Driving this script unattended is easier than driving the PowerShell one: it
needs no `Read-Host` shim. `set /p` reads standard input, so the answers can be
supplied from a file, one line per prompt, redirected into the script. With
`-Server`, `-Share`, `-Username` and `-Domain` given on the command line the
only line needed is the password.
