<#
.SYNOPSIS
    Pester suite over the path-resolution functions in
    Setup-PsilinkFileDrop.ps1. Maintainer-facing: it lives outside the guide
    folder, and an operator following the setup page never receives it.

.DESCRIPTION
    The script under test is dot-sourced with -LoadFunctionsOnly, which defines
    its functions and stops before the setup flow. Two tests hold that switch to
    its contract from both sides -- a dot-source prints nothing, and an ordinary
    run still reaches the banner -- because a guard that silently swallowed the
    flow would leave every operator with a script that does nothing.

    Two halves:

      - Pure: UNC and device-prefix parsing, drive-kind classification, the
        dialect map, and password masking. These need no rig and no rights.
      - Rig-backed: a share the runner serves itself over loopback, a drive
        letter mapped to it, and a standalone DFS namespace with a link into
        that share. Built the way support/maintainer-notes/ci-resolution-rig.ps1
        measured to work on a windows-latest runner. Each half of the rig is
        built inside its own try/catch and reported through
        $global:PsilinkRigPremises, which ci-resolution-tests.ps1 turns into
        ::notice annotations -- so a runner that cannot build the rig is
        distinguishable from a script that resolves a path wrongly.

    Run it through ci-resolution-tests.ps1 rather than Invoke-Pester directly:
    that script is what reports results as annotations, which is all the CI
    reader can see.
#>

BeforeAll {
    # -LoadFunctionsOnly is what keeps the prompts, the Docker calls and the
    # volume creation out of this session.
    $setupScript = (Resolve-Path (Join-Path $PSScriptRoot '..\windows-network-filedrop\Setup-PsilinkFileDrop.ps1')).Path
    . $setupScript -LoadFunctionsOnly

    # The dot-source above also sets $ErrorActionPreference to 'Stop', which is
    # how the functions run for an operator and so is left in place. It is also
    # why the helpers below relax it around native commands: under 'Stop',
    # Windows PowerShell turns a native program's stderr into a terminating
    # ErrorRecord, and the rig would abort where it means to report.
    function Invoke-Net {
        param([string[]] $Arguments)

        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $output = & net @Arguments 2>&1
            $exit = $LASTEXITCODE
            $text = ($output | ForEach-Object { [string] $_ }) -join ' '
            return [ordered]@{ Exit = $exit; Output = $text }
        } finally {
            $ErrorActionPreference = $previous
        }
    }

    function Find-FreeDriveLetter {
        param([string[]] $Exclude = @())

        foreach ($letter in @('Y', 'X', 'W', 'V', 'U', 'T', 'S', 'R')) {
            if ($Exclude -contains $letter) { continue }
            if (Test-Path -LiteralPath "${letter}:\" -ErrorAction SilentlyContinue) { continue }
            if (Get-PSDrive -Name $letter -ErrorAction SilentlyContinue) { continue }
            return $letter
        }
        return $null
    }

    function Start-PowerShellChild {
        <#  Run powershell.exe and return its exit code and both streams.

            $PSHOME rather than the bare name, because one caller strips the
            PATH; a temporary file rather than the console for standard input,
            so that a guard which failed and let the flow reach a prompt ends
            the run rather than blocking it. The timeout is the backstop for
            anything else that waits. #>
        param([string[]] $Arguments, [int] $TimeoutSeconds = 120)

        $outFile = [IO.Path]::GetTempFileName()
        $errFile = [IO.Path]::GetTempFileName()
        $inFile = [IO.Path]::GetTempFileName()
        try {
            $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
                -ArgumentList $Arguments -NoNewWindow -PassThru `
                -RedirectStandardInput $inFile `
                -RedirectStandardOutput $outFile -RedirectStandardError $errFile
            # Touch the handle before the wait: without it, the Start-Process
            # wrapper can report ExitCode as null after a timed WaitForExit --
            # the failure CI measured in this helper's first run. The
            # parameterless WaitForExit afterwards settles the redirects.
            $null = $process.Handle
            $exited = $process.WaitForExit($TimeoutSeconds * 1000)
            if ($exited) { $process.WaitForExit() }
            if (-not $exited) {
                $process.Kill()
                $process.WaitForExit(10000) | Out-Null
            }
            $exitCode = $null
            if ($exited) { $exitCode = $process.ExitCode }
            return [ordered]@{
                TimedOut = (-not $exited)
                Exit     = $exitCode
                Output   = [string] (Get-Content -LiteralPath $outFile -Raw)
                Errors   = [string] (Get-Content -LiteralPath $errFile -Raw)
            }
        } finally {
            Remove-Item -LiteralPath $outFile, $errFile, $inFile -Force -ErrorAction SilentlyContinue
        }
    }
}

