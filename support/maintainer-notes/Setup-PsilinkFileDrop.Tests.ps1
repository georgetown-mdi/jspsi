<#
.SYNOPSIS
    Pester suite over the path-resolution functions in
    Setup-PsilinkFileDrop.ps1, the console command it closes on, and the
    image-capability question it turns an unusable image away on before it asks
    for a password. Maintainer-facing: it lives outside the guide folder, and an
    operator following the setup page never receives it.

.DESCRIPTION
    The script under test is dot-sourced with -LoadFunctionsOnly, which defines
    its functions and stops before the setup flow. Two tests hold that switch to
    its contract from both sides -- a dot-source prints nothing, and an ordinary
    run still reaches the banner -- because a guard that silently swallowed the
    flow would leave every operator with a script that does nothing.

    Three kinds of test:

      - Pure: UNC and device-prefix parsing, drive-kind classification, the
        dialect map, password masking, the rule that names the shared folder
        and the console command the closing screen prints from it, and that the
        switch defines the sequences the launcher reaches through it. These
        need no rig and no rights.
      - Stub-engine: a .cmd standing in for the container engine, either passed
        by path to one function or put ahead of the PATH so a whole run of the
        flow reaches it. That second form is what lets a test read back which
        calls the flow made -- and, for the image-capability question, which it
        did not go on to make.
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

            $PSHOME rather than the bare name, because callers strip the PATH
            down; a temporary file rather than the console for standard input,
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
            # the failure CI measured in this helper's first run. Best-effort:
            # a child that exited already can refuse the handle, and the Exit
            # assertion downstream is what reports that case. The parameterless
            # WaitForExit afterwards settles the redirects.
            try { $null = $process.Handle } catch { }
            $exited = $process.WaitForExit($TimeoutSeconds * 1000)
            if ($exited) { $process.WaitForExit() }
            if (-not $exited) {
                $process.Kill()
                $process.WaitForExit(10000) | Out-Null
            }
            $exitCode = $null
            if ($exited) { $exitCode = $process.ExitCode }
            # Plain statements and an explicit null check: CI measured Errors
            # arriving at the assertions as null despite a [string] cast here,
            # so the coercion is spelled out where a debugger cannot reach.
            $stdout = Get-Content -LiteralPath $outFile -Raw
            if ($null -eq $stdout) { $stdout = '' }
            $stderr = Get-Content -LiteralPath $errFile -Raw
            if ($null -eq $stderr) { $stderr = '' }
            return [ordered]@{
                TimedOut = (-not $exited)
                Exit     = $exitCode
                Output   = [string] $stdout
                Errors   = [string] $stderr
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

        # Null-safe reads and a -Because carrying the run's shape: the failure
        # annotation is the only diagnostic that leaves the runner, so an
        # assertion here must describe the run it judged, never throw.
        $stdout = ([string] $run.Output).Trim()
        $stderr = ([string] $run.Errors).Trim()
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) " +
            "out_null=$($null -eq $run.Output) err_null=$($null -eq $run.Errors)"
        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 0 -Because $shape
        $stderr | Should -BeNullOrEmpty -Because $shape
        # Exactly the one word: the setup flow announces itself with a banner
        # before it does anything, so any of it running shows up here.
        $stdout | Should -Be 'LOADED' -Because $shape
    }

    It 'defines the sequences Start-Psilink.ps1 dot-sources it for' {
        # The launcher carries no copy of these: it calls them through the
        # dot-source, so each has to sit above the guard rather than in the flow
        # below it. A move past the guard leaves the launcher's network branch
        # calling functions that are not there, on a path no test here reaches.
        foreach ($name in 'Resolve-DropPath', 'Read-ShareCredential',
                          'New-ShareVolume', 'Invoke-Docker', 'Hide-Secret',
                          'Get-RendezvousFolderName') {
            Get-Command $name -ErrorAction SilentlyContinue |
                Should -Not -BeNullOrEmpty -Because $name
        }
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

Describe 'The shared folder name the console is told' {
    It 'names a folder on this PC by its own last segment' {
        Get-RendezvousFolderName -Path 'C:\Users\dana\Egnyte\agency-a-agency-b' |
            Should -Be 'agency-a-agency-b'
    }

    It 'ignores a trailing separator, and reads either one' {
        Get-RendezvousFolderName -Path 'C:\drops\studyA\' | Should -Be 'studyA'
        Get-RendezvousFolderName -Path 'C:/drops/studyA' | Should -Be 'studyA'
    }

    It 'names a share subfolder rather than the mount the volume is bound at' {
        # The network shape mounts a named volume, so no host path reaches the
        # container at all: the share is where the name has to come from.
        Get-RendezvousFolderName -Share 'exchange' -SubPath 'agency-a/agency-b' |
            Should -Be 'agency-b'
    }

    It 'names the share itself when the folder is the share root' {
        Get-RendezvousFolderName -Share 'exchange' | Should -Be 'exchange'
    }

    It 'reads a subfolder the command line supplied with backslashes' {
        # -SubPath is normalised to forward slashes before the flow reaches the
        # console command, but the rule is not allowed to depend on that.
        Get-RendezvousFolderName -Share 'exchange' -SubPath 'agency-a\agency-b' |
            Should -Be 'agency-b'
    }

    It 'gives no name for a drive root, which has none' {
        # Naming it 'D:' would ask the partner to match a drive letter that means
        # nothing on their machine; the console degrades to no name instead.
        Get-RendezvousFolderName -Path 'D:\' | Should -BeNullOrEmpty
        Get-RendezvousFolderName -Path 'D:' | Should -BeNullOrEmpty
    }

    It 'gives no name for a path it could read no segment out of' {
        Get-RendezvousFolderName -Path '' | Should -BeNullOrEmpty
        Get-RendezvousFolderName -Path '\' | Should -BeNullOrEmpty
    }
}

Describe 'The console command the closing screen prints' {
    It 'mounts the volume the run created, and the work folder beside it' {
        $lines = @(Get-ConsoleCommandLines -VolumeName 'psilink-sync' -RendezvousName 'agency-b')

        ($lines -join "`n") | Should -Match "-v 'psilink-sync:/sync'"
        ($lines -join "`n") | Should -Match "-v 'C:\\path\\to\\your\\work:/data'"
        ($lines -join "`n") | Should -Match 'JOB_RENDEZVOUS_DIR=/sync'
    }

    It 'carries the folder name the naming rule reads off the share' {
        # The whole path the closing screen takes, driven end to end: the share
        # and subfolder the run resolved reduce to one name, and that is what the
        # operator is told to pass.
        $lines = @(Get-ConsoleCommandLines -VolumeName 'psilink-sync' `
            -RendezvousName (Get-RendezvousFolderName -Share 'exchange' -SubPath 'agency-a/agency-b'))

        ($lines -join "`n") | Should -Match "JOB_RENDEZVOUS_NAME=agency-b'"
    }

    It 'carries the share itself when the drop folder is the share root' {
        $lines = @(Get-ConsoleCommandLines -VolumeName 'psilink-sync' `
            -RendezvousName (Get-RendezvousFolderName -Share 'exchange' -SubPath ''))

        ($lines -join "`n") | Should -Match "JOB_RENDEZVOUS_NAME=exchange'"
    }

    It 'passes an empty name rather than leaving the variable out' {
        # An omitted variable has the console name the folder after the mount
        # point THIS script picked -- sync -- and mint that as the name the
        # partner is told to look for.
        $lines = @(Get-ConsoleCommandLines -VolumeName 'psilink-sync')

        ($lines -join "`n") | Should -Match "JOB_RENDEZVOUS_NAME='"
        # The quote closes immediately: anything else between the = and it is a
        # name, and the mount point is what an omitted variable would leave.
        ($lines -join "`n") | Should -Not -Match "JOB_RENDEZVOUS_NAME=[^']"
    }

    It 'ends every line but the last with the continuation that joins them' {
        # The command is pasted as printed: a line that lost its continuation
        # runs as a command of its own, and the rest as arguments to nothing.
        $lines = @(Get-ConsoleCommandLines -VolumeName 'psilink-sync' -RendezvousName 'agency-b')

        $lines.Count | Should -BeGreaterThan 1
        foreach ($line in $lines[0..($lines.Count - 2)]) {
            $line | Should -Match '`$'
        }
        $lines[-1] | Should -Not -Match '`$'
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

Describe 'Invoke-Docker' {
    BeforeAll {
        $script:EngineStubRoot = Join-Path $env:TEMP ('psilink-engine-stub-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $script:EngineStubRoot -Force | Out-Null

        # A native command that answers on both streams and exits non-zero,
        # which is the engine's own routine behaviour: docker writes "no such
        # volume" to standard error on every first run.
        $script:NoisyEngine = Join-Path $script:EngineStubRoot 'noisy.cmd'
        Set-Content -LiteralPath $script:NoisyEngine -Encoding Ascii -Value @(
            '@echo off',
            'echo answered on stdout',
            'echo grumbled on stderr 1>&2',
            'exit /b 3')
    }

    AfterAll {
        Remove-Item -LiteralPath $script:EngineStubRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'answers a name that is not a command without borrowing an earlier code' {
        # A native command run first, leaving a 0 in $LASTEXITCODE, so that the
        # answer below cannot have been taken from there -- a 0 would read as an
        # engine that ran and was happy. What the call itself does without the
        # guard is the case two below.
        & cmd /c exit 0

        $result = Invoke-Docker -Engine 'psilink-no-such-engine' -DockerArgs @('version')

        $result.Ran | Should -Be $false
        $result.ExitCode | Should -Not -Be 0
        $result.Output | Should -Match 'psilink-no-such-engine'
    }

    It 'reports an empty engine name the same way' {
        & cmd /c exit 0

        $result = Invoke-Docker -Engine '' -DockerArgs @('version')

        $result.Ran | Should -Be $false
        $result.ExitCode | Should -Not -Be 0
    }

    It 'carries a stderr-writing command''s output and code back rather than throwing' {
        # The preference the script runs under, restated here because it is the
        # whole reason the redirect inside Invoke-Docker relaxes it.
        $ErrorActionPreference = 'Stop'

        $result = Invoke-Docker -Engine $script:NoisyEngine -DockerArgs @('ignored')

        $result.Ran | Should -Be $true
        $result.ExitCode | Should -Be 3
        $result.Output | Should -Match 'answered on stdout'
        $result.Output | Should -Match 'grumbled on stderr'
    }

    It 'would end the run on a redirected stderr line without the relaxed preference' {
        # The premise the relaxed preference inside Invoke-Docker exists for,
        # held as a check rather than asserted in a comment: at 'Stop', Windows
        # PowerShell turns a native program's redirected standard error into a
        # terminating record, whatever its exit code says.
        $ErrorActionPreference = 'Stop'
        $threw = $false

        try { $null = & $script:NoisyEngine 2>&1 } catch { $threw = $true }

        $threw | Should -BeTrue
    }

    It 'would end the run on a name that is not a command without the guard' {
        # The premise the guard stands in for: the call raises rather than
        # answering, and the relaxed preference the wrapper runs under does not
        # soften it -- so a wrapper without the guard never returns anything a
        # caller could report.
        $ErrorActionPreference = 'Continue'
        $threw = $false
        $raised = ''

        try { & 'psilink-no-such-engine' 'version' } catch {
            $threw = $true
            $raised = $_.Exception.GetType().Name
        }

        $threw | Should -BeTrue
        $raised | Should -Be 'CommandNotFoundException'
    }
}

Describe 'The image capability check' {
    BeforeAll {
        $script:CapabilityStubRoot = Join-Path $env:TEMP ('psilink-capability-stub-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $script:CapabilityStubRoot -Force | Out-Null

        # An engine standing in for a released image published before the doctor
        # existed: it exits 0 and prints the zero-setup help, which names no
        # doctor. The exit code is the shape that matters here -- such an image
        # answers 0 to this and 64 to a battery, and 64 is also what the doctor
        # answers for a value it refuses, so a code cannot decide the question.
        $script:PreDoctorEngine = Join-Path $script:CapabilityStubRoot 'predoctor.cmd'
        Set-Content -LiteralPath $script:PreDoctorEngine -Encoding Ascii -Value @(
            '@echo off',
            'echo psilink [command] [options]',
            'echo Usage:',
            'echo   psilink [--save] [options] URL INPUT_FILE [OUTPUT_FILE]',
            'echo Commands:',
            'echo   psilink init [args..]   Write a commented configuration template',
            'echo   psilink exchange        Execute a recurring exchange',
            'exit /b 0')

        $script:DoctorEngine = Join-Path $script:CapabilityStubRoot 'withdoctor.cmd'
        Set-Content -LiteralPath $script:DoctorEngine -Encoding Ascii -Value @(
            '@echo off',
            'echo Usage: psilink doctor probe or doctor mount DIRECTORY',
            'echo Commands:',
            'echo   psilink doctor probe   Check the file drop over the network',
            'echo   psilink doctor mount   Check an already-mounted file-drop directory',
            'exit /b 0')

        # Docker reserves 125 and above for its own failure to start a
        # container, which the script's battery arms already read as their own
        # case; the capability question has to keep the same line.
        $script:UnstartableEngine = Join-Path $script:CapabilityStubRoot 'unstartable.cmd'
        Set-Content -LiteralPath $script:UnstartableEngine -Encoding Ascii -Value @(
            '@echo off',
            'echo docker: error during connect 1>&2',
            'exit /b 125')

        # Records what it was asked to run, so the invocation itself can be
        # read back rather than inferred from the answer.
        $script:RecordingEngine = Join-Path $script:CapabilityStubRoot 'recorder.cmd'
        Set-Content -LiteralPath $script:RecordingEngine -Encoding Ascii -Value @(
            '@echo off',
            '>"%PSILINK_STUB_ARGS%" echo %*',
            'echo Usage: psilink doctor probe or doctor mount DIRECTORY',
            'exit /b 0')
    }

    AfterAll {
        Remove-Item -LiteralPath $script:CapabilityStubRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'calls an image whose doctor answers for itself capable' {
        $result = Test-DoctorCapableImage -Image 'vdorie/psi-link:latest' -Engine $script:DoctorEngine

        $result.Capable | Should -BeTrue
    }

    It 'calls an image whose help names no doctor too old, though it exits 0' {
        $result = Test-DoctorCapableImage -Image 'vdorie/psi-link:latest' -Engine $script:PreDoctorEngine

        $result.Capable | Should -BeFalse
        $result.Reason | Should -Be 'NoDoctor'
        # The verdict is fixed, so what the image said is the whole of the
        # evidence the flow can print under it -- and this bucket holds a
        # `doctor --help` that crashed in a current image as well as the
        # documented old one.
        $result.ExitCode | Should -Be 0
        $result.Output | Should -Match 'URL INPUT_FILE'
    }

    It 'keeps an engine that could not start the container apart from an old image' {
        # The two remedies point opposite ways -- refresh the image, versus read
        # what the engine said -- so merging them would send an operator whose
        # Docker is down off pulling an image they already have.
        $result = Test-DoctorCapableImage -Image 'vdorie/psi-link:latest' -Engine $script:UnstartableEngine

        $result.Capable | Should -BeFalse
        $result.Reason | Should -Be 'EngineFailed'
        $result.ExitCode | Should -Be 125
    }

    It 'asks the question with no battery and no share input' {
        # What makes this safe to run before the credentials are collected: it
        # names neither battery, so nothing it reports can be about the share.
        $argsFile = Join-Path $script:CapabilityStubRoot 'recorded-args.txt'
        $previous = $env:PSILINK_STUB_ARGS
        try {
            $env:PSILINK_STUB_ARGS = $argsFile
            $result = Test-DoctorCapableImage -Image 'vdorie/psi-link:latest' -Engine $script:RecordingEngine
            $result.Capable | Should -BeTrue
        } finally {
            if ($null -eq $previous) { Remove-Item env:PSILINK_STUB_ARGS -ErrorAction SilentlyContinue }
            else { $env:PSILINK_STUB_ARGS = $previous }
        }

        # Read defensively: a stub that wrote nothing must reach the assertions
        # as an empty string it can report, not as a throw inside Trim.
        $recorded = ''
        if (Test-Path -LiteralPath $argsFile) {
            $recorded = ([string] (Get-Content -LiteralPath $argsFile -Raw)).Trim()
        }
        $recorded | Should -Match 'vdorie/psi-link:latest' -Because $recorded
        $recorded | Should -Match 'doctor' -Because $recorded
        $recorded | Should -Match '--help' -Because $recorded
        $recorded | Should -Not -Match 'probe' -Because $recorded
        $recorded | Should -Not -Match 'mount' -Because $recorded
    }
}

Describe 'The image capability check inside the setup flow' {
    BeforeAll {
        # Whole engines, each named so the flow's own `docker` calls reach it
        # through the PATH. Each answers preflight normally and then serves one
        # of the shapes of `doctor --help` -- or, for the third, refuses to run
        # a container at all -- and appends every call it was given to
        # PSILINK_STUB_LOG, which is what lets a test assert what the flow did
        # NOT go on to run.
        #
        # Labels rather than parenthesised blocks: a `)` anywhere in the help
        # text would close a block early, and the pre-doctor help is the real
        # CLI's, punctuation included.
        $script:StaleEngineRoot = Join-Path $env:TEMP ('psilink-flow-stale-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        $script:CapableEngineRoot = Join-Path $env:TEMP ('psilink-flow-capable-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        $script:NoRunEngineRoot = Join-Path $env:TEMP ('psilink-flow-norun-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $script:StaleEngineRoot -Force | Out-Null
        New-Item -ItemType Directory -Path $script:CapableEngineRoot -Force | Out-Null
        New-Item -ItemType Directory -Path $script:NoRunEngineRoot -Force | Out-Null

        $engineHead = @(
            '@echo off',
            '>>"%PSILINK_STUB_LOG%" echo %*',
            'echo %*| findstr /C:"version --format" >nul',
            'if not errorlevel 1 goto engineversion',
            'echo %*| findstr /C:"image inspect" >nul',
            'if not errorlevel 1 goto imagepresent')
        $engineTail = @(
            'echo unexpected engine call: %*',
            'exit /b 99',
            ':engineversion',
            'echo linux 27.1.1',
            'exit /b 0',
            ':imagepresent',
            'exit /b 0')

        $prologue = $engineHead + @(
            'echo %*| findstr /C:"doctor --help" >nul',
            'if not errorlevel 1 goto doctorhelp') + $engineTail + @(':doctorhelp')

        Set-Content -LiteralPath (Join-Path $script:StaleEngineRoot 'docker.cmd') -Encoding Ascii -Value ($prologue + @(
            'echo psilink [command] [options]',
            'echo Usage:',
            'echo   psilink [--save] [options] URL INPUT_FILE [OUTPUT_FILE]',
            'exit /b 0'))

        Set-Content -LiteralPath (Join-Path $script:CapableEngineRoot 'docker.cmd') -Encoding Ascii -Value ($prologue + @(
            'echo Usage: psilink doctor probe or doctor mount DIRECTORY',
            'echo   psilink doctor probe   Check the file drop over the network',
            'echo   psilink doctor mount   Check an already-mounted file-drop directory',
            'exit /b 0'))

        # The same engine with the doctor branch taken out, so it answers only
        # the two preflight questions and refuses everything else loudly: any
        # `docker run` at all reaches the unexpected-call arm, which exits 99 and
        # names the call it was given. That is what makes "the local answer runs
        # no container" an assertion rather than a reading of the flow.
        Set-Content -LiteralPath (Join-Path $script:NoRunEngineRoot 'docker.cmd') -Encoding Ascii -Value ($engineHead + $engineTail)

        function Invoke-SetupWithEngine {
            <#  Run the setup flow with one of the stub engines ahead of a
                minimal PATH, and return the run beside the calls the engine
                recorded. The PATH is cut down to the system directories for the
                same reason the -LoadFunctionsOnly guard's own flow test cuts
                it: a runner with a real Docker would otherwise answer first. #>
            param(
                [Parameter(Mandatory = $true)][string] $EngineRoot,
                [Parameter(Mandatory = $true)][string] $SetupScript,
                [string[]] $ScriptArguments = @()
            )

            $log = Join-Path $EngineRoot ('calls-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.log')
            $originalPath = $env:PATH
            $originalLog = $env:PSILINK_STUB_LOG
            try {
                $env:PSILINK_STUB_LOG = $log
                $env:PATH = @(
                    $EngineRoot,
                    (Join-Path $env:SystemRoot 'System32'),
                    $env:SystemRoot,
                    (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
                ) -join ';'
                $run = Start-PowerShellChild -Arguments (@(
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$SetupScript`"") +
                    $ScriptArguments) -TimeoutSeconds 120
            } finally {
                $env:PATH = $originalPath
                if ($null -eq $originalLog) { Remove-Item env:PSILINK_STUB_LOG -ErrorAction SilentlyContinue }
                else { $env:PSILINK_STUB_LOG = $originalLog }
            }

            $calls = ''
            if (Test-Path -LiteralPath $log) {
                $calls = [string] (Get-Content -LiteralPath $log -Raw)
            }
            return [ordered]@{
                TimedOut = $run.TimedOut
                Exit     = $run.Exit
                Output   = [string] $run.Output
                Errors   = [string] $run.Errors
                Calls    = $calls
            }
        }
    }

    AfterAll {
        Remove-Item -LiteralPath $script:StaleEngineRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $script:CapableEngineRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $script:NoRunEngineRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'turns a stale image away on the -Server path, blaming neither the values nor itself' {
        $run = Invoke-SetupWithEngine -EngineRoot $script:StaleEngineRoot -SetupScript $setupScript -ScriptArguments @(
            '-Server', 'fs-04.agency.gov', '-Share', 'exchange', '-SkipConfirm')
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) calls=$($run.Calls)"

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 1 -Because $shape
        $run.Output | Should -Match 'too old' -Because $shape
        $run.Output | Should -Match 'docker pull vdorie/psi-link:latest' -Because $shape
        # The two things a 64 from the battery can honestly mean. This is
        # neither: it is the image, so neither may be printed here.
        $run.Output | Should -Not -Match 'defect in Setup-PsilinkFileDrop.ps1' -Because $shape
        $run.Output | Should -Not -Match 'refused the values' -Because $shape
        # And what the image itself answered, printed after the remedy. The
        # verdict is fixed, so this is the only thing an operator whose
        # `doctor --help` crashed in a current image has to report.
        $run.Output | Should -Match '\(exit 0\)' -Because $shape
        $run.Output | Should -Match 'URL INPUT_FILE' -Because $shape
    }

    It 'turns a stale image away on the resolved-path route too, before the credentials' {
        # The other way in: -DropPath goes through the path resolution the
        # -Server form skips, and the check sits below that resolution, so one
        # arm cannot stand for both routes. A reserved TLD (RFC 6761) for the
        # server, because the flow asks Windows whether it can reach the path
        # on the way down, and no machine can ever answer to this one.
        $run = Invoke-SetupWithEngine -EngineRoot $script:StaleEngineRoot -SetupScript $setupScript -ScriptArguments @(
            '-DropPath', '\\fs-04.invalid\exchange\psilink', '-SkipConfirm')
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) calls=$($run.Calls)"

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 1 -Because $shape
        $run.Output | Should -Match 'too old' -Because $shape
        $run.Output | Should -Not -Match 'credentials for the file server' -Because $shape
    }

    It 'runs no container at all for a folder that turns out to be local' {
        # The local answer needs no battery -- it prints a direct -v mount and
        # leaves -- so it must not be made to survive a container first. The
        # engine here refuses every `docker run`, so a capability check asked
        # above the path resolution fails this run rather than merely slowing
        # it.
        $run = Invoke-SetupWithEngine -EngineRoot $script:NoRunEngineRoot -SetupScript $setupScript -ScriptArguments @(
            '-DropPath', 'C:\psilink-local-drop')
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) calls=$($run.Calls)"

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 0 -Because $shape
        $run.Output | Should -Match 'already local' -Because $shape
        $run.Output | Should -Match 'do not need a Docker volume at all' -Because $shape
        $run.Output | Should -Not -Match 'too old' -Because $shape
        $run.Output | Should -Not -Match 'unexpected engine call' -Because $shape
        $run.Calls | Should -Match 'image inspect' -Because $run.Calls
        $run.Calls | Should -Not -Match 'doctor --help' -Because $run.Calls
    }

    It 'reaches no battery with an image that cannot produce a verdict' {
        # The property the placement buys: every verdict arm below reads a code
        # from one of these two batteries, so an image turned away before either
        # runs cannot reach one.
        $run = Invoke-SetupWithEngine -EngineRoot $script:StaleEngineRoot -SetupScript $setupScript -ScriptArguments @(
            '-Server', 'fs-04.agency.gov', '-Share', 'exchange', '-SkipConfirm')

        $run.Calls | Should -Not -BeNullOrEmpty
        $run.Calls | Should -Match 'doctor --help' -Because $run.Calls
        $run.Calls | Should -Not -Match 'doctor probe' -Because $run.Calls
        $run.Calls | Should -Not -Match 'doctor mount' -Because $run.Calls
        $run.Calls | Should -Not -Match 'volume create' -Because $run.Calls
    }

    It 'lets an image that carries the doctor through to the credentials' {
        # The other direction: the gate has to be silent for a current image, or
        # it would trade one misdiagnosis for another. The run stops at the
        # first prompt below it -- the username -- rather than completing a
        # setup, which is why the exit code is left out of this one.
        $run = Invoke-SetupWithEngine -EngineRoot $script:CapableEngineRoot -SetupScript $setupScript -ScriptArguments @(
            '-Server', 'fs-04.agency.gov', '-Share', 'exchange', '-SkipConfirm')
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) calls=$($run.Calls)"

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Output | Should -Match 'image carries the checks' -Because $shape
        $run.Output | Should -Match 'credentials for the file server' -Because $shape
        $run.Output | Should -Not -Match 'too old' -Because $shape
        $run.Calls | Should -Match 'doctor --help' -Because $run.Calls
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

    It 'reads the UNC root back out of net use for a mapped letter' {
        # Resolve-MappedDrive's third method, driven on its own: the two before
        # it answer first on this runner, so nothing else executes it.
        $mappedLetter | Should -Not -BeNullOrEmpty -Because 'the rig has to map a letter before this can be asked'
        # The preference the script itself runs under. A native command whose
        # standard error is redirected is where 'Stop' would end the run.
        $ErrorActionPreference = 'Stop'

        $root = Get-NetUseRemoteName -Letter $mappedLetter

        $root | Should -Not -BeNullOrEmpty
        $root.TrimEnd('\') | Should -Be $dataUnc
    }

    It 'answers nothing for a letter nothing is mapped to' {
        $letter = Find-FreeDriveLetter -Exclude @($mappedLetter, $dfsLetter)
        $letter | Should -Not -BeNullOrEmpty
        $ErrorActionPreference = 'Stop'

        Get-NetUseRemoteName -Letter $letter | Should -BeNullOrEmpty
    }

    It 'reaches an unmapped letter as a throw rather than as an exit code' {
        # Why the catch inside Get-NetUseRemoteName is load-bearing: net use
        # writes to standard error for a letter it does not hold, and at 'Stop'
        # the redirect turns that into a terminating record before the exit
        # code above it is ever read.
        $letter = Find-FreeDriveLetter -Exclude @($mappedLetter, $dfsLetter)
        $letter | Should -Not -BeNullOrEmpty
        $ErrorActionPreference = 'Stop'
        $threw = $false

        try { $null = & net use "${letter}:" 2>$null } catch { $threw = $true }

        $threw | Should -BeTrue
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
