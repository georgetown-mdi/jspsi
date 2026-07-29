<#
.SYNOPSIS
    Makes a network file-drop folder usable by psilink running in Docker.
    Run this once before your first exchange.

.DESCRIPTION
    You have a file-drop folder that lives on a network location -- something
    you open in File Explorer as a mapped drive (Z:\Exchange) or a network path
    (\\fileserver\exchange). Docker cannot use that path directly: the Docker
    engine runs inside a Linux virtual machine that cannot see mapped drives or
    network paths at all, which is why passing one to --mount produces
    "bind source path does not exist".

    The fix is to have Docker mount the network folder itself, as a named
    volume. This script does that for you:

      1. Works out the real server behind the path you see in Explorer, and
         asks you to confirm it before going any further.
      2. Tests that the server is reachable and that your credentials work,
         reporting exactly what is wrong when they do not.
      3. Creates the Docker volume and verifies that the filesystem behaviour
         psilink depends on actually works over it.
      4. Prints the docker command to run your exchange.

    Nothing is installed on Windows; the checks run in throwaway containers.

    About the password. The diagnostic phase passes it through an inherited
    environment variable, so it never reaches a command line. Creating the
    volume is different -- Docker requires the credentials as a mount option,
    so:

      - The password appears in this process's command line while the volume
        is created. On a managed endpoint, command-line auditing (event 4688,
        Sysmon, or EDR) records that durably and may forward it off the
        machine. That is a wider boundary than "Docker on this PC".
      - It is then stored in cleartext in the volume metadata, where
        "docker volume inspect" shows it to anyone who can run Docker here.
      - "docker volume rm" removes the volume directory and its options file,
        but the metadata database keeps the record as a freed page, inside the
        Docker Desktop virtual disk that endpoint backup and imaging tooling
        copies wholesale.

    All of that is inherent to Docker CIFS volumes. The mitigation you control
    is the account: use one scoped to the exchange share, or one you are
    prepared to retire, and rotate it when you are finished. See the troubleshooting page,
    "What this does with your password".

.LINK
    https://github.com/georgetown-mdi/jspsi/blob/main/support/windows-network-filedrop/troubleshooting.md

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Setup-PsilinkFileDrop.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Setup-PsilinkFileDrop.ps1 -DropPath 'Z:\Exchange\psilink'

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Setup-PsilinkFileDrop.ps1 -Server fs-04.agency.gov -Share 'exchange$' -SubPath dropbox
#>

[CmdletBinding()]
param(
    [string] $DropPath,
    [string] $Username,
    [string] $Domain,
    [string] $Server,
    [string] $Share,
    [string] $SubPath,
    [ValidateSet('', 'SMB3', 'SMB2', 'NT1')]
    [string] $Dialect = '',
    [string] $VolumeName = 'psilink-rendezvous',
    # Pinned to alpine:3.22's multi-arch index digest so a run today and a run
    # next year test the same thing. Bumping it is deliberate; override it if
    # your site pulls through a registry mirror that does not carry the digest.
    [string] $HelperImage = 'alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce',
    [switch] $SkipVolumeTest,
    [switch] $SkipConfirm
)

$ErrorActionPreference = 'Stop'

# The name is fixed rather than unique so that a run always clears any copy an
# earlier run left behind. Two people setting up the same share at the same
# time would collide on it, which is why the content is a per-run token and the
# volume test compares it rather than merely finding the file.
$MarkerName = 'psilink-setup-check.tmp'

function Write-Head {
    param([string] $Text)
    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor DarkGray
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor DarkGray
}
function Write-Good { param([string] $T) Write-Host "  OK    $T" -ForegroundColor Green }
function Write-Bad  { param([string] $T) Write-Host "  FAIL  $T" -ForegroundColor Red }
function Write-Warn { param([string] $T) Write-Host "  WARN  $T" -ForegroundColor Yellow }
function Write-Note { param([string] $T) Write-Host "        $T" -ForegroundColor Yellow }
function Write-Info { param([string] $T) Write-Host "        $T" }

function Hide-Secret {
    <#  Removes the password from text about to be shown or pasted into a
        ticket. Docker masks "password=" only as far as the next comma, so its
        own masking cannot be relied on. #>
    param([string] $Text, [string] $Secret)
    if ([string]::IsNullOrEmpty($Text) -or [string]::IsNullOrEmpty($Secret)) { return $Text }
    return $Text.Replace($Secret, '<password removed>')
}

function Invoke-Docker {
    <#  Runs docker and returns a hashtable of its combined output and exit
        code.

        Docker is never called with a bare "2>&1" in this script, because
        Windows PowerShell 5.1 turns every stderr line of a native program
        into an ErrorRecord when its stderr is redirected -- and this script
        runs with $ErrorActionPreference = 'Stop', which makes that record
        throw. Docker writes routine, expected messages to stderr ("no such
        volume" when removing one that was never created, which is what every
        first run hits), so the redirect must happen with the preference
        relaxed or the script dies partway through with a raw .NET error
        instead of the message it meant to print.

        The arguments are passed as one explicit array rather than as loose
        trailing words: a function that collects remaining arguments is an
        advanced function, so PowerShell binds docker's own short flags to the
        common parameters first -- "-v" becomes -Verbose and never reaches
        docker, which then reads the volume spec as the image name and fails
        with "invalid reference format". #>
    param([Parameter(Mandatory = $true)][string[]] $DockerArgs)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & docker @DockerArgs 2>&1 | ForEach-Object { "$_" }
        return @{ Output = ($lines -join [Environment]::NewLine); ExitCode = $LASTEXITCODE }
    }
    finally { $ErrorActionPreference = $previous }
}

