# Using a network file drop with psilink on Windows

> **Status: provisional.** The checks this script runs inside the container are
> verified against a real SMB server. The Windows half -- working out the real
> server behind a mapped drive or a DFS path -- has not yet been confirmed on a
> Windows machine. If it gets that wrong, use "Finding the real server by hand"
> below, which is the method known to work. Corrections welcome; this page is
> maintained from field reports rather than tests.

Your file-drop folder lives on a network location -- you open it in File
Explorer as a mapped drive (`Z:\Exchange`) or a network path
(`\\fileserver\exchange`). Passing that path to Docker does not work:

```
docker: Error response from daemon: invalid mount config for type "bind":
bind source path does not exist
```

This is not a typo or a permissions problem. The Docker engine runs inside a
Linux virtual machine, and that VM cannot see mapped drive letters or network
paths at all. A drive letter is a per-user mapping belonging to your Windows
sign-in session; a `\\server\share` path is not a filesystem path in the VM.
Adding the path under Docker Desktop's Settings > Resources > File sharing does
not help either -- that list is only for local drives.

The fix is to let Docker mount the network folder itself, as a named volume.

## The quick way

Download `Setup-PsilinkFileDrop.ps1` from this folder:

```
https://raw.githubusercontent.com/georgetown-mdi/jspsi/main/support/windows-network-filedrop/Setup-PsilinkFileDrop.ps1
```

It asks for the folder as you see it in Explorer and your network credentials,
works out the real server behind the path, tests everything, creates the
volume, and prints the command to run your exchange.

```
powershell -ExecutionPolicy Bypass -File .\Setup-PsilinkFileDrop.ps1
```

The `-ExecutionPolicy Bypass` is needed because Windows blocks downloaded
scripts by default. If it still refuses, run `Unblock-File
.\Setup-PsilinkFileDrop.ps1` first.

Run it once, before your first exchange. The volume it creates survives
reboots; you only need to run it again if the password changes.

## Finding the real server by hand

The script does this for you, but if it cannot, here is the manual version --
this is what worked for the one agency that got there before the script
existed.

A drive letter hides the real server, and a DFS path names a namespace rather
than a machine, so the server you actually need may be nothing like the path
you see.

1. Open the file-drop folder in File Explorer.
2. Right-click it and choose **Properties**.
3. If there is a **DFS** tab, open it. The **Referral list** shows the real
   server path, something like `\\fs-04.agency.gov\exchange$\dropbox`. Use
   that.
4. If there is no DFS tab and it is a mapped drive, run `net use` in a
   Command Prompt. The **Remote** column shows the `\\server\share` the letter
   points to.

Then create the volume by hand, splitting that path into server, share, and
the folder inside the share:

```
docker volume create --driver local ^
  --opt type=cifs ^
  --opt device=//fs-04.agency.gov/exchange$/dropbox ^
  --opt o=username=USER,password=PASS,domain=AGENCY ^
  psilink-rendezvous
```

Note the forward slashes in `device`, and that `\\fs-04\exchange$\dropbox`
becomes `//fs-04/exchange$/dropbox`.

Then run the exchange, mounting the volume where psilink expects the shared
directory and pointing a `file://` URL at it:

```
docker run --rm ^
  -v C:\path\to\your\work:/work ^
  -v psilink-rendezvous:/rendezvous ^
  vdorie/psi-link:latest ^
  file:///rendezvous input.csv matches.csv
```

`C:\path\to\your\work` must be a **local** folder on your PC holding your input
CSV; the results are written back there. `input.csv` and `matches.csv` are
named relative to it. The `file://` URL needs three slashes.

## When it does not work

### The container cannot reach the server

The script reports this at step 2, or you see a timeout rather than a
permission error.

The Docker VM reaches the network through Docker's own NAT, so as far as the
file server is concerned it is a different machine than Windows. Three things
commonly block it while File Explorer keeps working:

- **A split-tunnel VPN.** The VPN routes the Windows side only; the VM's
  traffic goes out the normal interface and never reaches the server. This is
  the most common cause by far.
- **A host firewall rule** scoped to specific processes or interfaces.
- **A server-side IP restriction** that does not cover the VM's address.

If you are on a VPN, that is almost certainly it. Use the local-folder approach
at the bottom of this page instead.

### No password exists

The share opens in Explorer without ever prompting you, and the script reports
`NT_STATUS_LOGON_FAILURE` or `NT_STATUS_NOT_SUPPORTED` for every password you
try.

Windows is signing you in silently with your domain identity over Kerberos. You
never had a password for this share as such. The Docker VM is not domain-joined
and holds no Kerberos ticket, so it must fall back to username and password --
and if your organization has disabled NTLM, which is common, no password will
work.