Describe 'The -LoadFunctionsOnly guard' {
    It 'defines the resolution functions and runs nothing else' {
        $command = ". '$setupScript' -LoadFunctionsOnly; " +
            "if (Get-Command Resolve-DropPath -ErrorAction SilentlyContinue) { 'LOADED' }"
        $run = Start-PowerShellChild -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command) -TimeoutSeconds 60

        $run.TimedOut | Should -BeFalse
        $run.Exit | Should -Be 0
        $run.Errors.Trim() | Should -BeNullOrEmpty
        # Exactly the one word: the setup flow announces itself with a banner
        # before it does anything, so any of it running shows up here.
        $run.Output.Trim() | Should -Be 'LOADED'
    }

    It 'leaves an ordinary run running the setup flow' {
        # Docker is taken off the PATH for this call. The flow asks the engine
        # for its version immediately after the banner, and a runner whose
        # engine answered would carry it on into an image pull.
        $originalPath = $env:PATH
        try {
            $env:PATH = @(
                (Join-Path $env:SystemRoot 'System32'),
                $env:SystemRoot,
                (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
            ) -join ';'
            $run = Start-PowerShellChild -Arguments @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$setupScript`"") -TimeoutSeconds 120
        } finally {
            $env:PATH = $originalPath
        }

        $run.TimedOut | Should -BeFalse
        $run.Output | Should -Match 'psilink file-drop setup'
        # A null exit must not satisfy "not zero": the guard would then pass
        # vacuously on the same helper fault the dot-source test caught.
        $run.Exit | Should -Not -BeNullOrEmpty
        $run.Exit | Should -Not -Be 0
    }
}

Describe 'Resolve-DropPath on paths that need no rig' {
    It 'reads a bare UNC share as server and share with no subdirectory' {
        $resolved = Resolve-DropPath -Raw '\\fileserver\exchange'

        $resolved.Kind | Should -Be 'Network'
        $resolved.Server | Should -Be 'fileserver'
        $resolved.Share | Should -Be 'exchange'
        $resolved.SubPath | Should -BeNullOrEmpty
        $resolved.Unc | Should -Be '\\fileserver\exchange'
        $resolved.Full | Should -Be '\\fileserver\exchange'
    }

    It 'reports the subdirectory with forward slashes for the mount option' {
        $resolved = Resolve-DropPath -Raw '\\fileserver\exchange\psilink\drop'

        $resolved.Share | Should -Be 'exchange'
        $resolved.SubPath | Should -Be 'psilink/drop'
        $resolved.Unc | Should -Be '\\fileserver\exchange'
        $resolved.Full | Should -Be '\\fileserver\exchange\psilink\drop'
    }

    It 'folds forward slashes before splitting the share off' {
        $resolved = Resolve-DropPath -Raw '//fileserver/exchange/psilink'

        $resolved.Kind | Should -Be 'Network'
        $resolved.Server | Should -Be 'fileserver'
        $resolved.Share | Should -Be 'exchange'
        $resolved.SubPath | Should -Be 'psilink'
    }

    It 'strips surrounding quotes and whitespace' {
        $resolved = Resolve-DropPath -Raw '  "\\fileserver\exchange\psilink"  '

        $resolved.Kind | Should -Be 'Network'
        $resolved.Share | Should -Be 'exchange'
        $resolved.SubPath | Should -Be 'psilink'
    }

    It 'ignores a trailing separator' {
        $resolved = Resolve-DropPath -Raw '\\fileserver\exchange\'

        $resolved.Kind | Should -Be 'Network'
        $resolved.Share | Should -Be 'exchange'
        $resolved.SubPath | Should -BeNullOrEmpty
    }

    It 'keeps a dollar sign and dots in a hidden share on a fully qualified server' {
        $resolved = Resolve-DropPath -Raw '\\fs-04.agency.gov\exchange$\dropbox'

        $resolved.Server | Should -Be 'fs-04.agency.gov'
        $resolved.Share | Should -Be 'exchange$'
        $resolved.SubPath | Should -Be 'dropbox'
    }

    It 'keeps spaces inside a share and a folder name' {
        $resolved = Resolve-DropPath -Raw '\\fileserver\my share\sub folder'

        $resolved.Share | Should -Be 'my share'
        $resolved.SubPath | Should -Be 'sub folder'
    }

    It 'unwraps the \\?\UNC\ device prefix' {
        $resolved = Resolve-DropPath -Raw '\\?\UNC\fileserver\exchange\psilink'

        $resolved.Kind | Should -Be 'Network'
        $resolved.Server | Should -Be 'fileserver'
        $resolved.Share | Should -Be 'exchange'
        $resolved.SubPath | Should -Be 'psilink'
    }

    It 'unwraps the \\.\ device prefix' {
        $resolved = Resolve-DropPath -Raw '\\.\C:\Exchange'

        $resolved.Kind | Should -Be 'Local'
        $resolved.LocalPath | Should -Be 'C:\Exchange'
    }

    It 'refuses a UNC that names a server and no share' {
        $resolved = Resolve-DropPath -Raw '\\fileserver'

        $resolved.Kind | Should -Be 'Unknown'
        $resolved.Reason | Should -Match 'names the server'
        $resolved.Reason | Should -Match 'fileserver'
    }

    It 'refuses an empty path' {
        (Resolve-DropPath -Raw '').Kind | Should -Be 'Unknown'
        (Resolve-DropPath -Raw '').Reason | Should -Be 'empty path'
        (Resolve-DropPath -Raw '   ').Reason | Should -Be 'empty path'
    }

    It 'refuses text that is not a path at all' {
        $resolved = Resolve-DropPath -Raw 'the exchange folder'

        $resolved.Kind | Should -Be 'Unknown'
        $resolved.Reason | Should -Match 'could not interpret'
    }

    It 'refuses a relative path' {
        (Resolve-DropPath -Raw 'exchange\psilink').Kind | Should -Be 'Unknown'
    }
}

Describe 'Drive-kind classification' {
    It 'reads the system drive as fixed and its paths as local' {
        Get-DriveKind -Letter 'C' | Should -Be 'Fixed'

        $resolved = Resolve-DropPath -Raw 'C:\Exchange\psilink'
        $resolved.Kind | Should -Be 'Local'
        $resolved.LocalPath | Should -Be 'C:\Exchange\psilink'
    }

    It 'reads a letter no drive holds as absent' {
        $letter = Find-FreeDriveLetter
        $letter | Should -Not -BeNullOrEmpty -Because 'the classification needs a letter nothing holds'

        Get-DriveKind -Letter $letter | Should -Be 'Absent'
    }

    It 'refuses a letter that resolves to nothing, and says which case it is' {
        $letter = Find-FreeDriveLetter
        $letter | Should -Not -BeNullOrEmpty

        $resolved = Resolve-DropPath -Raw "${letter}:\Exchange"
        $resolved.Kind | Should -Be 'Unknown'
        # The two arms differ by what the session can see, so the run's own
        # elevation decides which message is the right one.
        if (Test-Elevated) {
            $resolved.Reason | Should -Match 'running as Administrator'
        } else {
            $resolved.Reason | Should -Match "there is no ${letter}: drive"
        }
    }
}

Describe 'The dialect map' {
    It 'gives SMB3 the 3.1.1 the checks negotiate' {
        Get-DialectMountVersion -Dialect 'SMB3' | Should -Be '3.1.1'
    }

    It 'gives SMB2 and NT1 their mount versions' {
        Get-DialectMountVersion -Dialect 'SMB2' | Should -Be '2.1'
        Get-DialectMountVersion -Dialect 'NT1' | Should -Be '1.0'
    }

    It 'answers nothing for a name it does not carry' {
        # The map is closed; -Dialect's ValidateSet is what keeps the flow off
        # this branch, and an empty dialect never reaches the map at all.
        Get-DialectMountVersion -Dialect 'SMB3.02' | Should -BeNullOrEmpty
        Get-DialectMountVersion -Dialect '' | Should -BeNullOrEmpty
    }
}

Describe 'Hide-Secret' {
    It 'removes every occurrence of the password' {
        $masked = Hide-Secret -Text 'o=username=bob,password=hunter2,domain=x hunter2' -Secret 'hunter2'

        $masked | Should -Not -Match 'hunter2'
        $masked | Should -Be 'o=username=bob,password=<password removed>,domain=x <password removed>'
    }

    It 'returns the text unchanged when there is no secret to remove' {
        Hide-Secret -Text 'nothing to hide' -Secret '' | Should -Be 'nothing to hide'
        Hide-Secret -Text 'nothing to hide' -Secret $null | Should -Be 'nothing to hide'
    }

    It 'carries empty text through' {
        Hide-Secret -Text '' -Secret 'hunter2' | Should -BeNullOrEmpty
        Hide-Secret -Text $null -Secret 'hunter2' | Should -BeNullOrEmpty
    }
}

Describe 'Resolution over a live SMB rig' {
    BeforeAll {
        $global:PsilinkRigPremises = [ordered]@{
            share  = [ordered]@{ state = 'not_reached' }
            mapped = [ordered]@{ state = 'not_reached' }
            dfs    = [ordered]@{ state = 'not_reached' }
        }

        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
        $dataShareName = "psilinkci$suffix"
        $dfsShareName = "psilinkdfs$suffix"
        $dataShareRoot = Join-Path $env:TEMP "psilink-ci-data-$suffix"
        $dfsShareRoot = Join-Path $env:TEMP "psilink-ci-dfs-$suffix"
        $dataUnc = "\\localhost\$dataShareName"
        # DFS names its targets by server, so the namespace link cannot be
        # pointed at the loopback form above.
        $dataUncByServer = "\\$env:COMPUTERNAME\$dataShareName"
        $subFolder = 'drop'
        $mappedLetter = $null
        $dfsLetter = $null
        $namespacePath = $null
        $namespaceLink = $null

        # --- the share, and a mapped letter over it -------------------------
        try {
            # A hosted runner has no reason to be serving SMB, so the Server
            # service may be stopped.
            $serverService = Get-Service -Name LanmanServer -ErrorAction SilentlyContinue
            if ($serverService -and $serverService.Status -ne 'Running') {
                Start-Service -Name LanmanServer -ErrorAction SilentlyContinue
                $serverService = Get-Service -Name LanmanServer -ErrorAction SilentlyContinue
            }

            New-Item -ItemType Directory -Path (Join-Path $dataShareRoot $subFolder) -Force | Out-Null
            # Full access for the runner's own account rather than Everyone: the
            # rig only ever reaches this share as itself, over loopback.
            New-SmbShare -Name $dataShareName -Path $dataShareRoot -FullAccess $identity.Name | Out-Null

            # Writing through the UNC and finding the bytes in the directory is
            # what makes this a real share rather than a name that accepts a
            # write.
            $token = [guid]::NewGuid().ToString('N')
            Set-Content -LiteralPath (Join-Path $dataUnc 'premise.txt') -Value $token -Encoding Ascii
            $landed = (Get-Content -LiteralPath (Join-Path $dataShareRoot 'premise.txt') -Raw).Trim() -eq $token

            $serverServiceStatus = 'absent'
            if ($serverService) { $serverServiceStatus = [string] $serverService.Status }

            $global:PsilinkRigPremises.share = [ordered]@{
                state          = 'built'
                server_service = $serverServiceStatus
                share          = $dataShareName
                unc            = $dataUnc
                write_through  = $landed
            }
        } catch {
            $global:PsilinkRigPremises.share = [ordered]@{
                state = 'FAILED'
                share = $dataShareName
                error = $_.Exception.Message
            }
        }

        try {
            $candidate = Find-FreeDriveLetter
            if (-not $candidate) { throw 'no free drive letter on this runner' }
            $mapping = Invoke-Net -Arguments @('use', "${candidate}:", $dataUnc, '/persistent:no')
            if ($mapping.Exit -eq 0) { $mappedLetter = $candidate }

            $global:PsilinkRigPremises.mapped = [ordered]@{
                state       = $(if ($mappedLetter) { 'built' } else { 'FAILED' })
                letter      = $mappedLetter
                target      = $dataUnc
                netuse_exit = $mapping.Exit
                error       = $(if ($mappedLetter) { $null } else { $mapping.Output })
            }
        } catch {
            $global:PsilinkRigPremises.mapped = [ordered]@{
                state  = 'FAILED'
                target = $dataUnc
                error  = $_.Exception.Message
            }
        }

        # --- the standalone namespace, and a letter over a link in it -------
        try {
            Import-Module ServerManager -ErrorAction Stop
            $install = Install-WindowsFeature -Name FS-DFS-Namespace -IncludeManagementTools
            if (-not $install.Success) { throw "Install-WindowsFeature exit $($install.ExitCode)" }

            $dfsService = Get-Service -Name Dfs -ErrorAction SilentlyContinue
            if ($dfsService -and $dfsService.Status -ne 'Running') {
                Start-Service -Name Dfs -ErrorAction SilentlyContinue
                $dfsService = Get-Service -Name Dfs -ErrorAction SilentlyContinue
            }
            $dfsServiceStatus = 'absent'
            if ($dfsService) { $dfsServiceStatus = [string] $dfsService.Status }

            New-Item -ItemType Directory -Path $dfsShareRoot -Force | Out-Null
            New-SmbShare -Name $dfsShareName -Path $dfsShareRoot -FullAccess $identity.Name | Out-Null

            # A standalone root is named by the share that hosts it, on the
            # server's own name: localhost is not accepted as a namespace server.
            $namespacePath = "\\$env:COMPUTERNAME\$dfsShareName"
            New-DfsnRoot -TargetPath $namespacePath -Type Standalone | Out-Null
            $namespaceLink = "$namespacePath\$subFolder"
            New-DfsnFolder -Path $namespaceLink -TargetPath $dataUncByServer | Out-Null

            $candidate = Find-FreeDriveLetter -Exclude @($mappedLetter)
            if (-not $candidate) { throw 'no second free drive letter on this runner' }
            $dfsMapping = Invoke-Net -Arguments @('use', "${candidate}:", $namespaceLink, '/persistent:no')
            if ($dfsMapping.Exit -eq 0) { $dfsLetter = $candidate }

            $global:PsilinkRigPremises.dfs = [ordered]@{
                state       = $(if ($dfsLetter) { 'built' } else { 'FAILED' })
                dfs_service = $dfsServiceStatus
                namespace   = $namespacePath
                link        = $namespaceLink
                target      = $dataUncByServer
                letter      = $dfsLetter
                netuse_exit = $dfsMapping.Exit
                error       = $(if ($dfsLetter) { $null } else { $dfsMapping.Output })
            }
        } catch {
            $global:PsilinkRigPremises.dfs = [ordered]@{
                state     = 'FAILED'
                namespace = $namespacePath
                link      = $namespaceLink
                error     = $_.Exception.Message
            }
        }
    }

    It 'resolves a mapped letter to the UNC behind it' {
        $mappedLetter | Should -Not -BeNullOrEmpty -Because 'the rig has to map a letter before this can be asked'

        $unc = Resolve-MappedDrive -Letter $mappedLetter
        $unc | Should -Not -BeNullOrEmpty
        $unc.TrimEnd('\') | Should -Be $dataUnc
    }

    It 'calls a mapped letter a network drive' {
        $mappedLetter | Should -Not -BeNullOrEmpty

        Get-DriveKind -Letter $mappedLetter | Should -Be 'Network'
    }

    It 'turns a path on a mapped letter into the server, share and subdirectory behind it' {
        $mappedLetter | Should -Not -BeNullOrEmpty

        $resolved = Resolve-DropPath -Raw "${mappedLetter}:\$subFolder"
        $resolved.Kind | Should -Be 'Network'
        $resolved.Server | Should -Be 'localhost'
        $resolved.Share | Should -Be $dataShareName
        $resolved.SubPath | Should -Be $subFolder
        $resolved.Unc | Should -Be $dataUnc
        $resolved.Full | Should -Be "$dataUnc\$subFolder"
    }

    It 'resolves a letter mapped through a DFS namespace to the namespace, not to the server holding the data' {
        $dfsLetter | Should -Not -BeNullOrEmpty -Because 'the rig has to map a letter to a namespace link before this can be asked'

        $unc = Resolve-MappedDrive -Letter $dfsLetter
        $unc | Should -Not -BeNullOrEmpty
        $unc.TrimEnd('\') | Should -Be $namespaceLink

        $resolved = Resolve-DropPath -Raw "${dfsLetter}:\"
        $resolved.Kind | Should -Be 'Network'
        $resolved.Server | Should -Be $env:COMPUTERNAME
        $resolved.Share | Should -Be $dfsShareName
        $resolved.SubPath | Should -Be $subFolder
        # The share the data actually lives on. That the resolution does not
        # reach it is why the script asks the operator to confirm what it worked
        # out, and why a DFS path is the case it names when it asks.
        $resolved.Share | Should -Not -Be $dataShareName
    }

    AfterAll {
        # Hygiene rather than necessity -- the runner is thrown away -- but it
        # keeps a re-run on any other host from meeting its own leftovers. Each
        # step is guarded: a rig half that failed to build leaves commands that
        # are not there to call, and a teardown that threw would report as a
        # test failure.
        if ($mappedLetter) { Invoke-Net -Arguments @('use', "${mappedLetter}:", '/delete', '/y') | Out-Null }
        if ($dfsLetter) { Invoke-Net -Arguments @('use', "${dfsLetter}:", '/delete', '/y') | Out-Null }
        try {
            if ($namespaceLink) { Remove-DfsnFolder -Path $namespaceLink -Force -ErrorAction SilentlyContinue }
            if ($namespacePath) { Remove-DfsnRoot -Path $namespacePath -Force -ErrorAction SilentlyContinue }
        } catch { }
        try {
            Remove-SmbShare -Name $dataShareName -Force -ErrorAction SilentlyContinue
            Remove-SmbShare -Name $dfsShareName -Force -ErrorAction SilentlyContinue
        } catch { }
        Remove-Item -LiteralPath $dataShareRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $dfsShareRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