function Test-Elevated {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

# ==========================================================================
# Path resolution: Explorer-visible path -> real server, share, subdirectory
# ==========================================================================

function Resolve-MappedDrive {
    <#  Given 'Z', return the UNC root it maps to, or $null if it is not a
        mapped network drive. Three independent methods, because which ones are
        available varies with Windows version and how the drive was mapped.

        All three read the drive table of the logon session they are called
        from, so none of them sees a drive mapped by a different session --
        which is what makes an elevated window blind to the user's own
        mappings. The caller has to account for that; this function cannot. #>
    param([string] $Letter)

    try {
        $psd = Get-PSDrive -Name $Letter -ErrorAction SilentlyContinue
        if ($psd -and $psd.DisplayRoot -and $psd.DisplayRoot -like '\\*') {
            return $psd.DisplayRoot
        }
    } catch { }

    try {
        $conn = Get-CimInstance -ClassName Win32_NetworkConnection -ErrorAction SilentlyContinue |
                Where-Object { $_.LocalName -eq "${Letter}:" }
        if ($conn -and $conn.RemoteName) { return $conn.RemoteName }
    } catch { }

    try {
        $netUse = & net use "${Letter}:" 2>$null
        if ($LASTEXITCODE -eq 0) {
            foreach ($line in $netUse) {
                if ($line -match '\\\\[^\s]+') { return $Matches[0] }
            }
        }
    } catch { }

    return $null
}

function Get-DriveKind {
    <#  'Fixed', 'Removable', 'Network', 'Absent', or 'Unknown' for a drive
        letter, established positively rather than inferred from the absence
        of a mapping. #>
    param([string] $Letter)

    try {
        $info = New-Object IO.DriveInfo("${Letter}:")
        switch ($info.DriveType) {
            'Fixed'           { return 'Fixed' }
            'Removable'       { return 'Removable' }
            'Network'         { return 'Network' }
            'Ram'             { return 'Fixed' }
            'CDRom'           { return 'Removable' }
            'NoRootDirectory' { return 'Absent' }
            default           { return 'Unknown' }
        }
    } catch { }

    if (Test-Path -LiteralPath "${Letter}:\") { return 'Unknown' }
    return 'Absent'
}

function Resolve-DropPath {
    <#  Classify the path the user sees in Explorer. Returns a hashtable with
        Kind = Local | Network | Unknown, plus Server/Share/SubPath when
        Kind is Network.

        There is deliberately no attempt to work out the file server behind a
        DFS namespace. Reading the SMB connection list needs Administrator
        rights, an elevated window cannot see the mapped drives this function
        depends on, and a namespace path holds a connection to the namespace
        root as well as to the target -- so the answer the connection list
        gives is at best the name already in hand. The confirmation step below
        is what covers this instead: it shows the operator what was worked out
        and lets them correct it from the DFS tab, which is the method that
        actually works. #>
    param([string] $Raw)

    # Windows accepts either slash, and a path copied out of a browser, a
    # ticket, or a shell script often arrives with forward ones. Fold them to
    # backslashes up front so the patterns below only ever see one separator;
    # matching a share name as "anything but a backslash" otherwise swallows
    # //server/share/sub whole and reports the entire tail as the share.
    $p = $Raw.Trim().Trim('"').Replace('/', '\').TrimEnd('\')
    if (-not $p) { return @{ Kind = 'Unknown'; Reason = 'empty path' } }

    # --- the \\?\ and \\.\ device prefixes --------------------------------
    if ($p -match '^\\\\[\?\.]\\UNC\\(.*)$') { $p = "\\$($Matches[1])" }
    elseif ($p -match '^\\\\[\?\.]\\(.*)$')  { $p = $Matches[1] }

    # --- drive letter -----------------------------------------------------
    if ($p -match '^([A-Za-z]):($|\\.*$)') {
        $letter = $Matches[1]
        $rest   = $Matches[2].TrimStart('\')

        $unc  = Resolve-MappedDrive -Letter $letter
        $kind = Get-DriveKind -Letter $letter

        if (-not $unc) {
            if ($kind -eq 'Fixed' -or $kind -eq 'Removable') {
                return @{ Kind = 'Local'; LocalPath = $p }
            }

            # Either the letter is not there at all, or it is a network drive
            # this session cannot see. Both used to be reported as a local
            # folder, which sent the operator off to bind-mount a path that
            # does not exist.
            if (Test-Elevated) {
                return @{ Kind = 'Unknown'
                          Reason = "this window is running as Administrator, and an elevated session cannot see the drive letters you mapped as yourself -- ${letter}: is invisible here even if File Explorer shows it. Close this window, open PowerShell normally, and run the script again. If you were told to elevate in order to resolve a DFS path, you no longer need to: see the troubleshooting page, 'Finding the real server by hand'" }
            }
            if ($kind -eq 'Network') {
                return @{ Kind = 'Unknown'
                          Reason = "${letter}: is a network drive but Windows will not say what it maps to. Run 'net use' in this window and pass the answer with -Server and -Share" }
            }
            return @{ Kind = 'Unknown'
                      Reason = "there is no ${letter}: drive on this PC. If it is a network drive that is not connected right now, open it in File Explorer first, then run the script again" }
        }
        Write-Good "${letter}: is mapped to $unc"
        $p = if ($rest) { "$unc\$rest" } else { $unc }
    }

    # --- UNC naming a server but no share ---------------------------------
    if ($p -match '^\\\\([^\\]+)$') {
        return @{ Kind = 'Unknown'
                  Reason = "'$Raw' names the server '$($Matches[1])' but no share. Include the share as well, as in \\$($Matches[1])\exchange" }
    }

    # --- UNC --------------------------------------------------------------
    if ($p -match '^\\\\([^\\]+)\\([^\\]+)($|\\.*$)') {
        return @{ Kind    = 'Network'
                  Server  = $Matches[1]
                  Share   = $Matches[2]
                  SubPath = $Matches[3].TrimStart('\').Replace('\', '/')
                  Unc     = "\\$($Matches[1])\$($Matches[2])"
                  Full    = $p }
    }

    # --- plain local path -------------------------------------------------
    if ($p -match '^[A-Za-z]:') { return @{ Kind = 'Local'; LocalPath = $p } }

    return @{ Kind = 'Unknown'; Reason = "could not interpret '$Raw'" }
}

# ==========================================================================
# The probe that runs inside the container
# ==========================================================================
$probe = @'
#!/bin/sh
set -u
AUTH=/tmp/psilink-auth
LITTER=""
TARGET=""
LISTING=""

emit() { printf '%s\n' "$*"; }
step() { emit ""; emit "-- $1"; }
indent() { printf '%s\n' "$1" | sed 's/^/      /'; }

# The credentials file and anything this probe writes to the share are removed
# on every exit path, including a timeout or an interrupt. The share belongs to
# someone else and their partner can see it.
cleanup() {
  if [ -n "$LITTER" ] && [ -f "$AUTH" ]; then
    for leftover in $LITTER; do
      smb_at -c "del $leftover" >/dev/null 2>&1 || true
    done
  fi
  rm -f "$AUTH"
}
trap cleanup EXIT

for required in SMB_SERVER SMB_SHARE SMB_USER; do
  eval "supplied=\${$required:-}"
  [ -n "$supplied" ] && continue
  emit "FAIL: the setup script did not pass $required to the container."
  emit ""
  emit "MEANING: this is a defect in Setup-PsilinkFileDrop.ps1 rather than a"
  emit "         problem with your share or your credentials."
  emit "ACTION:  report it, with the command you ran."
  exit 10
done
: "${SMB_PATH:=}"
: "${SMB_DOMAIN:=}"
: "${SMB_PASS:=}"
: "${SMB_DIALECT:=}"
: "${SMB_MARKER:=}"
: "${SMB_TOKEN:=}"

# -m sets the MAXIMUM protocol only; the client minimum stays at SMB2_02, so
# asking for NT1 with -m alone is a contradiction the client rejects out of
# hand with INVALID_PARAMETER_MIX, against every server including one that
# speaks nothing else. The minimum has to move too. The option name takes
# spaces, not underscores.
smb_list() {
  if [ -n "$SMB_DIALECT" ]; then
    timeout 30 smbclient -L "//$SMB_SERVER" -A "$AUTH" \
      -m "$SMB_DIALECT" --option="client min protocol=$SMB_DIALECT" 2>&1
  else
    timeout 30 smbclient -L "//$SMB_SERVER" -A "$AUTH" 2>&1
  fi
}
smb() {
  if [ -n "$SMB_DIALECT" ]; then
    timeout 30 smbclient "//$SMB_SERVER/$SMB_SHARE" -A "$AUTH" \
      -m "$SMB_DIALECT" --option="client min protocol=$SMB_DIALECT" "$@" 2>&1
  else
    timeout 30 smbclient "//$SMB_SERVER/$SMB_SHARE" -A "$AUTH" "$@" 2>&1
  fi
}
# -D rather than a "cd" command: smbclient splits -c on semicolons even inside
# a quoted argument, so a folder legitimately named "q3;final" would be
# reported as missing, and a crafted one could append commands of its own.
smb_at() {
  if [ -n "$TARGET" ]; then smb -D "$TARGET" "$@"; else smb "$@"; fi
}

# NT_STATUS_OK appears in ordinary successful output and is not a failure.
status_of() {
  printf '%s' "$1" | grep -o 'NT_STATUS_[A-Z_]*' | grep -v '^NT_STATUS_OK$' | head -1
}

# An empty status means "the server supplied no verdict", never "the command
# succeeded". A transport that dies before the server answers -- a firewall that
# completes the TCP handshake and then swallows the session, a server wedged
# mid-negotiation -- returns no NT_STATUS token at all, so scraping alone reads
# it as success and every later step reports an OK it never established. The
# exit status is the only evidence that the command ran, so both are consulted:
# nonzero with no status token is a transport failure, nonzero with one is an
# ordinary server refusal that the caller's own case block classifies.
transport_failed() {
  [ "$1" -eq 0 ] && return 1
  [ -n "$(status_of "$2")" ] && return 1
  return 0
}

report_transport_failure() {
  emit "FAIL: the connection to $SMB_SERVER stopped responding."
  emit ""
  indent "$2"
  emit ""
  if [ "$1" -eq 124 ]; then
    emit "MEANING: the server accepted the connection and then sent nothing back"
    emit "         within the time allowed. Nothing about your credentials or"
    emit "         your folder has been established either way."
  else
    emit "MEANING: smbclient could not finish the request and the server gave no"
    emit "         reason for it (exit $1). Nothing about your credentials or"
    emit "         your folder has been established either way."
  fi
  emit "ACTION:  see the troubleshooting page, 'The container cannot reach"
  emit "         the server'. A firewall or VPN that allows the connection"
  emit "         and then drops the traffic behaves exactly like this."
}

report_space() {
  set -- $(printf '%s\n' "$1" | sed -n \
    's/.*blocks of size \([0-9][0-9]*\)\. *\([0-9][0-9]*\) blocks available.*/\1 \2/p' | head -1)
  [ $# -eq 2 ] || return 0
  free_mb=$(( $1 * $2 / 1048576 ))
  if [ "$free_mb" -eq 0 ]; then
    emit "WARN: the share reports no free space. A tiny test file still fits in"
    emit "      slack, so these checks can pass while a real exchange fails"
    emit "      partway through. Ask for quota before running one."
  elif [ "$free_mb" -lt 100 ]; then
    emit "NOTE: ${free_mb} MB free on this share."
  fi
}

step "1. Name resolution from inside the Docker VM"
if printf '%s' "$SMB_SERVER" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  emit "OK: $SMB_SERVER is a literal IP address."
elif getent hosts "$SMB_SERVER" >/dev/null 2>&1; then
  emit "OK: resolved to $(getent hosts "$SMB_SERVER" | awk '{print $1}' | head -1)"
else
  emit "FAIL: cannot resolve '$SMB_SERVER'."
  emit ""
  emit "The Docker VM runs its own resolver. It does not inherit Windows' DNS"
  emit "suffix search list and has no NetBIOS name resolution, so a short"
  emit "server name that works in File Explorer often fails here."
  emit ""
  emit "ACTION: on Windows, run"
  emit ""
  emit "          Resolve-DnsName $SMB_SERVER"
  emit ""
  emit "        and run this script again giving the full name or the address"
  emit "        it prints:"
  emit ""
  emit "          .\\Setup-PsilinkFileDrop.ps1 -Server <full-name-or-IP> -Share $SMB_SHARE"
  emit ""
  emit "        See the troubleshooting page, 'The container cannot find"
  emit "        the server'."
  exit 2
fi

step "2. TCP reachability on port 445"
if nc -z -w 8 "$SMB_SERVER" 445 2>/dev/null; then
  emit "OK: port 445 is open."
else
  emit "FAIL: cannot reach $SMB_SERVER:445 from inside the Docker VM."
  emit ""
  emit "The VM reaches the network through Docker's network translation, so to"
  emit "the file server it looks like a different machine than Windows does. A"
  emit "VPN that routes only the Windows side, a host firewall rule, or a"
  emit "server-side address restriction blocks the VM while File Explorer keeps"
  emit "working."
  emit ""
  emit "ACTION: if you are on a VPN, that is the likely cause. See the"
  emit "        troubleshooting page, 'The container cannot reach the server'."
  exit 3
fi

# Deliberately after the two checks above, both of which use tools already in
# the image: a machine that cannot resolve or route to the server would fail
# here first, and "could not install samba-client" is a far worse description
# of that than "cannot resolve the name".
APKOUT=$(apk add --no-cache samba-client 2>&1) || {
  emit ""
  emit "FAIL: could not install samba-client inside the container."
  emit ""
  indent "$APKOUT"
  emit ""
  emit "MEANING: the Docker VM could not fetch from the Alpine package mirror."
  emit "         The message above names the reason. 'certificate' or 'TLS'"
  emit "         means something is intercepting HTTPS -- a corporate proxy,"
  emit "         usually, and Docker Desktop needs its certificate. 'DNS' or"
  emit "         'temporary error' means name resolution inside the VM."
  emit ""
  emit "ACTION:  see the troubleshooting page, 'The container cannot install"
  emit "         its tools'."
  exit 1
}

umask 077
{
  printf 'username=%s\n' "$SMB_USER"
  printf 'password=%s\n' "$SMB_PASS"
  [ -n "$SMB_DOMAIN" ] && printf 'domain=%s\n' "$SMB_DOMAIN"
} > "$AUTH"

step "3. Authentication"
OUT=$(smb_list); RC=$?
STATUS=$(status_of "$OUT")

# Ahead of the negotiation check on purpose: a server that dies mid-negotiation
# and one that refuses the dialect both mention negotiation, and only the second
# carries an NT_STATUS token. Classifying on the token rather than on the word
# keeps a wedged server from being reported as a dialect disagreement.
if transport_failed "$RC" "$OUT"; then
  report_transport_failure "$RC" "$OUT"
  exit 3
fi

if printf '%s' "$OUT" | grep -qi 'protocol negotiation'; then
  emit "FAIL: the client and the server could not agree on an SMB dialect."
  emit ""
  indent "$OUT"
  emit ""
  emit "MEANING: this is not an authentication problem. The dialect asked for"
  emit "         is one the server will not speak."
  emit "ACTION:  run the script again without -Dialect to let them negotiate,"
  emit "         or with -Dialect SMB3 if you were told to pin one."
  exit 4
fi

case "$STATUS" in
  NT_STATUS_LOGON_FAILURE)
    emit "FAIL: $STATUS"
    emit ""
    indent "$OUT"
    emit ""
    emit "MEANING: the username, password, or domain is wrong. This is the one"
    emit "         status that really does mean bad credentials."
    emit ""
    emit "ACTION:  if this is a domain account, run the script again with"
    emit "         -Domain set. If the folder opens in File Explorer WITHOUT"
    emit "         ever asking for a password, Windows is signing you in"
    emit "         automatically with Kerberos and there may be no password that"
    emit "         works here. See the troubleshooting page, 'No password exists'."
    emit ""
    emit "         Do not work through passwords one at a time. Each run is one"
    emit "         failed sign-in against the account, and a handful of those"
    emit "         locks it out."
    exit 4 ;;
  NT_STATUS_ACCOUNT_LOCKED_OUT)
    emit "FAIL: $STATUS"
    emit ""
    emit "MEANING: the account is locked out, most likely from earlier failed"
    emit "         attempts, which may now be masking the original cause."
    emit "ACTION:  stop retrying. Wait for the lockout to expire or ask IT to"
    emit "         unlock, then run this script once."
    exit 4 ;;
  NT_STATUS_PASSWORD_EXPIRED|NT_STATUS_PASSWORD_MUST_CHANGE)
    emit "FAIL: $STATUS"
    emit ""
    emit "MEANING: the password is expired."
    emit "ACTION:  change it in Windows, then run this script again."
    exit 4 ;;
  NT_STATUS_ACCOUNT_DISABLED|NT_STATUS_ACCOUNT_EXPIRED|NT_STATUS_ACCOUNT_RESTRICTION|NT_STATUS_INVALID_LOGON_HOURS|NT_STATUS_INVALID_WORKSTATION|NT_STATUS_PASSWORD_RESTRICTION)
    emit "FAIL: $STATUS"
    emit ""
    indent "$OUT"
    emit ""
    emit "MEANING: the account itself is not permitted to sign in -- disabled,"
    emit "         expired, restricted to certain hours, or restricted to"
    emit "         certain machines. The password is not the problem and"
    emit "         neither are the rights on your folder."
    emit "ACTION:  ask whoever issued the account to lift that restriction, or"
    emit "         ask for a service account instead -- it is item 1 of the IT"
    emit "         request on the troubleshooting page. Without this, every"
    emit "         later check would report the same status and blame your"
    emit "         folder for it."
    exit 4 ;;
  NT_STATUS_NOT_SUPPORTED|NT_STATUS_LOGON_TYPE_NOT_GRANTED)
    emit "FAIL: $STATUS"
    emit ""
    indent "$OUT"
    emit ""
    emit "MEANING: the server rejected the authentication METHOD, not the"
    emit "         credentials. NTLM is probably disabled server-side, or this"
    emit "         account is not allowed to sign in over the network."
    emit "ACTION:  see the troubleshooting page, 'No password exists'."
    exit 4 ;;
esac

# Anything else is not decided here. A server that authenticates fine can still
# refuse the share list -- refusing IPC$ to ordinary accounts is common, and
# reports as ACCESS_DENIED -- and aborting on that sends the operator to ask
# for rights they already have. Step 4 opens the share the exchange will
# actually use, and that is the question worth answering.
if printf '%s' "$OUT" | grep -q 'Sharename'; then
  # A derived fact rather than the list itself. This runs against an agency file
  # server, the share names can identify programs and departments, and the
  # runbook asks the operator to send this output to whoever is helping them --
  # who is not a party to their exchange. The only thing worth reading off the
  # list is whether the share they named is on it.
  if printf '%s\n' "$OUT" | sed -n 's/^\t\([^ \t]*\).*/\1/p' | grep -qxF "$SMB_SHARE"; then
    emit "OK: authenticated, and '$SMB_SHARE' is one of the shares this account"
    emit "    can see."
  else
    emit "OK: authenticated."
    emit ""
    emit "NOTE: '$SMB_SHARE' is not among the shares this account can see. That"
    emit "      does not decide anything -- a share can be reachable without"
    emit "      being listed. Step 4 opens it, and that is the test that counts."
  fi
elif [ -n "$STATUS" ]; then
  emit "OK: the credentials were accepted."
  emit ""
  emit "NOTE: the server would not list its shares ($STATUS). That is common"
  emit "      and is not a problem by itself -- many servers refuse the list to"
  emit "      ordinary accounts. Opening your share is the test that counts."
else
  emit "OK: the credentials were accepted."
  emit ""
  emit "NOTE: no share list came back. Opening your share is the test that"
  emit "      counts."
fi

step "4. Opening share '$SMB_SHARE'"
OUT=$(smb -c 'ls'); RC=$?
STATUS=$(status_of "$OUT")
if transport_failed "$RC" "$OUT"; then
  report_transport_failure "$RC" "$OUT"
  exit 3
fi
if [ -n "$STATUS" ]; then
  case "$STATUS" in
    NT_STATUS_BAD_NETWORK_NAME|NT_STATUS_OBJECT_NAME_NOT_FOUND)
      emit "FAIL: $STATUS"
      emit ""
      indent "$OUT"
      emit ""
      emit "MEANING: there is no share called '$SMB_SHARE' on this server."
      emit "ACTION:  the share is the FIRST path component only, not the whole"
      emit "         folder path: in \\\\server\\exchange\\dropbox the share is"
      emit "         'exchange' and 'dropbox' is the subfolder. Step 3 above"
      emit "         says whether this name was one the server offered."
      exit 5 ;;
    NT_STATUS_PATH_NOT_COVERED)
      emit "FAIL: $STATUS"
      emit ""
      emit "MEANING: the server is telling us outright that this path is a DFS"
      emit "         link -- it does not hold the data itself and expects the"
      emit "         client to follow a referral to whichever server does. The"
      emit "         Docker VM cannot follow one; it has no DFS client."
      emit ""
      emit "ACTION:  find the real server by hand and pass it directly. Open"
      emit "         the folder in File Explorer, right-click, Properties, DFS"
      emit "         tab, and read the referral. Then run:"
      emit ""
      emit "           .\\Setup-PsilinkFileDrop.ps1 -Server <server> -Share <share> -SubPath <folder>"
      emit ""
      emit "         See the troubleshooting page, 'Finding the real server"
      emit "         by hand'."
      exit 5 ;;
    NT_STATUS_NOT_A_DIRECTORY)
      emit "FAIL: $STATUS"
      emit ""
      emit "MEANING: '$SMB_SHARE' names a file rather than a share or folder."
      emit "ACTION:  give the folder the exchange runs in, not a file inside it."
      exit 5 ;;
  esac

  if [ -n "$SMB_PATH" ]; then
    # The ordinary shape of an agency grant is rights to your own folder and
    # nothing above it. Listing the share root is not something psilink needs,
    # so a refusal here decides nothing; step 5 opens the folder that matters.
    emit "NOTE: the share root would not list."
    emit "      ($STATUS)"
    emit ""
    emit "      That is usual when you have been granted rights to your own"
    emit "      folder rather than to the whole share, and it does not stop"
    emit "      anything. Continuing to '$SMB_PATH'."
  else
    emit "FAIL: $STATUS"
    emit ""
    indent "$OUT"
    emit ""
    emit "MEANING: the credentials were accepted and access to the share was"
    emit "         then refused. This is not a wrong password."
    emit ""
    emit "ACTION:  the account probably lacks rights when connecting from a"
    emit "         machine that is not domain-joined, or the server requires"
    emit "         Kerberos. See the troubleshooting page, 'Credentials right,"
    emit "         access refused'."
    exit 5
  fi
