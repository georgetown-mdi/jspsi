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
    prepared to retire, and rotate it when you are finished. See the passwords
    page.

.LINK
    https://github.com/georgetown-mdi/jspsi/blob/main/support/windows-network-filedrop/troubleshooting.md

.LINK
    https://github.com/georgetown-mdi/jspsi/blob/main/support/windows-network-filedrop/passwords.md

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
    [string] $VolumeName = 'psilink-sync',
    [switch] $SkipVolumeTest,
    [switch] $SkipConfirm,
    # Dot-source the script with this switch to define its functions and stop
    # before the setup runs; it is how the Pester suite in
    # support/maintainer-notes drives the path-resolution functions. Not for
    # operators, and the flow runs whenever it is absent, so nothing they type
    # can skip it.
    [switch] $LoadFunctionsOnly
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
        with "invalid reference format".

        -Engine names the command to run, for the launcher, which reaches this
        through the shared volume sequence below and may have chosen podman.
        This script itself asks for docker and nothing else. #>
    param(
        [Parameter(Mandatory = $true)][string[]] $DockerArgs,
        [string] $Engine = 'docker'
    )

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & $Engine @DockerArgs 2>&1 | ForEach-Object { "$_" }
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

function Get-DialectMountVersion {
    <#  The "vers=" mount option for a -Dialect name.

        smbclient's SMB3 is 3.1.1, not 3.0, and pinning the mount to 3.0 while
        the checks ran at 3.1.1 produces exactly the "step 3 passed, step 4
        failed" confusion the flag exists to remove. #>
    param([string] $Dialect)

    $versMap = @{ 'SMB3' = '3.1.1'; 'SMB2' = '2.1'; 'NT1' = '1.0' }
    return $versMap[$Dialect]
}

# ==========================================================================
# The credentials and the volume
#
# Both are shared with Start-Psilink.ps1, which dot-sources this script and
# needs the same two sequences: one copy, run against a real file server,
# rather than two that drift apart.
# ==========================================================================

function Read-ShareCredential {
    <#  The account the CONTAINER signs in to the share with, asked of the
        operator, together with the two refusals and the warning that have to
        happen before Docker is asked to carry the password.

        -Username and -Domain are answers already in hand; an empty one is
        asked for. -DomainSupplied distinguishes "there is no domain, do not
        ask" from "not answered yet", which an empty string cannot.

        Returns a hashtable with Username, Domain and Password, or nothing when
        the password is one Docker cannot carry -- the caller stops rather than
        this ending the script, so each caller keeps its own exit code. #>
    param(
        [string] $Username = '',
        [string] $Domain = '',
        [switch] $DomainSupplied
    )

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
    Write-Info 'See the passwords page, "Where the password ends up".'
    Write-Host ''

    if (-not $Username) { $Username = Read-Host 'Username' }
    if (-not $DomainSupplied) {
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
        Write-Note 'all. Read the troubleshooting page, "The share never asks for a'
        Write-Note 'password", first.'
        return
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
        return
    }

    if ($plainPass -ne $plainPass.TrimStart()) {
        Write-Warn 'That password begins with a space.'
        Write-Note 'The credentials file the checks use drops leading spaces, so it will'
        Write-Note 'be tried without one and reported as a wrong password. If the checks'
        Write-Note 'below say LOGON_FAILURE, that is why, and it is not your mistake.'
    }

    return @{ Username = $Username; Domain = $Domain; Password = $plainPass }
}

