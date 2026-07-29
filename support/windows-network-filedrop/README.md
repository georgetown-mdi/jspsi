# Using a network file drop with psilink on Windows

Your file-drop folder lives on a network location -- you open it in File
Explorer as a mapped drive (`Z:\Exchange`) or a network path
(`\\fileserver\exchange`). Passing that path to Docker does not work:

```text
docker: Error response from daemon: invalid mount config for type "bind":
bind source path does not exist
```

This is not a typo or a permissions problem. The Docker engine runs inside a
Linux virtual machine, and that VM cannot see mapped drive letters or network
paths at all. Docker Desktop's file-sharing settings do not help either; that
list is only for local drives.

The fix is to let Docker mount the network folder itself, as a named volume.
`Setup-PsilinkFileDrop.ps1` works out what that takes and does it. You run it
once, before your first exchange, and it takes about ten minutes.

## First, check it is a file server

Ask your partner whether the drop is a live file server or a folder a sync
client keeps in step (OneDrive, Dropbox, Egnyte, ShareFile). The two look
identical in File Explorer, and a synced folder needs no volume at all -- none
of this page applies to it, so go straight to
[Synced folders](troubleshooting.md#synced-folders). If you are not sure, ask
now and read on while you wait.

## What you need

- **Docker Desktop, running.** The whale icon in the notification area should
  be still, not animating.
- **The file-drop folder path.** Click once in the File Explorer address bar
  and it turns into text you can copy.
- **A username and password** the container can use to reach that folder. It
  need not be your own Windows sign-in, and it should not be: Docker stores the
  password where anyone who can run Docker on this PC could read it. Use an
  account scoped to this share, or one you can retire afterwards. Never a
  domain administrator, and never an account whose password protects anything
  else. The password must not contain a comma. If you have no such account,
  send IT [this ready-made request](troubleshooting.md#what-to-ask-your-it-department-for),
  and see [where your password ends up](troubleshooting.md#where-your-password-ends-up).
- **A local folder on this PC.** It holds the CSV you want to match, and
  results are written back into it. It must be a real local folder such as
  `C:\psilink\work`, not the file-drop folder and not any network path.

## Get it and run it

Every command here is PowerShell. Open the Start menu, type `PowerShell`, and
press Enter. Do not choose **Run as administrator**: an elevated window cannot
see the drive letters you mapped as yourself.

If this PC has no PowerShell, or policy blocks it, use the
[Command Prompt version](command-prompt.md) instead. It does the same thing and
reports the same failures -- but not with these commands, so follow that page
for the commands themselves.

```powershell
Invoke-WebRequest -UseBasicParsing `
  -Uri 'https://raw.githubusercontent.com/georgetown-mdi/jspsi/main/support/windows-network-filedrop/Setup-PsilinkFileDrop.ps1' `
  -OutFile "$env:USERPROFILE\Setup-PsilinkFileDrop.ps1"
```

Downloading it this way rather than through a browser avoids two things that
catch people out: a browser renders the script as text and often saves it as
`.txt`, and a file saved from a browser is refused until you run
`Unblock-File` on it.

It will ask you for three things, in this order:

1. **The file-drop folder**, exactly as you see it in Explorer.
2. **Whether the server, share and folder it worked out are right.** If you are
   not sure, answer `Y`. A later check compares the folder the volume opens
   against the one it just tested, and tells you if they differ.
3. **A username, a domain, and a password.** Leave the domain blank if you do
   not have one. Nothing appears on screen as you type the password; that is
   normal.

Then run it:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Setup-PsilinkFileDrop.ps1"
```

It tests the share from inside a container, creates the volume, and prints the
command to run your exchange.

## When it finishes

It prints a `docker run` command with your volume name already in it, and
explains underneath which parts to replace: the local work folder, and the
names of your input and output CSV files. Fill those in and that is the command
you run for every exchange from now on. You only need the setup script again if
the password changes.

Three things to know before the first run:

- **The `.keys.json` file is not a result.** Each run writes one into your work
  folder next to the matches. It holds the keys to the exchange, so treat it
  like the input data and do not send it on with the results.
- **One exchange per folder at a time.** The folder must start empty, so agree
  who goes first. If a run fails and leaves files behind, see
  [Running the exchange](troubleshooting.md#running-the-exchange) -- which also
  covers setting up a second file drop, since a second one replaces the first
  unless you give it its own name.
- **The exchange has an end.** When you are done with this partner, remove the
  volume and have the account retired or its password reset. The reasons are
  under [Where your password ends up](troubleshooting.md#where-your-password-ends-up);
  the script prints the command when it finishes.

## If something goes wrong

The script says what failed, what it means, and what to do about it. Follow
that first. [**Troubleshooting**](troubleshooting.md) is the longer version,
with a section for each failure.

To send the whole run to whoever is helping you:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Setup-PsilinkFileDrop.ps1" 6>&1 2>&1 |
  Tee-Object "$env:USERPROFILE\psilink-setup-log.txt"
```

That log holds the server, share and account names and what each check said. It
does not hold your password, the names of the files in your drop folder, or the
other shares on your file server.

> **How far this has been tested.** The checks that run inside the container,
> and the volume once it is created, are verified against a real SMB server:
> both the failures they report and the share behaviour psilink depends on. The
> Windows side is verified on Windows 11 under Windows PowerShell 5.1 against
> the same kind of server; a few messages have been added since that run. It has
> never been tried against a real DFS namespace, which is why the script asks
> you to confirm the server it worked out rather than trusting it. The
> [Command Prompt version](command-prompt.md) was verified the same way, on the
> same server, with a password holding every character Command Prompt is known
> to mangle. Its container checks have since been replaced by the ones the
> PowerShell script uses, and that replacement has not been run from Windows.
> Corrections from a real environment are welcome, and are worth more here than
> anywhere else in this repository.