else
  emit "OK: share opened."
  LISTING="$OUT"
fi

if [ -n "$SMB_PATH" ]; then
  step "5. Entering subdirectory '$SMB_PATH'"
  OUT=$(smb -D "$SMB_PATH" -c 'ls'); RC=$?
  STATUS=$(status_of "$OUT")
  if transport_failed "$RC" "$OUT"; then
    report_transport_failure "$RC" "$OUT"
    exit 3
  fi
  if [ -n "$STATUS" ]; then
    emit "FAIL: $STATUS"
    emit ""
    indent "$OUT"
    emit ""
    case "$STATUS" in
      NT_STATUS_OBJECT_NAME_NOT_FOUND|NT_STATUS_OBJECT_PATH_NOT_FOUND)
        emit "MEANING: the share is fine but this subfolder does not exist."
        emit "ACTION:  check the spelling, or create it in File Explorer first." ;;
      NT_STATUS_NOT_A_DIRECTORY)
        emit "MEANING: '$SMB_PATH' names a file, not a folder."
        emit "ACTION:  give the folder the exchange runs in, not a file in it." ;;
      NT_STATUS_PATH_NOT_COVERED)
        emit "MEANING: this subfolder is a DFS link pointing at another server,"
        emit "         and the Docker VM has no DFS client to follow it."
        emit "ACTION:  read the real path from the folder's Properties, DFS tab"
        emit "         and pass it with -Server, -Share and -SubPath. See the"
        emit "         troubleshooting page, 'Finding the real server by hand'." ;;
      *)
        emit "MEANING: the subfolder exists but this account cannot open it."
        emit "ACTION:  access to a share does not imply access to every folder"
        emit "         in it. Ask for rights on this folder specifically." ;;
    esac
    exit 6
  fi
  # A count, deliberately, and not the listing. These are the operator's own
  # filenames on their own share, and the runbook asks them to send this output
  # to whoever is helping them -- who is not a party to their exchange and has
  # no business holding the names. Nothing downstream reads them: report_space
  # parses LISTING, not what was printed here.
  entries=$(printf '%s\n' "$OUT" |
    awk '/^  [^ ]/ { if ($1 != "." && $1 != "..") n++ } END { print n+0 }')
  emit "OK: directory listed, $entries file(s) in it."
  if [ "$entries" -gt 8192 ]; then
    emit ""
    emit "WARN: psilink will not read a rendezvous folder holding more than 8192"
    emit "      entries, so an exchange here will fail however the permissions"
    emit "      come out. Use a folder dedicated to the exchange."
  fi
  TARGET="$SMB_PATH"
  LISTING="$OUT"