function New-ShareVolume {
    <#  Create the Docker volume that mounts //Server/Share[/SubPath] over
        CIFS, replacing one an earlier run of this script made and refusing one
        it did not.

        -MountVersion is the "vers=" option for a pinned dialect, empty to let
        the mount negotiate. Returns $true when the volume is there to be
        mounted, and $false when the reason it is not has been printed. #>
    param(
        [Parameter(Mandatory = $true)][string] $VolumeName,
        [Parameter(Mandatory = $true)][string] $Server,
        [Parameter(Mandatory = $true)][string] $Share,
        [string] $SubPath = '',
        [Parameter(Mandatory = $true)][string] $Username,
        [string] $Password = '',
        [string] $Domain = '',
        [string] $MountVersion = '',
        [string] $Engine = 'docker'
    )

    $device = "//$Server/$Share"
    if ($SubPath) { $device = "$device/$SubPath" }

    $opts = "username=$Username,password=$Password"
    if ($Domain)       { $opts = "$opts,domain=$Domain" }
    if ($MountVersion) { $opts = "$opts,vers=$MountVersion" }

    # Existence is established from the volume list rather than from the exit
    # code of the inspection below. Anything that stops the inspection running
    # -- a template Docker will not parse, a daemon that answers oddly -- also
    # exits non-zero, and reading that as "no such volume" walks straight past
    # the guard and into the removal further down.
    $listed = Invoke-Docker -Engine $Engine -DockerArgs @('volume', 'ls', '--quiet')
    $volumeExists = ($listed.ExitCode -eq 0 -and
        (@($listed.Output -split '\r?\n' | Where-Object { $_.Trim() -eq $VolumeName }).Count -gt 0))

    if ($volumeExists) {
        # No quotes inside the template. Windows PowerShell strips them while
        # building a native command line, so "{{index .Options """type"""}}"
        # reaches Docker as {{index .Options type}} and fails to parse -- for
        # every volume, which disables the check entirely.
        $existing = Invoke-Docker -Engine $Engine -DockerArgs @('volume', 'inspect', '--format',
                                                                '{{.Driver}} {{.Options.type}}', $VolumeName)
        if ($existing.ExitCode -ne 0 -or $existing.Output.Trim() -ne 'local cifs') {
            Write-Bad "A Docker volume called '$VolumeName' already exists and was not"
            Write-Note 'made by this script -- it is not a network-share volume. It has'
            Write-Note 'been left alone; removing it could destroy data belonging to'
            Write-Note 'something else on this PC.'
            Write-Info ''
            Write-Info 'Run this script again with -VolumeName <another-name>, or remove'
            Write-Info "that volume yourself if you are certain: $Engine volume rm $VolumeName"
            return $false
        }
        # docker volume create on an existing name exits 0 and silently keeps
        # the options the volume already has, so a run after a password change
        # would quietly go on using the old one. Removing it first is what
        # makes a re-run mean anything.
        $removed = Invoke-Docker -Engine $Engine -DockerArgs @('volume', 'rm', $VolumeName)
        if ($removed.ExitCode -ne 0) {
            Write-Bad "Could not replace the existing '$VolumeName' volume."
            Write-Host ''
            Write-Host (Hide-Secret -Text $removed.Output -Secret $Password)
            Write-Host ''
            Write-Note 'A container is probably still using it. Stop any exchange that is'
            Write-Note "running, then try again: $Engine ps"
            return $false
        }
        Write-Info "Replaced the existing '$VolumeName' volume."
    }

    Write-Host "Creating volume '$VolumeName' for $device"
    $create = Invoke-Docker -Engine $Engine -DockerArgs @(
        'volume', 'create', '--driver', 'local',
        '--opt', 'type=cifs', '--opt', "device=$device", '--opt', "o=$opts",
        $VolumeName)
    if ($create.ExitCode -ne 0) {
        Write-Bad 'Could not create the volume.'
        Write-Host ''
        Write-Host (Hide-Secret -Text $create.Output -Secret $Password)
        return $false
    }
    Write-Good 'Volume created. Docker mounts it the first time it is used.'
    return $true
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
                          Reason = "this window is running as Administrator, and an elevated session cannot see the drive letters you mapped as yourself -- ${letter}: is invisible here even if File Explorer shows it. Close this window, open PowerShell normally, and run the script again. If you were told to elevate in order to resolve a DFS path, you no longer need to: see the troubleshooting page, 'Reading the real path from Windows'" }
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

# Everything above defines something; everything below runs the setup. A
# dot-source that asked for the definitions alone stops here.
if ($LoadFunctionsOnly) { return }

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
    Write-Info 'Use the Command Prompt version instead, which the same policy'
    Write-Info 'does not reach: see the troubleshooting page, "The script will'
    Write-Info 'not run". Doing it by hand has a Command Prompt form too; the'
    Write-Info 'PowerShell commands there meet this same policy.'
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

