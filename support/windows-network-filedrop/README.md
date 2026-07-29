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

## What you need

- **Docker Desktop, running.** The whale icon in the notification area should
  be still, not animating.
- **The file-drop folder path.** Click once in the File Explorer address bar
  and it turns into text you can copy.
- **A username and password** the container can use to reach that folder, which
  is not necessarily your own Windows sign-in. Docker stores it where anyone
  who can run Docker on this PC could read it, so use an account scoped to this
  share or one you can retire afterwards, never a domain administrator, and
  never one whose password protects anything else. No comma in the password.
  If you have no such account, there is a
  [ready-made request to send IT](troubleshooting.md#what-to-ask-your-it-department-for);
  where the password ends up is set out
  [here](troubleshooting.md#what-this-does-with-your-password).
- **A local folder on this PC** holding the CSV you want to match. Results are
  written back into it. It must be a real local folder -- `C:\psilink\work` is
  fine -- not the network drop folder and not a network path.

## Run it

Every command here is PowerShell. Open the Start menu, type `PowerShell`, and
press Enter -- **not** "as Administrator", because an elevated window cannot
see the drive letters you mapped as yourself.

```powershell
Invoke-WebRequest -UseBasicParsing `
  -Uri 'https://raw.githubusercontent.com/georgetown-mdi/jspsi/main/support/windows-network-filedrop/Setup-PsilinkFileDrop.ps1' `
  -OutFile "$env:USERPROFILE\Setup-PsilinkFileDrop.ps1"

powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Setup-PsilinkFileDrop.ps1"
```

Downloading it this way rather than through a browser avoids two things that
catch people out: a browser renders the script as text and often saves it as
`.txt`, and a file saved from a browser is refused until you run
`Unblock-File` on it.

It will ask you for three things, in this order:

1. **The file-drop folder**, exactly as you see it in Explorer.
2. **A username, a domain, and a password.** Leave the domain blank if you do
   not have one. Nothing appears on screen as you type the password; that is
   normal.
3. **Whether the server, share and folder it worked out are right.** If you are
   not sure, answer `Y`. A later check compares the folder the volume opens
   against the one it just tested, and tells you if they differ.

Then it tests the share from inside a container, creates the volume, and prints
the command to run your exchange.

## When it finishes

It prints a `docker run` command with your volume name already in it. Copy that
-- it is the thing you run for every exchange from now on. You only need the
setup script again if the password changes.

Three things to know before the first run:

- **The `.keys.json` file is not a result.** Each run writes one into your work
  folder next to the matches. It holds the keys to the exchange, so treat it
  like the input data and do not send it on with the results.
- **One exchange per folder at a time**, and the folder must start empty.
  Agree with your partner who goes when. If a run fails and leaves files
  behind, see
  [Running the exchange](troubleshooting.md#running-the-exchange).
- **Ask your partner what kind of folder this is.** If it is kept in step by a
  sync service (OneDrive, Dropbox, Egnyte, SharePoint) rather than being a live
  file server, both sides must add `--lockless-rendezvous` to the command. See
  [Synced folders](troubleshooting.md#synced-folders).

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
> the failures they report, and the share behaviour psilink depends on. The
> Windows side is verified on Windows 11 under Windows PowerShell 5.1 against
> the same kind of server, apart from one message added since that run. It has
> never been tried against a real DFS namespace, which is why the script asks
> you to confirm the server it worked out rather than trusting it. Corrections
> from a real environment are welcome and are worth more here than anywhere
> else in this repository.