else
  step "5. Subdirectory"
  emit "SKIP: using the share root."
fi

[ -n "$LISTING" ] && report_space "$LISTING"

step "6. Write, rename, and delete"
emit "psilink writes each message under a temporary name and renames it into"
emit "place, so read access alone is not enough."

# Fixed names this setup can leave on the share, swept before the staged test
# rather than after it. Left in place, one of them makes the rename stage fail
# and the probe report a read-only share that is nothing of the kind -- a trap
# that sustains itself once sprung, since the failed run litters again.
STALE=$(smb_at -c "del psilink-probe-*.tmp*"); STALE_RC=$?
if [ "$STALE_RC" -eq 0 ] && [ -z "$(status_of "$STALE")" ]; then
  emit "NOTE: removed probe files left behind by an earlier run."
fi

# Named from the per-run token rather than $$, which is not a source of
# uniqueness here: the probe runs as a child of "sh -c", where it draws the same
# small pid on every run on every machine. A fixed name makes two operators
# setting up the same share collide, and the one who loses the race is told the
# share is create-only. The sweep above is by mask for the same reason -- it has
# to match what a *previous* run named, which a fixed list cannot do.
#
# The marker file is deliberately not swept. It is the one file another operator
# may be relying on right now, and deleting it turns their volume check into a
# MARKER_MISSING verdict that blames their server for a wrong folder. The volume
# check owns the marker's lifecycle.
PROBE="psilink-probe-${SMB_TOKEN:-$$}.tmp"
RENAMED="$PROBE.renamed"
printf 'psilink write probe\n' > "/tmp/$PROBE"