# The checks are the image's own -- `psilink doctor` -- run in the same image the
# exchange itself runs, at the same floating tag. Floating is deliberate: this
# script is downloaded on its own rather than shipped with a release, so pinning
# the diagnostic tighter than the thing it diagnoses buys nothing.
#
# Pulled here rather than left to the first docker run: an image that cannot be
# fetched exits 125, which is indistinguishable from the checks deciding
# something about the share, and would be reported as a share problem with no
# diagnosis printed above it.
$imagePresent = Invoke-Docker -DockerArgs @('image', 'inspect', 'vdorie/psi-link:latest')
if ($imagePresent.ExitCode -ne 0) {
    Write-Host 'Fetching the psilink image (first run only). It is a few hundred'
    Write-Host 'megabytes -- the same image the exchange itself runs -- so this can'
    Write-Host 'take several minutes with nothing on screen.'
    $pull = Invoke-Docker -DockerArgs @('pull', '--quiet', 'vdorie/psi-link:latest')
    if ($pull.ExitCode -ne 0) {
        Write-Bad 'Could not fetch the psilink image the checks run in.'
        Write-Host ''
        Write-Host $pull.Output
        Write-Host ''
        Write-Note 'Nothing about your file drop has been tested yet -- this is'
        Write-Note 'Docker being unable to reach its registry. A corporate proxy'
        Write-Note 'intercepting HTTPS is the usual cause; Docker Desktop needs its'
        Write-Note 'certificate under Settings > Resources > Proxies.'
        Write-Info ''
        Write-Info 'The checks run in the same image as the exchange itself, so'
        Write-Info 'nothing will run until Docker can fetch it.'
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
            Write-Host "    -v '$($resolved.LocalPath):/sync' ``"
            Write-Host "    vdorie/psi-link:latest ``"
            Write-Host "    file:///sync input.csv matches.csv"
            Write-Host ''
            Write-Warn 'If this folder is kept in step with your partner by a sync client'
            Write-Note '(OneDrive, Dropbox, Egnyte, ShareFile), both sides must also pass'
            Write-Note '--lockless-rendezvous, after the command line above:'
            Write-Info ''
            Write-Info '    file:///sync input.csv matches.csv --lockless-rendezvous'
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
        Write-Info 'See the troubleshooting page, "Reading the real path from'
        Write-Info 'Windows".'
        exit 0
    }
}

# ==========================================================================
# Part 2: credentials
# ==========================================================================
Write-Head 'Part 2: credentials for the file server'