You have three options:

- Ask IT for a **service account** with a real password that can reach the
  share. This is the cleanest fix and usually the fastest to get.
- Use the **local-folder approach** below.
- Kerberos from the container is possible in principle but needs a keytab
  inside the VM. It is not worth the effort here.

### Credentials correct, still denied

The script reports `NT_STATUS_ACCESS_DENIED` rather than
`NT_STATUS_LOGON_FAILURE`. The difference matters: your credentials were
accepted and then authorization was refused.

- The account may lack rights when connecting from a machine that is not
  domain-joined.
- Conditional access or device-based policy may require a managed device; the
  VM is not one.
- The share ACL may grant access to your **computer** account rather than your
  user account.

Ask whoever administers the share to grant the account access from an
unmanaged client, or use a service account.

### Access to the share but not the folder

`NT_STATUS_ACCESS_DENIED` at step 5, after step 4 succeeded. Access to a share
does not imply access to every folder inside it. Ask for rights on the
file-drop folder specifically.

### It mounts but psilink cannot write

The write test fails with `NT_STATUS_ACCESS_DENIED`. The account has read but
not write access. psilink must create, rename, and delete files in this folder,
so read-only is not enough.

Mount options such as `file_mode` and `dir_mode` cannot fix this. They only
change how permissions **look** inside the container; the server still decides
what is allowed.

### A comma in the password

Docker separates mount options with commas, so a comma in the password
truncates it. The signature is distinctive: you get

```
invalid argument
```

rather than `permission denied`. If you see `permission denied`, the password
is not the problem -- look at the sections above instead.

Change the password to one without a comma, or use a service account.

### The dialect is wrong

`permission denied` at the volume step even though the script's step 3
authenticated successfully. The volume mount and the diagnostic negotiate the
SMB dialect differently. Re-run with `-Dialect SMB3`, and if that fails,
`-Dialect SMB2`.

### Status codes

| Status | Meaning |
| --- | --- |
| `NT_STATUS_LOGON_FAILURE` | Username, password, or domain genuinely wrong |
| `NT_STATUS_ACCESS_DENIED` | Credentials accepted, authorization refused |
| `NT_STATUS_ACCOUNT_LOCKED_OUT` | Locked out, probably by earlier retries |
| `NT_STATUS_PASSWORD_EXPIRED` | Password expired |
| `NT_STATUS_NOT_SUPPORTED` | Auth method refused; NTLM likely disabled |
| `NT_STATUS_BAD_NETWORK_NAME` | Share name wrong |
| `NT_STATUS_OBJECT_NAME_NOT_FOUND` | Folder inside the share does not exist |

## Synced folders

Some file drops are not live file servers at all: a sync client (OneDrive,
Dropbox, Egnyte, ShareFile) keeps a local copy on each side in step. If that
describes yours, two things change.

First, you may not need a volume at all -- point Docker at the local synced
folder, which it can bind-mount directly:

```
docker run --rm ^
  -v C:\path\to\your\work:/work ^
  -v C:\Users\you\Egnyte\exchange:/rendezvous ^
  vdorie/psi-link:latest ^
  file:///rendezvous input.csv matches.csv
```

Second, and importantly: a synced folder does not behave like a real
filesystem. Deletions take time to propagate and both sides can create the same
file at once, which breaks psilink's default rendezvous. **Both parties** must
pass `--lockless-rendezvous`. It must match on both sides -- a mismatch fails
immediately with an error naming each side's setting.

Confirm with your exchange partner which kind of folder you are sharing before
the first run.

## Local-folder fallback

If the container cannot reach the server, or no password exists, stop trying to
mount the share in Docker. Let Windows -- which already has working access --
do the file movement, and give Docker a local folder:

1. Make a local folder, say `C:\psilink\rendezvous`.
2. Keep it in step with the network file drop. A scheduled task running
   `robocopy` in both directions every minute is enough.
3. Bind-mount the local folder, exactly as in the synced-folder example above.

Because this is sync-mediated rather than a live shared filesystem, both
parties must pass `--lockless-rendezvous`, as above.

## Cleaning up

Docker stores the share password in cleartext in the volume metadata, where
`docker volume inspect psilink-rendezvous` will show it. Anyone who can run
Docker on this PC can read it. That is inherent to Docker CIFS volumes rather
than something these instructions introduce, and on a machine whose Docker you
already trust it is usually acceptable -- but prefer an account scoped to the
exchange share over a general-purpose one, and remove the volume when you are
finished:

```
docker volume rm psilink-rendezvous
```