LITTER="$PROBE $RENAMED"
OUT=$(smb_at -c "put /tmp/$PROBE $PROBE"); RC=$?
STATUS=$(status_of "$OUT")
if transport_failed "$RC" "$OUT"; then
  report_transport_failure "$RC" "$OUT"
  exit 3
fi
if [ -n "$STATUS" ]; then
  emit "FAIL: $STATUS -- could not create a file."
  emit ""
  indent "$OUT"
  emit ""
  emit "MEANING: this account can read the folder but not write to it."
  emit ""
  emit "ACTION:  ask whoever administers the share for write permission on"
  emit "         this folder. Mount options such as file_mode cannot grant"
  emit "         it -- they only change how permissions look inside the"
  emit "         container, not what the server allows."
  exit 7
fi
emit "OK: created a file."

OUT=$(smb_at -c "rename $PROBE $RENAMED"); RC=$?
STATUS=$(status_of "$OUT")
if transport_failed "$RC" "$OUT"; then
  report_transport_failure "$RC" "$OUT"
  exit 3
fi
if [ -n "$STATUS" ]; then
  emit "FAIL: $STATUS -- created a file but could not rename it."
  emit ""
  indent "$OUT"
  emit ""
  emit "MEANING: creating files is allowed here and renaming them is not."
  emit "         psilink renames every message into place, so this stops an"
  emit "         exchange even though the folder looks writable."
  emit ""
  emit "ACTION:  ask for full change rights on this folder rather than"
  emit "         create-only. On a Windows share this is usually the DELETE"
  emit "         right being withheld, which a rename needs."
  exit 7
fi
emit "OK: renamed it."

OUT=$(smb_at -c "del $RENAMED"); RC=$?
STATUS=$(status_of "$OUT")
if transport_failed "$RC" "$OUT"; then
  report_transport_failure "$RC" "$OUT"
  exit 3
fi
if [ -n "$STATUS" ]; then
  emit "FAIL: $STATUS -- created and renamed a file but could not delete it."
  emit ""
  indent "$OUT"
  emit ""
  emit "MEANING: psilink removes each message once the other side has read it."
  emit "         Without delete rights the folder fills up and a second"
  emit "         exchange in it will not start."
  emit ""
  emit "ACTION:  ask for delete rights on this folder. If they cannot be"
  emit "         granted, the exchange can still be run with"
  emit "         --retain-files, but the folder has to be emptied by hand"
  emit "         between exchanges."
  exit 7
fi
LITTER=""
emit "OK: deleted it."

# Left in place on purpose: the volume mounts //server/share/subpath while
# these checks tested //server/share with a subpath, and nothing so far proves
# those are the same directory. The volume test looks for this file, and its
# absence means the two halves are pointing at different places -- which is the
# one way a wrong server or share gets caught before an exchange does it.
if [ -n "$SMB_MARKER" ]; then
  printf '%s\n' "$SMB_TOKEN" > "/tmp/$SMB_MARKER"
  OUT=$(smb_at -c "put /tmp/$SMB_MARKER $SMB_MARKER")
  if [ -n "$(status_of "$OUT")" ]; then
    emit "NOTE: could not leave the marker file for the volume check."
  fi
fi

emit ""
emit "ALL CHECKS PASSED"
'@

# ==========================================================================
# Preflight
# ==========================================================================
Write-Head 'psilink file-drop setup'

if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    Write-Bad "PowerShell is running in $($ExecutionContext.SessionState.LanguageMode) mode."
    Write-Note 'An application-control policy on this PC (WDAC or AppLocker) has'
    Write-Note 'restricted what scripts may do, and this one needs operations that'
    Write-Note 'are blocked. It cannot run here, and there is nothing you can'
    Write-Note 'change locally to allow it.'
    Write-Info ''
    Write-Info 'Set the volume up by hand instead: see the troubleshooting'
    Write-Info 'page, "Doing it by hand". You will need the real server name,'
    Write-Info 'which the same section explains how to read from the folder'
    Write-Info 'Properties.'
    exit 1
}

Write-Host 'Checking Docker...'
$dockerInfo = Invoke-Docker -DockerArgs @('version', '--format', '{{.Server.Os}} {{.Server.Version}}')
if ($dockerInfo.ExitCode -ne 0) {
    Write-Bad 'Docker is not running, or is not installed, or you cannot use it.'
    Write-Note 'Start Docker Desktop and wait for the whale icon to stop animating.'
    Write-Note 'If it is already running, the message below usually says which of'
    Write-Note 'the three it is -- "access is denied" means your account is not in'
    Write-Note 'the local docker-users group, which an administrator has to add'
    Write-Note 'you to before Docker will talk to you.'
    Write-Host ''
    Write-Host $dockerInfo.Output
    exit 1
}
$dockerOs = ($dockerInfo.Output -split '\s+')[0]
if ($dockerOs -eq 'windows') {
    Write-Bad 'Docker Desktop is in Windows containers mode.'
    Write-Note 'psilink and these checks are Linux containers. In this mode the'
    Write-Note 'engine answers normally and then every container fails to start.'
    Write-Info ''
    Write-Info 'Right-click the Docker whale icon in the notification area and'
    Write-Info 'choose "Switch to Linux containers...", then run this again.'
    exit 1
}
Write-Good "Docker engine $(($dockerInfo.Output -split '\s+')[1]) is running."

# Pulled here rather than left to the first docker run: an image that cannot be
# fetched exits 125, which is indistinguishable from the probe deciding
# something about the share, and would be reported as a share problem with no
# diagnosis printed above it.
$imagePresent = Invoke-Docker -DockerArgs @('image', 'inspect', $HelperImage)
if ($imagePresent.ExitCode -ne 0) {
    Write-Host 'Fetching the helper image (first run only)...'
    $pull = Invoke-Docker -DockerArgs @('pull', '--quiet', $HelperImage)
    if ($pull.ExitCode -ne 0) {
        Write-Bad 'Could not fetch the helper image the checks run in.'
        Write-Host ''
        Write-Host $pull.Output
        Write-Host ''
        Write-Note 'Nothing about your file drop has been tested yet -- this is'
        Write-Note 'Docker being unable to reach its registry. A corporate proxy'
        Write-Note 'intercepting HTTPS is the usual cause; Docker Desktop needs its'
        Write-Note 'certificate under Settings > Resources > Proxies.'
        Write-Info ''
        Write-Info 'If your site runs a registry mirror, pass its copy with'
        Write-Info '-HelperImage <image>.'
        exit 1
    }
}

# ==========================================================================
# Part 1: work out where the file drop really lives
# ==========================================================================
Write-Head 'Part 1: locating the file drop'

$explicitTarget = [bool]($Server -and $Share)