$credential = Read-ShareCredential -Username $Username -Domain $Domain `
    -DomainSupplied:($PSBoundParameters.ContainsKey('Domain'))
if (-not $credential) { exit 1 }
$Username  = $credential.Username
$Domain    = $credential.Domain
$plainPass = $credential.Password

# ==========================================================================
# Part 3: test the share from inside a container
# ==========================================================================
Write-Head 'Part 3: testing the share from inside a container'

$token = [Guid]::NewGuid().ToString('N')

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

    Write-Host 'Running the checks against the server. They take a moment, and'
    Write-Host 'everything they found is printed together when they finish.'

    # The image's own checks. The environment set above is the whole of their
    # input -- the password is passed by NAME, so it never becomes a command-line
    # argument any process listing on this PC could read -- and their exit code
    # is the verdict: 0 nothing blocks an exchange, 78 something to change first,
    # 69 the checks could not be run at all. The image entrypoint is left alone,
    # because "doctor probe" is what it hands to psilink.
    #
    # Collected rather than streamed: the checks write their lines to standard
    # error, and re-emitting them with Write-Host is what puts them in the file
    # the troubleshooting page's logging recipe writes.
    $probe = Invoke-Docker -DockerArgs @(
        'run', '--rm',
        '--env', 'SMB_SERVER', '--env', 'SMB_SHARE', '--env', 'SMB_PATH',
        '--env', 'SMB_USER', '--env', 'SMB_DOMAIN', '--env', 'SMB_PASS',
        '--env', 'SMB_DIALECT', '--env', 'SMB_MARKER', '--env', 'SMB_TOKEN',
        'vdorie/psi-link:latest', 'doctor', 'probe')
    $probeExit = $probe.ExitCode
    Write-Host ''
    Write-Host (Hide-Secret -Text $probe.Output -Secret $plainPass)

    if ($probeExit -ge 125) {
        Write-Head 'Could not run the checks'
        Write-Bad "Docker could not start the container (exit $probeExit)."
        Write-Note 'Nothing was tested. This is Docker itself failing, not a verdict'
        Write-Note 'about your file drop -- so there is no ACTION above to follow.'
        Write-Note 'The message Docker printed is the one to read.'
        exit $probeExit
    }
    if ($probeExit -eq 64) {
        Write-Head 'Could not run the checks'
        Write-Bad 'The checks refused the values they were given. Nothing was tested.'
        if ($explicitTarget) {
            # -Server and -Share are forwarded as typed, so an operator's own
            # values reach this refusal; the resolved path never does.
            Write-Note "Check what you passed: a path separator in -Server '$Server' or"
            Write-Note "-Share '$Share' (a subfolder belongs in -SubPath instead), a"
            Write-Note "leading '-', or a stray control character is refused before"
            Write-Note 'anything is tested.'
            Write-Info ''
            Write-Info 'If those look right, this is a defect in Setup-PsilinkFileDrop.ps1;'
            Write-Info 'please report it, with the message above and the command you ran.'
        } else {
            Write-Note 'This is a defect in Setup-PsilinkFileDrop.ps1 rather than a'
            Write-Note 'problem with your share or your credentials.'
            Write-Info ''
            Write-Info 'Please report it, with the message above and the command you ran.'
        }
        exit $probeExit
    }
    if ($probeExit -eq 69) {
        Write-Head 'Could not run the checks'
        Write-Bad 'The checks could not run, so nothing was established either way.'
        Write-Note 'There is no ACTION above to follow: the check that would have'
        Write-Note 'produced one never ran.'
        exit $probeExit
    }
    if ($probeExit -eq 78) {
        Write-Head 'Not ready yet'
        Write-Bad 'The file drop is not usable from Docker. Follow the ACTION above.'
        Write-Info ''
        Write-Info 'The troubleshooting page explains every one of these in more detail:'
        Write-Info 'https://github.com/georgetown-mdi/jspsi/blob/main/support/windows-network-filedrop/troubleshooting.md'
        exit $probeExit
    }
    # Anything else is not a verdict at all: the codes above are the whole set
    # the checks produce. An image too old to carry them answers here, which is
    # the one cause worth naming -- the image is fetched only when it is
    # missing, so an old copy is never refreshed by running this again.
    if ($probeExit -ne 0) {
        Write-Head 'Could not run the checks'
        Write-Bad "The checks answered with an exit code this script does not know ($probeExit)."
        Write-Note 'Nothing has been established about your file drop. The likeliest'
        Write-Note 'cause is a copy of the psilink image that predates these checks,'
        Write-Note 'because the image is fetched only when it is missing, never to'
        Write-Note 'refresh one already on this PC.'
        Write-Info ''
        Write-Info 'Run "docker pull vdorie/psi-link:latest" and try again.'
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

    if ($Dialect -eq 'NT1') {
        Write-Warn 'The Docker VM kernel is built without SMB1, so the mount below'
        Write-Note 'will be refused however well the checks went. -Dialect NT1 is'
        Write-Note 'useful for diagnosis only. If the server speaks nothing newer,'
        Write-Note 'ask IT for a scheduled mirror to a local folder instead -- the'
        Write-Note 'troubleshooting page has the request, under "What to ask'
        Write-Note 'your IT department for".'
    }

    $volumeMade = New-ShareVolume -VolumeName $VolumeName `
        -Server $Server -Share $Share -SubPath $SubPath `
        -Username $Username -Password $plainPass -Domain $Domain `
        -MountVersion (Get-DialectMountVersion -Dialect $Dialect)
    if (-not $volumeMade) { exit 8 }

    # The kernel-side half of the checks, run over the real mount rather than
    # over smbclient, which refuses a rename onto an existing file whatever the
    # server would have allowed. A share can pass every check in part 3 and
    # still fail here. SMB_MARKER and SMB_TOKEN are still set from part 3, which
    # is what lets this confirm that the volume and those checks reached the
    # same directory.
    Write-Host 'Mounting it and running the checks over it...'
    $test = Invoke-Docker -DockerArgs @(
        'run', '--rm', '--env', 'SMB_MARKER', '--env', 'SMB_TOKEN',
        '-v', "${VolumeName}:/rz",
        'vdorie/psi-link:latest', 'doctor', 'mount', '/rz')
    $testOut = Hide-Secret -Text $test.Output -Secret $plainPass
    Write-Host ''
    Write-Host $testOut

    # "Did not mount" and "mounted, then refused the write" are different
    # answers and must not share one message: a mount that did reach the folder
    # sent round the -Dialect loop costs the operator a lap for what is a
    # permissions or quota problem on the share. Docker reserves 125 and above
    # for its own failure to start a container, which is where a refused mount
    # lands, and every verdict the checks themselves reach is below it.
    if ($test.ExitCode -ge 125) {
        Write-Bad 'The volume could not be mounted.'
        Write-Host ''
        # The message being classified is the one the Docker daemon prints, which
        # is the mount(2) errno rendered from Go's own table -- lowercase
        # throughout, where mount.cifs and glibc capitalise the same errors. The
        # arms are written as the daemon prints them so that the batch script,
        # whose findstr matches literals rather than a case-insensitive regex, can
        # carry the same set.
        if ($testOut -match 'invalid argument') {
            Write-Note 'The mount options were malformed. An equals sign or a special'
            Write-Note 'character in the password or the domain is the usual cause.'
        }
        elseif ($testOut -match 'permission denied') {
            Write-Note 'The kernel refused the mount even though the checks in part 3'
            Write-Note 'authenticated. The SMB dialect is the most likely difference:'
            Write-Note 'run again with -Dialect SMB3, and if that fails, -Dialect SMB2.'
        }
        elseif ($testOut -match 'host is down') {
            Write-Note 'The server accepted the connection and then dropped it, which'
            Write-Note 'almost always means it requires a newer SMB dialect than the'
            Write-Note 'mount asked for. Run again with -Dialect SMB3.'
        }
        elseif ($testOut -match 'operation not supported') {
            Write-Note 'The server refused an option the mount asked for -- usually SMB'
            Write-Note 'encryption or signing. Run again with -Dialect SMB3.'
        }
        elseif ($testOut -match 'required key not available') {
            Write-Note 'The mount wanted a Kerberos ticket and the Docker VM has none.'
            Write-Note 'The server is refusing password authentication. See the'
            Write-Note 'troubleshooting page, "The share never asks for a password".'
        }
        Invoke-Docker -DockerArgs @('volume', 'rm', $VolumeName) | Out-Null
        exit 9
    }
    if ($test.ExitCode -eq 69) {
        Write-Bad 'The checks could not run over the volume.'
        Write-Note 'Nothing was established about the folder either way, so there is'
        Write-Note 'no ACTION above to follow.'
        Invoke-Docker -DockerArgs @('volume', 'rm', $VolumeName) | Out-Null
        exit 9
    }
    if ($test.ExitCode -eq 64) {
        # Unlike part 3, no operator value reaches this battery: the marker,
        # token, and mount directory are all generated here.
        Write-Bad 'The checks refused the values this script gave them.'
        Write-Note 'Nothing was established about the folder. This is a defect in'
        Write-Note 'Setup-PsilinkFileDrop.ps1; please report it, with the message'
        Write-Note 'above and the command you ran.'
        Invoke-Docker -DockerArgs @('volume', 'rm', $VolumeName) | Out-Null
        exit 9
    }
    if ($test.ExitCode -eq 78) {
        Write-Bad 'The volume mounted, but the folder is not usable for an exchange.'
        Write-Note 'The share was reached, so this is not a mount or a dialect'
        Write-Note 'problem and -Dialect will not change it. Follow the ACTION above.'
        Write-Info ''
        Write-Info 'The troubleshooting page explains every one of these in more detail:'
        Write-Info 'https://github.com/georgetown-mdi/jspsi/blob/main/support/windows-network-filedrop/troubleshooting.md'
        Invoke-Docker -DockerArgs @('volume', 'rm', $VolumeName) | Out-Null
        exit 9
    }
    if ($test.ExitCode -ne 0) {
        # Part 3 returned 0 from the same image, so it carries the checks; a
        # code outside their set here points the other way from part 3's arm.
        Write-Bad "The checks answered with an exit code this script does not know ($($test.ExitCode))."
        Write-Note 'Nothing has been established about the folder either way. The'
        Write-Note 'likeliest cause is an image newer than this script -- look for a'
        Write-Note 'newer copy of this script wherever you downloaded it.'
        Invoke-Docker -DockerArgs @('volume', 'rm', $VolumeName) | Out-Null
        exit 9
    }
    Write-Good 'The volume mounts and psilink can write to it.'
}
finally {
    foreach ($v in 'SMB_SERVER', 'SMB_SHARE', 'SMB_PATH', 'SMB_USER', 'SMB_DOMAIN',
                   'SMB_PASS', 'SMB_DIALECT', 'SMB_MARKER', 'SMB_TOKEN') {
        Remove-Item "env:$v" -ErrorAction SilentlyContinue
    }
    $plainPass = $null
    $credential = $null
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
Write-Host "    -v '${VolumeName}:/sync' ``"
Write-Host "    vdorie/psi-link:latest ``"
Write-Host "    file:///sync input.csv matches.csv"
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
Write-Info '    file:///sync input.csv matches.csv --lockless-rendezvous'
Write-Info ''
Write-Info 'See the troubleshooting page, "Synced folders".'
Write-Host ''
Write-Host 'There is also a browser console:' -ForegroundColor Cyan
Write-Host ''
Write-Host "  docker run --rm -p 127.0.0.1:3000:3000 ``"
Write-Host "    --env JOB_DATA_ROOT=/data --env JOB_RENDEZVOUS_DIR=/sync ``"
Write-Host "    -v 'C:\path\to\your\work:/data' ``"
Write-Host "    -v '${VolumeName}:/sync' ``"
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
Write-Info 'passwords page, "Ending the exposure", says why.'
Write-Host ''
Write-Info 'To send this output to whoever is helping you, copy it out of this'
Write-Info 'window: right-click the title bar, then Edit > Select All, Edit >'
Write-Info 'Copy. Nothing you typed as a password is on it.'
