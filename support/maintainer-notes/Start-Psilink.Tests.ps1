<#
.SYNOPSIS
    Pester suite over the pure functions in Start-Psilink.ps1 -- the doctor
    verdict reader, the release stamp, the DFS candidate selection, and the
    console's argument vector. Maintainer-facing: it lives outside the guide
    folder, and an operator following the setup page never receives it.

.DESCRIPTION
    The script under test is dot-sourced with -LoadFunctionsOnly, which defines
    its functions and stops before the launcher flow. Two tests hold that switch
    to its contract from both sides -- a dot-source prints nothing, and an
    ordinary run reaches the banner -- because a guard that silently swallowed
    the flow would leave every operator with a launcher that does nothing.

    Everything here is pure. Nothing in this file starts a container, reaches a
    network, or opens a picker: the launcher's engine calls, its prompts and its
    folder picker are verified by running it, and by nothing else. The POSIX
    launcher's share of this ground -- the same verdict contract, driven end to
    end against a stub engine -- is covered by
    scripts/start-psilink-launcher.test.mjs, which runs on Linux CI.

    Run it through ci-resolution-tests.ps1 rather than Invoke-Pester directly:
    that script is what reports results as annotations, which is all the CI
    reader can see.
#>

BeforeAll {
    $launcherScript = (Resolve-Path (Join-Path $PSScriptRoot '..\windows-network-filedrop\Start-Psilink.ps1')).Path
    . $launcherScript -LoadFunctionsOnly

    # Its own name rather than the setup suite's Start-PowerShellChild: both
    # files run in one Pester invocation, and two helpers sharing a name would
    # give the pair a load order that neither should acquire.
    function Start-LauncherChild {
        <#  Run powershell.exe and return its exit code and both streams.

            $PSHOME rather than the bare name, and a temporary file rather than
            the console for standard input, so that a guard which failed and let
            the flow reach a prompt ends the run rather than blocking it.
            -InputLines fills that file for a run that is meant to reach the
            prompts; a run given none still ends at the first one it reaches. #>
        param([string[]] $Arguments, [string[]] $InputLines = @(), [int] $TimeoutSeconds = 60)

        $outFile = [IO.Path]::GetTempFileName()
        $errFile = [IO.Path]::GetTempFileName()
        $inFile = [IO.Path]::GetTempFileName()
        try {
            if (@($InputLines).Count -gt 0) {
                Set-Content -LiteralPath $inFile -Value $InputLines -Encoding Ascii
            }
            $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
                -ArgumentList $Arguments -NoNewWindow -PassThru `
                -RedirectStandardInput $inFile `
                -RedirectStandardOutput $outFile -RedirectStandardError $errFile
            # Touch the handle before the wait: without it the Start-Process
            # wrapper can report ExitCode as null after a timed WaitForExit.
            try { $null = $process.Handle } catch { }
            $exited = $process.WaitForExit($TimeoutSeconds * 1000)
            if ($exited) { $process.WaitForExit() }
            if (-not $exited) {
                $process.Kill()
                $process.WaitForExit(10000) | Out-Null
            }
            $exitCode = $null
            if ($exited) { $exitCode = $process.ExitCode }
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

    function New-SmbConnectionFixture {
        param([string] $ServerName, [string] $ShareName)
        return [PSCustomObject]@{ ServerName = $ServerName; ShareName = $ShareName }
    }

    $script:StampedDigest = 'sha256:' + ('a1b2c3d4' * 8)
}

Describe 'The -LoadFunctionsOnly guard' {
    It 'defines the launcher functions and runs nothing else' {
        $command = ". '$launcherScript' -LoadFunctionsOnly; " +
            "if (Get-Command Read-DoctorVerdict -ErrorAction SilentlyContinue) { 'LOADED' }"
        $run = Start-LauncherChild -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command)

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
        # Exactly the one word: the flow announces itself with a banner before
        # it does anything, so any of it running shows up here.
        $stdout | Should -Be 'LOADED' -Because $shape
    }

    It 'leaves an ordinary run running the flow, which refuses this unstamped copy' {
        $run = Start-LauncherChild -Arguments @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$launcherScript`"")

        $run.TimedOut | Should -BeFalse
        $run.Output | Should -Match 'psilink console'
        # The copy in this repository carries the placeholder, so the flow must
        # stop before it reaches an engine at all.
        $run.Output | Should -Match 'did not come from a release'
        # A null exit must not satisfy "not zero": the guard would then pass
        # vacuously on the same helper fault the dot-source test catches.
        $run.Exit | Should -Not -BeNullOrEmpty
        $run.Exit | Should -Not -Be 0
    }
}

Describe 'The release stamp' {
    It 'refuses the placeholder this repository carries' {
        Test-PsilinkImageStamp | Should -BeFalse
        Test-PsilinkImageStamp -Digest '@@PSILINK_IMAGE_DIGEST@@' | Should -BeFalse
    }

    It 'accepts a real digest' {
        Test-PsilinkImageStamp -Digest $script:StampedDigest | Should -BeTrue
    }

    It 'refuses a digest that is the wrong length, algorithm, or case' {
        Test-PsilinkImageStamp -Digest ('sha256:' + ('ab' * 31)) | Should -BeFalse
        Test-PsilinkImageStamp -Digest ('sha512:' + ('ab' * 32)) | Should -BeFalse
        Test-PsilinkImageStamp -Digest ('sha256:' + ('AB' * 32)) | Should -BeFalse
        Test-PsilinkImageStamp -Digest '' | Should -BeFalse
    }

    It 'names the registry in the reference it builds' {
        # podman requires the registry prefix and docker accepts it, so the
        # reference is fully qualified rather than relying on a default.
        Get-PsilinkImage | Should -BeLike 'docker.io/vdorie/psi-link@*'
    }
}

Describe 'Read-DoctorVerdict' {
    It 'reads a version 1 verdict and its overall value' {
        $verdict = Read-DoctorVerdict -Json '{"version":1,"mode":"mount","overall":"ok","checks":[]}'

        $verdict.Ok | Should -BeTrue
        $verdict.Overall | Should -Be 'ok'
    }

    It 'refuses a version it does not know rather than parsing on' {
        $verdict = Read-DoctorVerdict -Json '{"version":2,"mode":"mount","overall":"ok","checks":[]}'

        $verdict.Ok | Should -BeFalse
        $verdict.Reason | Should -Match 'version 2'
    }

    It 'refuses a document carrying no version at all' {
        $verdict = Read-DoctorVerdict -Json '{"mode":"mount","overall":"ok","checks":[]}'

        $verdict.Ok | Should -BeFalse
        $verdict.Reason | Should -Match 'no version'
    }

    It 'reads each of the three overall values' {
        foreach ($value in @('ok', 'fix_and_retry', 'fatal')) {
            $verdict = Read-DoctorVerdict -Json "{`"version`":1,`"mode`":`"mount`",`"overall`":`"$value`",`"checks`":[]}"
            $verdict.Ok | Should -BeTrue -Because $value
            $verdict.Overall | Should -Be $value
        }
    }

    It 'refuses an overall value outside the closed vocabulary' {
        $verdict = Read-DoctorVerdict -Json '{"version":1,"mode":"mount","overall":"probably","checks":[]}'

        $verdict.Ok | Should -BeFalse
        $verdict.Reason | Should -Match 'probably'
    }

    It 'refuses a check status outside the closed vocabulary' {
        $verdict = Read-DoctorVerdict -Json '{"version":1,"mode":"mount","overall":"ok","checks":[{"id":"a","status":"maybe"}]}'

        $verdict.Ok | Should -BeFalse
        $verdict.Reason | Should -Match 'maybe'
    }

    It 'carries each check id, status, meaning and action' {
        $json = '{"version":1,"mode":"probe","overall":"fix_and_retry","checks":[' +
            '{"id":"tcp_445","status":"ok"},' +
            '{"id":"write","status":"fail","meaning":"cannot write here.","action":"ask for write permission."}]}'
        $verdict = Read-DoctorVerdict -Json $json

        $verdict.Ok | Should -BeTrue
        @($verdict.Checks).Count | Should -Be 2
        $failing = Select-DoctorChecks -Verdict $verdict -Status @('fail')
        @($failing).Count | Should -Be 1
        $failing[0].Id | Should -Be 'write'
        $failing[0].Meaning | Should -Be 'cannot write here.'
        $failing[0].Action | Should -Be 'ask for write permission.'
    }

    It 'reports an absent optional field as absent' {
        $verdict = Read-DoctorVerdict -Json '{"version":1,"mode":"mount","overall":"ok","checks":[{"id":"a","status":"ok"}]}'

        $verdict.Checks[0].Meaning | Should -BeNullOrEmpty
        $verdict.Checks[0].Action | Should -BeNullOrEmpty
    }

    It 'reports an explicit null as absent rather than as a value' {
        # The verdict omits what it has nothing to say about, so a null is a
        # document this does not understand rather than something to display.
        $verdict = Read-DoctorVerdict -Json '{"version":1,"mode":"mount","overall":"ok","checks":[{"id":"a","status":"warn","meaning":"x","action":null}]}'

        $verdict.Checks[0].Meaning | Should -Be 'x'
        $verdict.Checks[0].Action | Should -BeNullOrEmpty
    }

    It 'refuses a line that is not a verdict' {
        (Read-DoctorVerdict -Json 'docker: command not found').Ok | Should -BeFalse
        (Read-DoctorVerdict -Json '').Ok | Should -BeFalse
        (Read-DoctorVerdict -Json '   ').Ok | Should -BeFalse
    }

    It 'keeps prose that holds a brace, a comma and a quote intact' {
        $json = '{"version":1,"mode":"mount","overall":"fix_and_retry","checks":[' +
            '{"id":"write_rename","status":"fail","meaning":"a folder named \"q3,final\" {here} cannot be written.","action":"x"}]}'
        $verdict = Read-DoctorVerdict -Json $json

        $verdict.Checks[0].Meaning | Should -Be 'a folder named "q3,final" {here} cannot be written.'
    }
}

Describe 'Show-FromContainer' {
    It 'blanks a raw carriage return rather than letting it rewrite the line' {
        # A raw CR is not JSON-escaped prose -- the decoder never saw it -- so
        # it reaches the byte filter directly, and left alone it pulls the
        # cursor back over classified output already on the line.
        $records = Show-FromContainer -Text ('before' + [char]13 + 'after') 6>&1
        $text = @($records | ForEach-Object { [string] $_ }) -join ''

        $text | Should -Match 'before after'
        $text | Should -Not -Match ([string] [char]13)
    }
}

Describe 'Select-DoctorChecks' {
    BeforeAll {
        $script:Verdict = Read-DoctorVerdict -Json (
            '{"version":1,"mode":"mount","overall":"fix_and_retry","checks":[' +
            '{"id":"added_later","status":"ok"},' +
            '{"id":"marker","status":"warn","meaning":"a marker from another run.","action":"x"},' +
            '{"id":"write_rename","status":"fail","meaning":"m","action":"a"}]}')
    }

    It 'selects by status rather than by position' {
        # A check added to a mode appears as an extra entry, so a consumer keys
        # on ids and statuses rather than on where an entry sits.
        $selected = Select-DoctorChecks -Verdict $script:Verdict -Status @('fail', 'warn')

        @($selected).Count | Should -Be 2
        @($selected | ForEach-Object { $_.Id }) | Should -Be @('marker', 'write_rename')
    }

    It 'returns an empty array when nothing matches' {
        # Bare, an empty result unrolls to nothing, and "foreach ($x in $null)"
        # then runs its body once with a null -- printing a check that is not
        # there.
        $selected = Select-DoctorChecks -Verdict $script:Verdict -Status @('skipped')

        $selected -is [array] | Should -BeTrue -Because 'an empty result has to stay an array'
        @($selected).Count | Should -Be 0
    }
}

Describe 'Select-DfsCandidate' {
    It 'offers a single connection that is not the namespace''s own' {
        $connections = @(
            (New-SmbConnectionFixture -ServerName 'namespace' -ShareName 'dfs'),
            (New-SmbConnectionFixture -ServerName 'fs-04' -ShareName 'exchange'))

        $candidate = Select-DfsCandidate -Connections $connections -NamespaceServer 'namespace' -NamespaceShare 'dfs'

        $candidate.Outcome | Should -Be 'offer'
        $candidate.Server | Should -Be 'fs-04'
        $candidate.Share | Should -Be 'exchange'
    }

    It 'matches server and share together, never the server alone' {
        # Substituting only the server, keeping the namespace's share, produces
        # a device that cannot exist.
        $connections = @(
            (New-SmbConnectionFixture -ServerName 'namespace' -ShareName 'dfs'),
            (New-SmbConnectionFixture -ServerName 'namespace' -ShareName 'exchange$'))

        $candidate = Select-DfsCandidate -Connections $connections -NamespaceServer 'namespace' -NamespaceShare 'dfs'

        $candidate.Outcome | Should -Be 'offer'
        $candidate.Server | Should -Be 'namespace'
        $candidate.Share | Should -Be 'exchange$'
    }

    It 'falls back when the only connection is the namespace itself' {
        $connections = @((New-SmbConnectionFixture -ServerName 'namespace' -ShareName 'dfs'))

        (Select-DfsCandidate -Connections $connections -NamespaceServer 'namespace' -NamespaceShare 'dfs').Outcome |
            Should -Be 'none'
    }

    It 'falls back on an empty list, which is what a non-elevated session sees' {
        # Reading the connection list needs Administrator rights, and an
        # elevated window cannot see the drive letters the operator mapped as
        # themselves -- so the empty answer is the ordinary case, not the edge.
        (Select-DfsCandidate -Connections @() -NamespaceServer 'namespace' -NamespaceShare 'dfs').Outcome |
            Should -Be 'none'
        (Select-DfsCandidate -Connections $null -NamespaceServer 'namespace' -NamespaceShare 'dfs').Outcome |
            Should -Be 'none'
    }

    It 'falls back when several connections could be the one' {
        $connections = @(
            (New-SmbConnectionFixture -ServerName 'fs-04' -ShareName 'exchange'),
            (New-SmbConnectionFixture -ServerName 'fs-09' -ShareName 'projects'))

        $candidate = Select-DfsCandidate -Connections $connections -NamespaceServer 'namespace' -NamespaceShare 'dfs'

        $candidate.Outcome | Should -Be 'several'
        $candidate.Count | Should -Be 2
    }

    It 'ignores the IPC$ share every connection carries' {
        $connections = @(
            (New-SmbConnectionFixture -ServerName 'fs-04' -ShareName 'IPC$'),
            (New-SmbConnectionFixture -ServerName 'fs-04' -ShareName 'exchange'))

        $candidate = Select-DfsCandidate -Connections $connections -NamespaceServer 'namespace' -NamespaceShare 'dfs'

        $candidate.Outcome | Should -Be 'offer'
        $candidate.Share | Should -Be 'exchange'
    }

    It 'counts one server and share once however many connections name it' {
        $connections = @(
            (New-SmbConnectionFixture -ServerName 'fs-04' -ShareName 'exchange'),
            (New-SmbConnectionFixture -ServerName 'FS-04' -ShareName 'Exchange'))

        (Select-DfsCandidate -Connections $connections -NamespaceServer 'namespace' -NamespaceShare 'dfs').Outcome |
            Should -Be 'offer'
    }
}

Describe 'Get-ScriptParameterName' {
    It 'reads the parameter names out of the script beside this one' {
        # What the launcher protects itself with across the dot-source: the
        # names come from the two param() blocks rather than from a list.
        $names = Get-ScriptParameterName -Path (Join-Path (Split-Path -Parent $launcherScript) 'Setup-PsilinkFileDrop.ps1')

        $names | Should -Contain 'VolumeName'
        $names | Should -Contain 'Server'
        $names | Should -Contain 'LoadFunctionsOnly'
    }

    It 'reads its own' {
        $names = Get-ScriptParameterName -Path $launcherScript

        $names | Should -Contain 'VolumeName'
        $names | Should -Contain 'Port'
        # Common parameters belong to CmdletBinding rather than to the param()
        # block, and neither script's flow has a variable of its own to protect
        # from them.
        $names | Should -Not -Contain 'Verbose'
    }
}

Describe 'The engine wrappers' {
    It 'answers a name that is not a command without borrowing an earlier code' {
        # A native command run first, leaving a 0 in $LASTEXITCODE, so that the
        # answers below cannot have been taken from there -- a 0 would read as
        # an engine that ran and was happy. What such a call does without the
        # guard, raise rather than answer, has a case of its own in the setup
        # script's suite.
        & cmd /c exit 0

        $quiet = Invoke-EngineQuiet -Engine 'psilink-no-such-engine' -EngineArgs @('version')
        $captured = Invoke-EngineCapture -Engine 'psilink-no-such-engine' -EngineArgs @('version')

        $quiet.Ran | Should -Be $false
        $quiet.ExitCode | Should -Not -Be 0
        $quiet.Output | Should -Match 'psilink-no-such-engine'
        $captured.Ran | Should -Be $false
        $captured.ExitCode | Should -Not -Be 0
        $captured.Output | Should -Match 'psilink-no-such-engine'
    }

    It 'reports an empty engine name the same way' {
        # The name is empty until Find-ContainerEngine has chosen one.
        & cmd /c exit 0

        (Invoke-EngineQuiet -Engine '' -EngineArgs @('version')).Ran | Should -Be $false
        (Invoke-EngineCapture -Engine '' -EngineArgs @('version')).ExitCode | Should -Not -Be 0
    }

    It 'skips an engine that is not there rather than choosing it' {
        Find-ContainerEngine -Candidates @('psilink-no-such-engine') | Should -BeNullOrEmpty
    }
}

Describe 'The console argument vector' {
    It 'publishes to host loopback and keeps nothing' {
        $engineArgs = Get-ConsoleEngineArgs -ContainerName 'psilink-console-1' -ConsolePort 3000 `
            -DataMount 'C:\work'

        # The publish binding is the console's whole reachability control: the
        # job API carries no authentication.
        $engineArgs | Should -Contain '127.0.0.1:3000:3000'
        $engineArgs | Should -Contain '--rm'
        $engineArgs | Should -Contain 'JOB_DATA_ROOT=/data'
        $engineArgs | Should -Contain 'C:\work:/data'
        $engineArgs[-1] | Should -Be 'serve'
    }

    It 'leaves the input and rendezvous mounts out of a single-folder console' {
        $engineArgs = Get-ConsoleEngineArgs -ContainerName 'psilink-console-1' -ConsolePort 3000 `
            -DataMount 'C:\work'

        ($engineArgs -join ' ') | Should -Not -Match 'JOB_INPUT_DIR'
        ($engineArgs -join ' ') | Should -Not -Match 'JOB_RENDEZVOUS_DIR'
    }

    It 'mounts the split folders when they are given' {
        $engineArgs = Get-ConsoleEngineArgs -ContainerName 'psilink-console-1' -ConsolePort 8080 `
            -DataMount 'C:\work' -InputMount 'C:\input' -RendezvousMount 'psilink-sync'

        $engineArgs | Should -Contain '127.0.0.1:8080:3000'
        $engineArgs | Should -Contain 'JOB_INPUT_DIR=/input'
        $engineArgs | Should -Contain 'C:\input:/input'
        $engineArgs | Should -Contain 'JOB_RENDEZVOUS_DIR=/rendezvous'
        # A named volume mounts by name exactly as a host path does.
        $engineArgs | Should -Contain 'psilink-sync:/rendezvous'
    }

    It 'passes the shared folder name beside a rendezvous mount' {
        $engineArgs = Get-ConsoleEngineArgs -ContainerName 'psilink-console-1' -ConsolePort 3000 `
            -DataMount 'C:\work' -RendezvousMount 'psilink-sync' -RendezvousName 'agency-a-agency-b'

        $engineArgs | Should -Contain 'JOB_RENDEZVOUS_NAME=agency-a-agency-b'
    }

    It 'passes the shared folder name with no rendezvous mount at all' {
        # A single-folder console rendezvouses out of the data mount, which the
        # container sees as /data: the operator's folder still has a name.
        $engineArgs = Get-ConsoleEngineArgs -ContainerName 'psilink-console-1' -ConsolePort 3000 `
            -DataMount 'C:\work' -RendezvousName 'county-exchange'

        $engineArgs | Should -Contain 'JOB_RENDEZVOUS_NAME=county-exchange'
        ($engineArgs -join ' ') | Should -Not -Match 'JOB_RENDEZVOUS_DIR'
    }

    It 'passes an empty name when there is none to give' {
        $engineArgs = Get-ConsoleEngineArgs -ContainerName 'psilink-console-1' -ConsolePort 3000 `
            -DataMount 'C:\work'

        # The variable travels empty rather than being left out: an omitted one
        # has the console name the folder after the mount point THIS script
        # picked, and mint that as the name the partner is told to look for.
        $engineArgs | Should -Contain 'JOB_RENDEZVOUS_NAME='
    }

    It 'passes an empty name for a drive root, through the name it derives' {
        # The whole path the launcher takes for a folder it cannot name, driven
        # end to end: the drive root reduces to no name, and that is what reaches
        # the vector.
        $engineArgs = Get-ConsoleEngineArgs -ContainerName 'psilink-console-1' -ConsolePort 3000 `
            -DataMount 'D:\' -RendezvousName (Get-RendezvousFolderName -Path 'D:\')

        $engineArgs | Should -Contain 'JOB_RENDEZVOUS_NAME='
        ($engineArgs -join ' ') | Should -Not -Match 'JOB_RENDEZVOUS_NAME=\S'
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

Describe 'The network flow, driven against a stub engine' {
    BeforeAll {
        $script:FlowRoot = Join-Path $env:TEMP ('psilink-launcher-flow-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        $script:FlowBin = Join-Path $script:FlowRoot 'bin'
        $script:FlowStub = Join-Path $script:FlowRoot 'stub'
        $script:FlowData = Join-Path $script:FlowRoot 'data'
        foreach ($directory in @($script:FlowRoot, $script:FlowBin, $script:FlowStub, $script:FlowData)) {
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
        }
        $script:FlowCalls = Join-Path $script:FlowStub 'calls.log'

        # An engine that records the argument vector it is handed and answers
        # every doctor battery with a verdict that blocks nothing. A .cmd rather
        # than something this session could run itself: the launcher reaches its
        # engine as a native command, and the exit code and the merged streams
        # it reads back are properties of that.
        Set-Content -LiteralPath (Join-Path $script:FlowBin 'docker.cmd') -Encoding Ascii -Value @(
            '@echo off',
            'echo %* >> "%PSILINK_STUB_DIR%\calls.log"',
            'echo %* | findstr /c:"doctor" >nul',
            'if not errorlevel 1 echo {"version":1,"mode":"mount","overall":"ok","checks":[]}',
            'exit /b 0')

        # The launcher refuses to run unstamped, so the copy under test carries
        # a digest. The setup script travels with it: the launcher requires one
        # beside itself, and the dot-source of it is what this drives.
        $source = Get-Content -Raw -LiteralPath $launcherScript
        $placeholderLine = "`$PsilinkImageDigest = '@@PSILINK_IMAGE_DIGEST@@'"
        $stamped = $source.Replace($placeholderLine, "`$PsilinkImageDigest = '$script:StampedDigest'")
        if ($stamped -eq $source) { throw 'the launcher no longer carries the digest line this suite stamps' }
        $script:FlowLauncher = Join-Path $script:FlowRoot 'Start-Psilink.ps1'
        [IO.File]::WriteAllText($script:FlowLauncher, $stamped)

        # The credential prompt is the one part of the flow that cannot be
        # driven, which the case below holds as a check: it reads the console
        # rather than a redirected standard input. The copy beside the launcher
        # answers it from a definition of its own and is otherwise the script
        # itself -- the param() block whose collision this drives is the real
        # one, and so are the resolution and volume sequences.
        $setupScript = Join-Path (Split-Path -Parent $launcherScript) 'Setup-PsilinkFileDrop.ps1'
        $setupSource = Get-Content -Raw -LiteralPath $setupScript
        $guardLine = "if (`$LoadFunctionsOnly) { return }"
        $answeredCredential = @(
            'function Read-ShareCredential {',
            "    return @{ Username = 'psilinkci'; Domain = ''; Password = 'hunter2' }",
            '}',
            '') -join [Environment]::NewLine
        $patched = $setupSource.Replace($guardLine, $answeredCredential + $guardLine)
        if ($patched -eq $setupSource) { throw 'the setup script no longer carries the guard line this suite patches' }
        [IO.File]::WriteAllText((Join-Path $script:FlowRoot 'Setup-PsilinkFileDrop.ps1'), $patched)

        # Something has to answer on the console's port for the flow to reach
        # its end: the stub engine exits rather than holding one open.
        $script:FlowListener = New-Object -TypeName Net.Sockets.TcpListener `
            -ArgumentList ([Net.IPAddress]::Loopback, 0)
        $script:FlowListener.Start()
        $script:FlowPort = ([Net.IPEndPoint] $script:FlowListener.LocalEndpoint).Port
    }

    AfterAll {
        if ($script:FlowListener) { $script:FlowListener.Stop() }
        Remove-Item -LiteralPath $script:FlowRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'reads an ordinary prompt from a redirected standard input' {
        # The premise the flow below is driven on: a prompt this suite could not
        # answer would hang a launcher that is behaving perfectly.
        $probe = Join-Path $script:FlowRoot 'probe-prompt.ps1'
        Set-Content -LiteralPath $probe -Encoding Ascii -Value @(
            '$ErrorActionPreference = ''Stop''',
            '$answer = Read-Host ''Answer''',
            'Write-Output ("READ:" + $answer)')

        $run = Start-LauncherChild -Arguments @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$probe`"") `
            -InputLines @('psilinkci') -TimeoutSeconds 60

        $run.TimedOut | Should -BeFalse
        ([string] $run.Output) | Should -Match 'READ:psilinkci'
    }

    It 'cannot read a password prompt from a redirected standard input' {
        # Why the copy of the setup script under test answers the credential
        # prompt from a definition of its own: -AsSecureString reads the console
        # itself, so a redirected standard input answers nothing and the run
        # waits. Held as a check rather than stated in a comment, so that a
        # Windows PowerShell which does read it fails here rather than leaving
        # the flow test carrying a substitution nobody needs.
        $probe = Join-Path $script:FlowRoot 'probe-password.ps1'
        Set-Content -LiteralPath $probe -Encoding Ascii -Value @(
            '$ErrorActionPreference = ''Stop''',
            '$secure = Read-Host ''Password'' -AsSecureString',
            'Write-Output ("READ:" + $secure.Length)')

        $run = Start-LauncherChild -Arguments @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$probe`"") `
            -InputLines @('hunter2') -TimeoutSeconds 20

        $run.TimedOut | Should -BeTrue
        ([string] $run.Output) | Should -Not -Match 'READ:'
    }

    It 'carries -VolumeName through the dot-source to every later use of it' {
        # The launcher dot-sources the setup script for its resolution,
        # credential and volume sequences, and that runs the setup script's own
        # param() block in the launcher's scope. What the operator typed here
        # has to survive it.
        $volumeName = 'psilinkci-' + [guid]::NewGuid().ToString('N').Substring(0, 8)

        $originalPath = $env:PATH
        $originalStubDir = $env:PSILINK_STUB_DIR
        try {
            # The stub first and nothing else that could answer behind it: a
            # runner with a real engine installed must not be reached by this.
            $env:PATH = @($script:FlowBin,
                (Join-Path $env:SystemRoot 'System32'),
                $env:SystemRoot,
                (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')) -join ';'
            $env:PSILINK_STUB_DIR = $script:FlowStub
            $run = Start-LauncherChild -Arguments @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$script:FlowLauncher`"",
                '-DataRoot', "`"$script:FlowData`"",
                '-RendezvousDir', '\\psilink-ci-server\exchange\drop',
                '-VolumeName', $volumeName,
                '-Port', $script:FlowPort,
                '-NoBrowser') `
                -InputLines @('y', '', '', '') -TimeoutSeconds 150
        } finally {
            $env:PATH = $originalPath
            if ($null -eq $originalStubDir) {
                Remove-Item 'env:PSILINK_STUB_DIR' -ErrorAction SilentlyContinue
            } else {
                $env:PSILINK_STUB_DIR = $originalStubDir
            }
        }

        $calls = ''
        if (Test-Path -LiteralPath $script:FlowCalls) {
            $calls = [string] (Get-Content -LiteralPath $script:FlowCalls -Raw)
        }
        $output = [string] $run.Output
        # The failure annotation is the only diagnostic that leaves the runner,
        # so every assertion below carries the run's shape and its tail.
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) calls=$(@($calls -split '\r?\n').Count) tail=" +
            (($output.Substring([Math]::Max(0, $output.Length - 300))) -replace '\s+', ' ')

        $run.TimedOut | Should -BeFalse -Because $shape
        $output | Should -Match 'The console is at' -Because $shape

        $created = @($calls -split '\r?\n' | Where-Object { $_ -like '*volume create*' }) -join ' :: '
        $checked = @($calls -split '\r?\n' | Where-Object { $_ -like '*doctor mount*' }) -join ' :: '
        $served = @($calls -split '\r?\n' | Where-Object { $_ -like '*serve*' }) -join ' :: '

        $created | Should -BeLike "*$volumeName*" -Because $shape
        $checked | Should -BeLike "*--volume ${volumeName}:/rz*" -Because $shape
        $served | Should -BeLike "*--volume ${volumeName}:/rendezvous*" -Because $shape
        $output | Should -BeLike "*volume rm $volumeName*" -Because $shape

        # The setup script's default for the same parameter name, which its
        # param() block puts in place of what the operator typed.
        $calls | Should -Not -BeLike '*psilink-sync*' -Because $shape
        $output | Should -Not -BeLike '*psilink-sync*' -Because $shape
    }
}