if (-not $explicitTarget) {
    if (-not $DropPath) {
        Write-Host 'Enter the file-drop folder exactly as you see it in File Explorer.'
        Write-Host 'Examples:  Z:\Exchange\psilink'
        Write-Host '           \\fileserver.agency.gov\exchange\psilink'
        Write-Host ''
        $DropPath = Read-Host 'File-drop folder'
    }

    $resolved = Resolve-DropPath -Raw $DropPath

    switch ($resolved.Kind) {
        'Local' {
            Write-Head 'This folder is already local'
            Write-Good "$($resolved.LocalPath) is on this PC, not a network server."
            if (-not (Test-Path -LiteralPath $resolved.LocalPath)) {
                Write-Warn 'It does not exist yet -- create it before running the exchange,'
                Write-Note 'or Docker will report "bind source path does not exist".'
            }
            Write-Host ''
            Write-Host 'That means you do not need a Docker volume at all -- you can mount'
            Write-Host 'the folder directly. Run your exchange like this:'
            Write-Host ''
            Write-Host "  docker run --rm ``"
            Write-Host "    -v 'C:\path\to\your\work:/work' ``"
            Write-Host "    -v '$($resolved.LocalPath):/rendezvous' ``"
            Write-Host "    vdorie/psi-link:latest ``"
            Write-Host "    file:///rendezvous input.csv matches.csv"
            Write-Host ''
            Write-Warn 'If this folder is kept in step with your partner by a sync client'
            Write-Note '(OneDrive, Dropbox, Egnyte, ShareFile), both sides must also pass'
            Write-Note '--lockless-rendezvous, after the command line above:'
            Write-Info ''
            Write-Info '    file:///rendezvous input.csv matches.csv --lockless-rendezvous'
            Write-Info ''
            Write-Info 'See the troubleshooting page, "Synced folders".'
            exit 0
        }
        'Unknown' {
            Write-Bad "Could not use that path."
            Write-Host ''
            Write-Note "$($resolved.Reason)."
            Write-Info ''
            Write-Info 'Enter it as a drive letter path (Z:\Exchange) or a network path'
            Write-Info '(\\server\share\folder). Copy it from the Explorer address bar.'
            exit 1
        }
    }

    $Server = $resolved.Server
    $Share  = $resolved.Share
    if (-not $PSBoundParameters.ContainsKey('SubPath')) { $SubPath = $resolved.SubPath }

    # Worth knowing before the container is blamed for not reaching a path
    # Windows itself cannot reach. -LiteralPath and not Get-ChildItem: this is
    # one round trip rather than an enumeration of a drop folder that may hold
    # thousands of files.
    if ($resolved.Full) {
        Write-Host 'Checking that Windows itself can reach it...'
        if (-not (Test-Path -LiteralPath $resolved.Full)) {
            Write-Warn "Windows cannot open $($resolved.Full) either."
            Write-Note 'The checks below will probably fail. Confirm the path opens in'
            Write-Note 'File Explorer before reading too much into what they say.'
        }
    }
}

