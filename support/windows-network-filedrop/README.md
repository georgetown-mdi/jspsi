# Using a network file drop with psilink on Windows

Your file-drop folder lives on a network location -- you open it in File
Explorer as a mapped drive (`Z:\Exchange`) or a network path
(`\\fileserver\exchange`). Pointing Docker at it does not work:

```text
docker: Error response from daemon: invalid mount config for type "bind":
bind source path does not exist
```

This is not a typo or a permissions problem. Docker does its work inside a small
Linux computer it keeps hidden on your PC, and two things follow from that:

- **It cannot see your drive letters or network paths.** Those belong to
  Windows, not to it. Docker Desktop's file-sharing settings do not help either;
  that list is only for local drives.
- **Your file server treats it as a different computer.** It cannot borrow the
  Windows sign-in that gets you into the folder, so it needs a username and
  password of its own.

The fix is to let Docker open the network folder itself and keep that connection
saved under a name. Docker calls that a **volume**, and creating one is the only
thing the setup script does. Run it once, before your first exchange; it takes
about ten minutes.

## What you need

- **Docker Desktop, running.** The whale icon should be still, not animating.
- **The file-drop folder path.** Click once in the File Explorer address bar and
  it turns into text you can copy.
- **A username and password for that folder.** Not your own Windows sign-in, and
  never an administrator account: Docker stores this password where anyone who
  can use Docker on this PC can read it. Ask for an account that reaches only
  this shared folder and that IT can switch off when you are finished. If you
  have no such account, send IT
  [this ready-made request](troubleshooting.md#what-to-ask-your-it-department-for).
  [Choosing an account](passwords.md) is five minutes well spent -- it is the
  choice here that is awkward to undo.
- **A password with no comma in it.** The script refuses one outright, because
  Docker has no way to pass it. No double quote either, if you end up on the
  Command Prompt version below.

## Which version to run

**Use the PowerShell script, `Setup-PsilinkFileDrop.ps1`.** If it refuses to run
-- some agency PCs block PowerShell scripts -- use the Command Prompt one,
`cmd_Setup-PsilinkFileDrop.cmd`, and stay with it from then on. They ask the
same questions and report the same failures. The one difference to know about is
that Command Prompt cannot hide typing, so your password shows on screen as you
enter it.

Where the two need different commands, this guide gives both, PowerShell first.
A single block means the command is the same in either.

## Get it and run it

Open the Start menu, type `PowerShell`, or `cmd` for the Command Prompt version,
and press Enter. Do not choose **Run as administrator**: an elevated window
cannot see the drive letters you mapped as yourself.

**PowerShell:**

```powershell
Invoke-WebRequest -UseBasicParsing `
  -Uri 'https://raw.githubusercontent.com/georgetown-mdi/jspsi/main/support/windows-network-filedrop/Setup-PsilinkFileDrop.ps1' `
  -OutFile "$env:USERPROFILE\Setup-PsilinkFileDrop.ps1"
```

**Command Prompt** -- four files rather than one, and **all four have to be in
the same folder**, because the script feeds the other three to Docker:

```text
cd /d "%USERPROFILE%"
set BASE=https://raw.githubusercontent.com/georgetown-mdi/jspsi/main/support/windows-network-filedrop
curl -L -o cmd_Setup-PsilinkFileDrop.cmd %BASE%/cmd_Setup-PsilinkFileDrop.cmd
curl -L -o cmd_psilink-probe.sh %BASE%/cmd_psilink-probe.sh
curl -L -o cmd_psilink-credcheck.sh %BASE%/cmd_psilink-credcheck.sh
curl -L -o cmd_psilink-volcheck.sh %BASE%/cmd_psilink-volcheck.sh
```

Use the command rather than saving from a browser, which saves it in a form
Windows will not run. Nothing appears on screen when the download works -- that
is success, and the files land in your user folder.

Then run it:

**PowerShell:**

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Setup-PsilinkFileDrop.ps1"
```

**Command Prompt:**

```text
cmd_Setup-PsilinkFileDrop.cmd
```

It asks you for three things, in this order:

1. **The file-drop folder**, exactly as you see it in Explorer.
2. **Whether the server, share and folder it worked out are right.** The
   **share** is the first name after the server -- in
   `\\fileserver\exchange\dropbox` it is `exchange`. If you are not sure, answer
   `Y`; a later check catches a wrong answer.
3. **A username, a domain, and a password.** If you sign in to Windows as
   something like `AGENCY\yourname`, the domain is the `AGENCY` part; if you
   just type a username, leave it blank. In PowerShell nothing appears on screen
   as you type the password, which is normal.

A good run ends with a heading reading **Ready to run an exchange**, followed by
the command to copy. Anything in red before that is a failure, and the script
says underneath what to do about it.

## When it finishes

It prints the `docker run` command for an exchange with your volume name already
filled in, and explains underneath which parts to replace. One of them is a
folder on this PC that holds your input file; results are written back into the
same folder. It has to be a folder on this PC -- not the file drop, and not a
network path.

Three things to know before the first run:

- **The `.keys.json` file is not a result.** Each run writes one next to the
  matches. It holds the keys to the exchange, so treat it like the input data
  and do not send it on with the results.
- **One exchange per folder at a time.** The folder must start empty, so agree
  who goes first. If a run fails and leaves files behind, see
  [running the exchange](troubleshooting.md#running-the-exchange).
- **Setting up a second file drop replaces this one.** For a second partner,
  give it its own name with `-VolumeName psilink-partner-b`, and use that name
  when you run that exchange.

## When you are done with this partner

Remove the volume. The script prints this command with your volume name in it
when it finishes, and it is the same in either shell:

```text
docker volume rm psilink-rendezvous
```

Then have the account switched off, or its password changed. That, rather than
removing the volume, is what ends the exposure --
[choosing an account, and where its password ends up](passwords.md) says why.

## If something goes wrong

The script says what failed, what it means, and what to do about it. Follow that
first. [**Troubleshooting**](troubleshooting.md) is the longer version, with a
section for each failure, and it covers how to send the whole run to whoever is
helping you.

> **How far this has been tested.** Both versions have been run start to finish
> on Windows 11 against a real file server, and the checks they run inside
> Docker are verified against that server too. Neither has ever met a real DFS
> namespace, which is why the script asks you to confirm the server it worked
> out rather than trusting it. Corrections from a real environment are welcome,
> and are worth more here than anywhere else in this repository.