# -SubPath may arrive from the command line with backslashes; everything
# downstream of here -- the SMB path and the Docker device string -- wants
# forward slashes.
if ($SubPath) { $SubPath = $SubPath.Trim().Replace('\', '/').Trim('/') }

Write-Host ''
Write-Good "Server:       $Server"
Write-Good "Share:        $Share"
Write-Good "Subdirectory: $(if ($SubPath) { $SubPath } else { '(share root)' })"

if (-not $explicitTarget -and -not $SkipConfirm) {
    Write-Host ''
    Write-Host 'Everything below depends on those three being right, and one case'
    Write-Host 'where they will not be is a DFS path: it names a namespace rather'
    Write-Host 'than a machine, and the real server, share and folder can all be'
    Write-Host 'different. Windows will tell you -- open the folder in Explorer,'
    Write-Host 'right-click, Properties, and read the DFS tab if there is one.'
    Write-Host ''
    $answer = Read-Host 'Are those correct? [Y/n]'
    if ($answer -and $answer -notmatch '^\s*(y|yes)\s*$') {
        Write-Host ''
        Write-Note 'Run the script again with the real values:'
        Write-Info ''
        Write-Info '    .\Setup-PsilinkFileDrop.ps1 -Server fs-04.agency.gov -Share ''exchange$'' -SubPath dropbox'
        Write-Info ''
        Write-Info 'See the troubleshooting page, "Finding the real server by hand".'
        exit 0
    }
}

# ==========================================================================
# Part 2: credentials
# ==========================================================================
Write-Head 'Part 2: credentials for the file server'

Write-Host 'These are the credentials the CONTAINER will use to reach the share.'
Write-Host 'Windows signs you in to it as yourself; Docker cannot borrow that, so'
Write-Host 'it needs a username and password of its own.'
Write-Host ''
Write-Warn 'Prefer an account scoped to this share, or one you are prepared to'
Write-Note 'retire. Docker stores this password in cleartext in the volume'
Write-Note 'metadata and puts it on a command line while creating the volume.'
Write-Note 'Do not use a domain administrator account, and do not use one whose'
Write-Note 'password protects anything else you care about.'
Write-Info ''
Write-Info 'See the troubleshooting page, "What this does with your password".'
Write-Host ''

if (-not $Username) { $Username = Read-Host 'Username' }
if (-not $PSBoundParameters.ContainsKey('Domain')) {
    $Domain = Read-Host 'Domain (press Enter if you do not have one)'
}
if ($Username -match '^(.+?)\\(.+)$') {
    if (-not $Domain) { $Domain = $Matches[1] }
    $Username = $Matches[2]
    Write-Note "Using domain '$Domain' and username '$Username'."
}

$securePass = Read-Host 'Password' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePass)
# PtrToStringBSTR and not PtrToStringAuto: the buffer is UTF-16 and BSTR is the
# only one of the two that says so. Auto happens to pick the right reader on
# Windows and picks UTF-8 elsewhere, where it truncates the password at the
# first character without complaining.
try   { $plainPass = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

if ([string]::IsNullOrEmpty($plainPass)) {
    Write-Bad 'No password entered.'
    Write-Note 'If you never type a password when opening this folder in Explorer,'
    Write-Note 'Windows signs you in automatically and this approach may not work at'
    Write-Note 'all. Read the troubleshooting page section "No password exists" first.'
    exit 1
}

# Docker separates mount options with commas, so a comma in the password ends
# the option and the rest becomes a malformed option of its own. There is no
# escaping available: the local driver takes the credentials only as one
# comma-separated string. Said now rather than after the volume fails, because
# the failure text carries the tail of the password in the clear.
if ($plainPass.Contains(',')) {
    Write-Bad 'That password contains a comma, and Docker cannot carry it.'
    Write-Note 'Mount options are separated by commas, so the password is cut off at'
    Write-Note 'the first one and the mount fails with "invalid argument". There is'
    Write-Note 'no way to quote or escape it -- this is a limit of Docker volumes,'
    Write-Note 'not of psilink, and doing it by hand hits exactly the same wall.'
    Write-Info ''
    Write-Info 'Use an account whose password has no comma. The troubleshooting'
    Write-Info 'page has a ready-made request for one, under "What to ask your'
    Write-Info 'IT department for".'
    exit 1
}

if ($plainPass -ne $plainPass.TrimStart()) {
    Write-Warn 'That password begins with a space.'
    Write-Note 'The credentials file the checks use drops leading spaces, so it will'
    Write-Note 'be tried without one and reported as a wrong password. If step 3'
    Write-Note 'below says LOGON_FAILURE, that is why, and it is not your mistake.'
}

# ==========================================================================
# Part 3: test the share from inside a container
# ==========================================================================
Write-Head 'Part 3: testing the share from inside a container'

$token = [Guid]::NewGuid().ToString('N')

$probeB64 = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes(($probe -replace "`r`n", "`n")))

try {
    $env:SMB_SERVER  = $Server
    $env:SMB_SHARE   = $Share
    $env:SMB_PATH    = $SubPath
    $env:SMB_USER    = $Username
    $env:SMB_DOMAIN  = $Domain
    $env:SMB_DIALECT = $Dialect
    $env:SMB_MARKER  = if ($SkipVolumeTest) { '' } else { $MarkerName }
    $env:SMB_TOKEN   = $token
    $env:SMB_PASS    = $plainPass

    # Not routed through Invoke-Docker: the probe's output is the thing the
    # operator reads, so it streams to the console rather than being collected.
    # Without a redirect there is no ErrorRecord wrapping to work around.
    & docker run --rm `
        --env SMB_SERVER --env SMB_SHARE --env SMB_PATH `
        --env SMB_USER --env SMB_DOMAIN --env SMB_PASS --env SMB_DIALECT `
        --env SMB_MARKER --env SMB_TOKEN `
        $HelperImage sh -c "echo $probeB64 | base64 -d | sh"
    $probeExit = $LASTEXITCODE

    foreach ($v in 'SMB_SERVER','SMB_SHARE','SMB_PATH','SMB_USER','SMB_DOMAIN',
                   'SMB_DIALECT','SMB_MARKER','SMB_TOKEN') {
        Remove-Item "env:$v" -ErrorAction SilentlyContinue
    }

    if ($probeExit -ge 125) {
        Write-Head 'Could not run the checks'
        Write-Bad "Docker could not start the container (exit $probeExit)."
        Write-Note 'Nothing was tested. This is Docker itself failing, not a verdict'
        Write-Note 'about your file drop -- so there is no ACTION above to follow.'
        Write-Note 'The message Docker printed is the one to read.'
        exit $probeExit
    }
    if ($probeExit -ne 0) {
        Write-Head 'Not ready yet'
        Write-Bad 'The file drop is not usable from Docker. Follow the ACTION above.'
        Write-Info ''
        Write-Info 'The troubleshooting page explains every one of these in more detail:'
        Write-Info 'https://github.com/georgetown-mdi/jspsi/blob/main/support/windows-network-filedrop/troubleshooting.md'
        exit $probeExit
    }
    Write-Good 'The share is reachable, writable, and supports rename.'

    if ($SkipVolumeTest) {
        Write-Note 'Skipping volume creation as requested.'
        exit 0
    }

    # ======================================================================
    # Part 4: create and test the Docker volume
    # ======================================================================
    Write-Head 'Part 4: creating the Docker volume'

    $device = "//$Server/$Share"
    if ($SubPath) { $device = "$device/$SubPath" }

    $opts = "username=$Username,password=$plainPass"
    if ($Domain)  { $opts = "$opts,domain=$Domain" }
    if ($Dialect) {
        # smbclient's SMB3 is 3.1.1, not 3.0, and pinning the mount to 3.0
        # while the checks ran at 3.1.1 produces exactly the "step 3 passed,
        # step 4 failed" confusion the flag exists to remove.
        $versMap = @{ 'SMB3' = '3.1.1'; 'SMB2' = '2.1'; 'NT1' = '1.0' }
        $opts = "$opts,vers=$($versMap[$Dialect])"
        if ($Dialect -eq 'NT1') {
            Write-Warn 'The Docker VM kernel is built without SMB1, so the mount below'
            Write-Note 'will be refused however well the checks went. -Dialect NT1 is'
            Write-Note 'useful for diagnosis only. If the server speaks nothing newer,'
            Write-Note 'ask IT for a scheduled mirror to a local folder instead -- the'
            Write-Note 'troubleshooting page has the request, under "What to ask'
            Write-Note 'your IT department for".'
        }
    }

    # Existence is established from the volume list rather than from the exit
    # code of the inspection below. Anything that stops the inspection running
    # -- a template Docker will not parse, a daemon that answers oddly -- also
    # exits non-zero, and reading that as "no such volume" walks straight past
    # the guard and into the removal further down.
    $listed = Invoke-Docker -DockerArgs @('volume', 'ls', '--quiet')
    $volumeExists = ($listed.ExitCode -eq 0 -and
        (@($listed.Output -split '\r?\n' | Where-Object { $_.Trim() -eq $VolumeName }).Count -gt 0))

    if ($volumeExists) {
        # No quotes inside the template. Windows PowerShell strips them while
        # building a native command line, so "{{index .Options """type"""}}"
        # reaches Docker as {{index .Options type}} and fails to parse -- for
        # every volume, which disables the check entirely.
        $existing = Invoke-Docker -DockerArgs @('volume', 'inspect', '--format',
                                                '{{.Driver}} {{.Options.type}}', $VolumeName)
        if ($existing.ExitCode -ne 0 -or $existing.Output.Trim() -ne 'local cifs') {
            Write-Bad "A Docker volume called '$VolumeName' already exists and was not"
            Write-Note 'made by this script -- it is not a network-share volume. It has'
            Write-Note 'been left alone; removing it could destroy data belonging to'
            Write-Note 'something else on this PC.'
            Write-Info ''
            Write-Info 'Run this script again with -VolumeName <another-name>, or remove'
            Write-Info "that volume yourself if you are certain: docker volume rm $VolumeName"
            exit 8
        }
        # docker volume create on an existing name exits 0 and silently keeps
        # the options the volume already has, so a run after a password change
        # would quietly go on using the old one. Removing it first is what
        # makes a re-run mean anything.
        $removed = Invoke-Docker -DockerArgs @('volume', 'rm', $VolumeName)
        if ($removed.ExitCode -ne 0) {
            Write-Bad "Could not replace the existing '$VolumeName' volume."
            Write-Host ''
            Write-Host (Hide-Secret -Text $removed.Output -Secret $plainPass)
            Write-Host ''
            Write-Note 'A container is probably still using it. Stop any exchange that is'
            Write-Note "running, then try again: docker ps"
            exit 8
        }
        Write-Info "Replaced the existing '$VolumeName' volume."
    }

    Write-Host "Creating volume '$VolumeName' for $device"
    $create = Invoke-Docker -DockerArgs @(
        'volume', 'create', '--driver', 'local',
        '--opt', 'type=cifs', '--opt', "device=$device", '--opt', "o=$opts",
        $VolumeName)
    if ($create.ExitCode -ne 0) {
        Write-Bad 'Could not create the volume.'
        Write-Host ''
        Write-Host (Hide-Secret -Text $create.Output -Secret $plainPass)
        exit 8
    }
    Write-Good 'Volume created. Docker mounts it the first time it is used.'

    # These are the operations psilink's default rendezvous is built on, run
    # over the real mount rather than over smbclient, which refuses a rename
    # onto an existing file whatever the server would have allowed. A share can
    # pass every check above and still fail here.
    #
    # The exclusive-create test is mkdir and not "set -C" on a file, though the
    # file is what psilink itself uses. busybox ash implements set -C by calling
    # stat and refusing in the shell, so the second attempt never issues a
    # syscall and the share is never asked -- which made EXCL_WEAK unreachable
    # and the whole check a no-op on exactly the sync-backed shares it exists to
    # catch. mkdir takes EEXIST from the server. Both map to an SMB create with
    # FILE_CREATE disposition, so this is a proxy for O_EXCL rather than the
    # same call, and a share that arbitrates the two differently would slip
    # through.
    $volumeCheck = @"
cd /rz || { echo NOMOUNT; exit 1; }
if [ -f '$MarkerName' ]; then
  if grep -q '$token' '$MarkerName' 2>/dev/null; then
    echo MARKER_OK
    rm -f '$MarkerName'
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
"@
    Write-Host 'Mounting it and testing what psilink needs...'
    # Line endings are stripped for the same reason the probe strips them: a
    # checkout with core.autocrlf on gives this here-string CRLF, and sh does
    # not treat a carriage return as whitespace, so "fi" arrives as "fi\r" and
    # the interpreter reports an unterminated if. Nothing holds this file to LF
    # -- .gitattributes carries no rule for *.ps1 -- so any clone on Windows
    # produces it. Measured on Windows, where the check never ran at all, and
    # reproduced in alpine, where it surfaced as "the volume could not be
    # mounted" on a share that was fine and took the volume with it.
    $test = Invoke-Docker -DockerArgs @(
        'run', '--rm', '-v', "${VolumeName}:/rz", $HelperImage, 'sh', '-c',
        ($volumeCheck -replace "`r`n", "`n"))
    $testOut = Hide-Secret -Text $test.Output -Secret $plainPass

    # "Did not mount" and "mounted, then refused the write" are different
    # answers and used to share one message. A volume that reports MARKER_OK has
    # demonstrably reached the right directory, so calling that a mount failure
    # sent the operator round the -Dialect loop for what is a permissions or
    # quota problem on the share.
    if ($testOut -notmatch 'WRITE_OK') {
        if ($testOut -match 'MARKER_OK|MARKER_MISMATCH|MARKER_MISSING') {
            Write-Bad 'The volume mounted, but psilink cannot write in that folder.'
            Write-Host ''
            Write-Host $testOut
            Write-Host ''
            Write-Note 'The share was reached, so this is not a mount or a dialect'
            Write-Note 'problem and -Dialect will not change it. Either the account'
            Write-Note 'can open the folder but not create files in it, or the share'
            Write-Note 'is out of space.'
            Write-Info ''
            Write-Info 'See the troubleshooting page, "The folder cannot be written to".'
            Invoke-Docker -DockerArgs @('volume', 'rm', $VolumeName) | Out-Null
            exit 9
        }
        Write-Bad 'The volume could not be mounted.'
        Write-Host ''
        Write-Host $testOut
        Write-Host ''
        if ($testOut -match 'invalid argument') {
            Write-Note 'The mount options were malformed. An equals sign or a special'
            Write-Note 'character in the password or the domain is the usual cause.'
        }
        elseif ($testOut -match 'permission denied') {
            Write-Note 'The kernel refused the mount even though the checks in part 3'
            Write-Note 'authenticated. The SMB dialect is the most likely difference:'
            Write-Note 'run again with -Dialect SMB3, and if that fails, -Dialect SMB2.'
        }
        elseif ($testOut -match 'mount error\(112\)|Host is down') {
            Write-Note 'The server accepted the connection and then dropped it, which'
            Write-Note 'almost always means it requires a newer SMB dialect than the'
            Write-Note 'mount asked for. Run again with -Dialect SMB3.'
        }
        elseif ($testOut -match 'Operation not supported') {
            Write-Note 'The server refused an option the mount asked for -- usually SMB'
            Write-Note 'encryption or signing. Run again with -Dialect SMB3.'
        }
        elseif ($testOut -match 'Required key not available') {
            Write-Note 'The mount wanted a Kerberos ticket and the Docker VM has none.'
            Write-Note 'The server is refusing password authentication. See the'
            Write-Note 'troubleshooting page, "No password exists".'
        }
        Invoke-Docker -DockerArgs @('volume', 'rm', $VolumeName) | Out-Null
        exit 9
    }
    Write-Good 'The volume mounts and psilink can write to it.'

    if ($testOut -match 'MARKER_MISSING') {
        Write-Bad 'The volume is not mounting the folder that was just tested.'
        Write-Note 'A file left in the folder by part 3 is not visible through the'
        Write-Note 'volume, so the two are pointing at different directories. The'
        Write-Note 'server, share, or subfolder is wrong somewhere -- a DFS path is'
        Write-Note 'the usual reason, because the namespace and the real location can'
        Write-Note 'differ in all three.'
        Write-Info ''
        Write-Info 'Read the real path from the folder Properties, DFS tab, and run'
        Write-Info 'again with -Server, -Share and -SubPath. See the troubleshooting page,'
        Write-Info '"Finding the real server by hand".'
        Invoke-Docker -DockerArgs @('volume', 'rm', $VolumeName) | Out-Null
        exit 9
    }
    if ($testOut -match 'MARKER_MISMATCH') {
        Write-Warn 'Someone else appears to be setting up this same share right now.'
        Write-Note 'The check file in the folder is not the one part 3 wrote. The'
        Write-Note 'volume is fine; if you were not expecting company, confirm the'
        Write-Note 'folder is yours to use before running an exchange.'
    }
    else {
        Write-Good 'The volume and the checks agree on which folder this is.'
    }

    if ($testOut -match 'RENAME_FAIL') {
        Write-Warn 'This share will not rename a file onto an existing one.'
        Write-Note 'psilink does that when two sides meet at once. Pass'
        Write-Note '--lockless-rendezvous on BOTH sides of the exchange.'
    }
    if ($testOut -match 'EXCL_WEAK') {
        Write-Warn 'This share does not refuse to create a file that already exists.'
        Write-Note 'psilink uses that refusal to decide which side goes first, so'
        Write-Note 'without it both sides can believe they did. Pass'
        Write-Note '--lockless-rendezvous on BOTH sides of the exchange.'
    }
    elseif ($testOut -match 'EXCL_UNTESTED') {
        Write-Note 'Could not test exclusive create on this share. If the exchange'
        Write-Note 'hangs at the start, try --lockless-rendezvous on both sides.'
    }
    if ($testOut -notmatch 'RENAME_FAIL' -and $testOut -match 'EXCL_OK') {
        Write-Good 'Exclusive create and rename behave the way psilink needs.'
    }
}
finally {
    Remove-Item env:SMB_PASS -ErrorAction SilentlyContinue
    $plainPass = $null
}

# ==========================================================================
# Done
# ==========================================================================
Write-Head 'Ready to run an exchange'
Write-Host "The volume '$VolumeName' is set up and survives reboots. You do not"
Write-Host 'need to run this script again unless the password changes.'
Write-Host ''
Write-Host 'Run your exchange like this:' -ForegroundColor Cyan
Write-Host ''
Write-Host "  docker run --rm ``"
Write-Host "    -v 'C:\path\to\your\work:/work' ``"
Write-Host "    -v '${VolumeName}:/rendezvous' ``"
Write-Host "    vdorie/psi-link:latest ``"
Write-Host "    file:///rendezvous input.csv matches.csv"
Write-Host ''
Write-Info 'C:\path\to\your\work is a LOCAL folder on this PC holding your input'
Write-Info 'CSV; results are written back there. It must not be a network path.'
Write-Info 'input.csv and matches.csv are named relative to that folder. Keep the'
Write-Info 'quotes -- a work folder under OneDrive has a space in its path.'
Write-Host ''
Write-Warn 'The exchange also writes a psilink-record-....keys.json file into that'
Write-Note 'folder. It is not a result: it holds the keys to the exchange and'
Write-Note 'should be treated like the input data, not sent on with the matches.'
Write-Host ''
Write-Warn 'One exchange per folder. Running a second one against this file drop'
Write-Note 'before the first has finished and been cleared will fail on both'
Write-Note 'sides. Agree with your partner who goes when.'
Write-Host ''
Write-Warn 'Check with your exchange partner: if this folder is kept in step by a'
Write-Note 'sync service rather than being a live file server, both sides must'
Write-Note 'pass --lockless-rendezvous, at the end of the command line:'
Write-Info ''
Write-Info '    file:///rendezvous input.csv matches.csv --lockless-rendezvous'
Write-Info ''
Write-Info 'See the troubleshooting page, "Synced folders".'
Write-Host ''
Write-Host 'There is also a browser console:' -ForegroundColor Cyan
Write-Host ''
Write-Host "  docker run --rm -p 127.0.0.1:3000:3000 ``"
Write-Host "    --env JOB_DATA_ROOT=/data --env JOB_RENDEZVOUS_DIR=/rendezvous ``"
Write-Host "    -v 'C:\path\to\your\work:/data' ``"
Write-Host "    -v '${VolumeName}:/rendezvous' ``"
Write-Host "    vdorie/psi-link:latest serve"
Write-Host ''
Write-Info 'then open http://127.0.0.1:3000'
Write-Info ''
Write-Info 'The console cannot set --lockless-rendezvous. If you were told above'
Write-Info 'that you need it, or this is a synced folder, use the command-line'
Write-Info 'form instead.'
Write-Host ''
Write-Warn "Docker stored the share password in cleartext in this volume's"
Write-Note "metadata: 'docker volume inspect $VolumeName' shows it to anyone who"
Write-Note 'can run Docker on this PC. When you are finished:'
Write-Info ''
Write-Info "    docker volume rm $VolumeName"
Write-Info ''
Write-Info 'That removes the volume but not every trace of the password, so'
Write-Info 'retire or rotate the account when the exchanges are done. The'
Write-Info 'troubleshooting page, "What this does with your password", says why.'
Write-Host ''
Write-Info 'To send this output to whoever is helping you, run the script again'
Write-Info 'with:  ... 6>&1 | Tee-Object setup-log.txt'
