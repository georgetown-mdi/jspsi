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

    # The shape the launcher itself runs in: it reaches the setup script's path
    # resolution, and its rule for naming a folder within a share, through this
    # same dot-source rather than carrying a second copy of either. The two
    # scripts share no function name, so neither redefines the other's.
    $setupScriptForLauncher = (Resolve-Path (Join-Path $PSScriptRoot '..\windows-network-filedrop\Setup-PsilinkFileDrop.ps1')).Path
    . $setupScriptForLauncher -LoadFunctionsOnly

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

Describe 'Read-YesNo' {
    It 'takes the answers it knows, whatever their case' {
        # A child run rather than this session: every answer has to come from a
        # prompt, which is the thing under test. That a redirected standard
        # input answers one is held by a case in the flow suite below.
        $command = ". '$launcherScript' -LoadFunctionsOnly; " +
            "`$said = @(); " +
            "foreach (`$n in 1..8) { `$said += [string] (Read-YesNo -Prompt 'q' -DefaultYes) }; " +
            "'SAID:' + (`$said -join ',')"
        $run = Start-LauncherChild -Arguments @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command) `
            -InputLines @('y', 'Y', 'yes', 'YES', 'n', 'N', 'no', ' No ')

        $stdout = ([string] $run.Output).Trim()
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) out=$($stdout -replace '\s+', ' ')"
        $run.TimedOut | Should -BeFalse -Because $shape
        $stdout | Should -Match 'SAID:True,True,True,True,False,False,False,False' -Because $shape
    }

    It 'takes a blank answer as the default the prompt capitalises' {
        $command = ". '$launcherScript' -LoadFunctionsOnly; " +
            "'SAID:' + [string] (Read-YesNo -Prompt 'q' -DefaultYes) + " +
            "',' + [string] (Read-YesNo -Prompt 'q')"
        $run = Start-LauncherChild -Arguments @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command) `
            -InputLines @('', '   ')

        $stdout = ([string] $run.Output).Trim()
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) out=$($stdout -replace '\s+', ' ')"
        $run.TimedOut | Should -BeFalse -Because $shape
        $stdout | Should -Match 'SAID:True,False' -Because $shape
    }

    It 'puts the question again until the answer is one it knows' {
        # The whole reason this reader exists: a word meaning no, and a
        # keystroke meaning nothing, are neither of them the default.
        $command = ". '$launcherScript' -LoadFunctionsOnly; " +
            "'SAID:' + [string] (Read-YesNo -Prompt 'q' -DefaultYes)"
        $run = Start-LauncherChild -Arguments @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command) `
            -InputLines @('B', 'maybe', 'n')

        $stdout = ([string] $run.Output).Trim()
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) out=$($stdout -replace '\s+', ' ')"
        $run.TimedOut | Should -BeFalse -Because $shape
        $stdout | Should -Match 'SAID:False' -Because $shape
        # Once per answer it could not read.
        @([regex]::Matches($stdout, 'Answer y or n')).Count | Should -Be 2 -Because $shape
    }

    It 'answers as the setup script''s reader does, over every answer' {
        # The launcher asks its questions with a reader of its own so that a run
        # which could not load the setup script can still ask one, and this is
        # what holds that copy to Read-YesNoAnswer, the rule it copies: an edit
        # to either that the other did not get fails here.
        $answers = @('', '   ', 'y', 'Y', 'yes', 'YES', ' y ', 'n', 'N', 'no', 'NO', ' n ')
        $command = ". '$launcherScript' -LoadFunctionsOnly; " +
            ". '$setupScriptForLauncher' -LoadFunctionsOnly; " +
            "`$said = @(); " +
            "foreach (`$n in 1..$($answers.Count)) { `$said += " +
            "([string] (Read-YesNo -Prompt 'q' -DefaultYes) + '/' + " +
            "[string] (Read-YesNoAnswer -Prompt 'q' -DefaultYes)) }; " +
            "'SAID:' + (`$said -join ',')"
        # Each answer twice: one reader is asked, then the other, and the pair
        # is what the case compares.
        $lines = @()
        foreach ($answer in $answers) { $lines += $answer; $lines += $answer }
        $run = Start-LauncherChild -Arguments @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command) -InputLines $lines

        $stdout = ([string] $run.Output).Trim()
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) out=$($stdout -replace '\s+', ' ')"
        $run.TimedOut | Should -BeFalse -Because $shape
        $said = ''
        if ($stdout -match 'SAID:(\S+)') { $said = $Matches[1] }
        $said | Should -Not -BeNullOrEmpty -Because $shape
        @($said -split ',').Count | Should -Be $answers.Count -Because $shape
        foreach ($pair in ($said -split ',')) {
            $halves = $pair -split '/'
            $halves[0] | Should -Be $halves[1] -Because "[$pair] $shape"
        }
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

    It 'reaches a pair on one share through one mount and a path for each' {
        # The shape a pair on one share takes: one volume over the folder that
        # holds both, and each folder named as a path within it.
        $engineArgs = Get-ConsoleEngineArgs -ContainerName 'psilink-console-1' -ConsolePort 3000 `
            -DataMount 'C:\work' -RendezvousMount 'psilink-sync' `
            -RendezvousName 'from-clinic' -InboundLeg 'from-clinic' `
            -OutboundLeg 'to-clinic' -OutboundName 'to-clinic'

        $engineArgs | Should -Contain 'JOB_RENDEZVOUS_DIR=/rendezvous/from-clinic'
        $engineArgs | Should -Contain 'JOB_RENDEZVOUS_OUTBOUND_DIR=/rendezvous/to-clinic'
        $engineArgs | Should -Contain 'psilink-sync:/rendezvous'
        $engineArgs | Should -Contain 'JOB_RENDEZVOUS_NAME=from-clinic'
        $engineArgs | Should -Contain 'JOB_RENDEZVOUS_OUTBOUND_NAME=to-clinic'
        # One mount, so there is no second one to bind.
        ($engineArgs -join ' ') | Should -Not -Match ':/rendezvous-out'
    }

    It 'reaches a pair that cannot share a mount through two mounts' {
        $engineArgs = Get-ConsoleEngineArgs -ContainerName 'psilink-console-1' -ConsolePort 3000 `
            -DataMount 'C:\work' -RendezvousMount 'C:\drops\from-clinic' `
            -RendezvousName 'from-clinic' -OutboundMount 'psilink-sync-outbound' `
            -OutboundName 'to-clinic'

        $engineArgs | Should -Contain 'JOB_RENDEZVOUS_DIR=/rendezvous'
        $engineArgs | Should -Contain 'C:\drops\from-clinic:/rendezvous'
        $engineArgs | Should -Contain 'JOB_RENDEZVOUS_OUTBOUND_DIR=/rendezvous-out'
        $engineArgs | Should -Contain 'psilink-sync-outbound:/rendezvous-out'
        $engineArgs | Should -Contain 'JOB_RENDEZVOUS_OUTBOUND_NAME=to-clinic'
    }

    It 'leaves the outbound variables out of a console with one folder' {
        # The outbound directory variable is the console's only signal that a
        # pair is provisioned, so -- unlike the name -- it never travels empty:
        # an empty one would have the console refuse every shared-folder
        # exchange rather than run the single-folder one this is.
        $engineArgs = Get-ConsoleEngineArgs -ContainerName 'psilink-console-1' -ConsolePort 3000 `
            -DataMount 'C:\work' -RendezvousMount 'psilink-sync' -RendezvousName 'from-clinic'

        ($engineArgs -join ' ') | Should -Not -Match 'JOB_RENDEZVOUS_OUTBOUND_DIR'
        ($engineArgs -join ' ') | Should -Not -Match 'JOB_RENDEZVOUS_OUTBOUND_NAME'
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

Describe 'The mount a pair of folders shares' {
    BeforeAll {
        # Built through the setup script's own resolution rather than by hand,
        # so an edit to what it reports about a network path is an edit this
        # suite runs.
        function Resolve-Pair {
            param([string] $Inbound, [string] $Outbound)
            return @{
                Inbound  = (Resolve-DropPath -Raw $Inbound)
                Outbound = (Resolve-DropPath -Raw $Outbound)
            }
        }
    }

    It 'mounts the folder that holds both and names each folder within it' {
        $pair = Resolve-Pair '\\fileserver\exchange\clinic-study\from-clinic' `
            '\\fileserver\exchange\clinic-study\to-clinic'
        $plan = Resolve-SharedShareMount -Inbound $pair.Inbound -Outbound $pair.Outbound

        $plan.Shared | Should -BeTrue
        $plan.Server | Should -Be 'fileserver'
        $plan.Share | Should -Be 'exchange'
        $plan.SubPath | Should -Be 'clinic-study'
        $plan.InboundLeg | Should -Be 'from-clinic'
        $plan.OutboundLeg | Should -Be 'to-clinic'
    }

    It 'keeps the whole of a folder path that is more than one segment deep' {
        $pair = Resolve-Pair '\\fileserver\exchange\study\in\drop' `
            '\\fileserver\exchange\study\out\drop'
        $plan = Resolve-SharedShareMount -Inbound $pair.Inbound -Outbound $pair.Outbound

        $plan.SubPath | Should -Be 'study'
        $plan.InboundLeg | Should -Be 'in/drop'
        $plan.OutboundLeg | Should -Be 'out/drop'
    }

    It 'falls back to the share root when the two sit at the top of it' {
        # The case the guidance exists to avoid: the container then reaches the
        # whole share rather than one exchange folder.
        $pair = Resolve-Pair '\\fileserver\exchange\from-clinic' `
            '\\fileserver\exchange\to-clinic'
        $plan = Resolve-SharedShareMount -Inbound $pair.Inbound -Outbound $pair.Outbound

        $plan.Shared | Should -BeTrue
        $plan.SubPath | Should -BeNullOrEmpty
        $plan.InboundLeg | Should -Be 'from-clinic'
        $plan.OutboundLeg | Should -Be 'to-clinic'
    }

    It 'matches the shared part without case and reads either separator' {
        $pair = Resolve-Pair '//fileserver/exchange/Clinic-Study/from-clinic' `
            '\\FILESERVER\Exchange\clinic-study\to-clinic'
        $plan = Resolve-SharedShareMount -Inbound $pair.Inbound -Outbound $pair.Outbound

        $plan.Shared | Should -BeTrue
        $plan.InboundLeg | Should -Be 'from-clinic'
        $plan.OutboundLeg | Should -Be 'to-clinic'
    }

    It 'gives no shared mount for two shares on one server' {
        $pair = Resolve-Pair '\\fileserver\inbound\drop' '\\fileserver\outbound\drop'
        (Resolve-SharedShareMount -Inbound $pair.Inbound -Outbound $pair.Outbound).Shared |
            Should -BeFalse
    }

    It 'gives no shared mount for two servers' {
        $pair = Resolve-Pair '\\fileserver-a\exchange\in' '\\fileserver-b\exchange\out'
        (Resolve-SharedShareMount -Inbound $pair.Inbound -Outbound $pair.Outbound).Shared |
            Should -BeFalse
    }

    It 'gives no shared mount when a folder is on this PC' {
        # A folder on this PC is bind-mounted as it stands, so there is no
        # volume for it to share.
        $network = Resolve-DropPath -Raw '\\fileserver\exchange\in'
        $local = @{ Kind = 'Local'; LocalPath = 'C:\drops\out' }

        (Resolve-SharedShareMount -Inbound $network -Outbound $local).Shared | Should -BeFalse
        (Resolve-SharedShareMount -Inbound $local -Outbound $network).Shared | Should -BeFalse
        (Resolve-SharedShareMount -Inbound $local -Outbound $local).Shared | Should -BeFalse
    }
}

Describe 'The credential a pair of folders on one server takes' {
    BeforeEach {
        # What a run starts from, so that no case here reads what another left:
        # the flow drops both once the volumes are made.
        $script:PsilinkShareCredential = $null
        $script:PsilinkShareCredentialServer = ''
        $script:CredentialAsks = 0
        $script:ReusePrompts = @()
        $script:VolumeUsers = @()
        $script:PsilinkEngine = 'docker'
    }

    It 'asks once for two shares of one server' {
        # The three things this function reaches that no session here can: the
        # password prompt reads the console rather than a redirect, and the
        # volume and the batteries reach the engine. What each is asked to do
        # is driven by the flow cases below against a stub engine; the
        # bookkeeping around them is what the cases here are for.
        function Read-ShareCredential {
            $script:CredentialAsks++
            return @{ Username = 'psilinkci'; Domain = ''; Password = 'hunter2' }
        }
        # As an empty answer is read: the question the second share asks
        # defaults to the answer already given.
        function Read-YesNo {
            param([string] $Prompt, [switch] $DefaultYes)
            $script:ReusePrompts += $Prompt
            return [bool] $DefaultYes
        }
        function New-ShareVolume { return $true }
        function Invoke-DoctorLoop { return $true }

        $inbound = New-RendezvousShareMount -VolumeName 'psilinkci-in' -Server 'fs-04' -Share 'exchange' `
            -Legs @(@{ Label = 'the folder your partner writes into'; Path = 'from-clinic' }) 6>&1
        $outbound = New-RendezvousShareMount -VolumeName 'psilinkci-out' -Server 'fs-04' -Share 'outbound' `
            -Legs @(@{ Label = 'the folder you write into'; Path = 'to-clinic' }) 6>&1
        $said = @(@($inbound) + @($outbound) | ForEach-Object { [string] $_ }) -join ' '

        $script:CredentialAsks | Should -Be 1 -Because $said
        @([regex]::Matches($said, 'Credentials for the file server')).Count | Should -Be 1 -Because $said
        # The second share names the share it is asking about, so the
        # operator can tell which one the answer would be used for.
        @($script:ReusePrompts).Count | Should -Be 1 -Because $said
        $script:ReusePrompts[0] | Should -Be 'Use the same credentials for \\fs-04\outbound? [Y/n]' -Because $said
        $script:PsilinkShareCredentialServer | Should -Be 'fs-04' -Because $said
    }

    It 'asks again when the operator declines reuse' {
        # Two shares of one server reached by different accounts: the
        # question is how the second account is given, and the answer the
        # volume is made from is the one just typed.
        function Read-ShareCredential {
            $script:CredentialAsks++
            return @{ Username = ('psilinkci' + $script:CredentialAsks); Domain = ''; Password = 'hunter2' }
        }
        function Read-YesNo {
            param([string] $Prompt, [switch] $DefaultYes)
            $script:ReusePrompts += $Prompt
            return $false
        }
        function New-ShareVolume {
            param($VolumeName, $Server, $Share, $SubPath, $Username, $Password, $Domain, $Engine)
            $script:VolumeUsers += $Username
            return $true
        }
        function Invoke-DoctorLoop { return $true }

        $inbound = New-RendezvousShareMount -VolumeName 'psilinkci-in' -Server 'fs-04' -Share 'exchange' `
            -Legs @(@{ Label = 'the folder your partner writes into'; Path = 'from-clinic' }) 6>&1
        $outbound = New-RendezvousShareMount -VolumeName 'psilinkci-out' -Server 'fs-04' -Share 'outbound' `
            -Legs @(@{ Label = 'the folder you write into'; Path = 'to-clinic' }) 6>&1
        $said = @(@($inbound) + @($outbound) | ForEach-Object { [string] $_ }) -join ' '

        $script:CredentialAsks | Should -Be 2 -Because $said
        @([regex]::Matches($said, 'Credentials for the file server')).Count | Should -Be 2 -Because $said
        @($script:ReusePrompts).Count | Should -Be 1 -Because $said
        (@($script:VolumeUsers) -join ' ') | Should -Be 'psilinkci1 psilinkci2' -Because $said
        $script:PsilinkShareCredential.Username | Should -Be 'psilinkci2' -Because $said
        $script:PsilinkShareCredentialServer | Should -Be 'fs-04' -Because $said
    }

    It 'asks for each of two servers' {
        function Read-ShareCredential {
            $script:CredentialAsks++
            return @{ Username = 'psilinkci'; Domain = ''; Password = 'hunter2' }
        }
        # Defined here as well as asserted below: a branch that reached it
        # would otherwise read the console, which this session has none of.
        function Read-YesNo {
            param([string] $Prompt, [switch] $DefaultYes)
            $script:ReusePrompts += $Prompt
            return $false
        }
        function New-ShareVolume { return $true }
        function Invoke-DoctorLoop { return $true }

        $inbound = New-RendezvousShareMount -VolumeName 'psilinkci-in' -Server 'fs-04' -Share 'exchange' `
            -Legs @(@{ Label = 'the folder your partner writes into'; Path = 'from-clinic' }) 6>&1
        $outbound = New-RendezvousShareMount -VolumeName 'psilinkci-out' -Server 'fs-09' -Share 'exchange' `
            -Legs @(@{ Label = 'the folder you write into'; Path = 'to-clinic' }) 6>&1
        $said = @(@($inbound) + @($outbound) | ForEach-Object { [string] $_ }) -join ' '

        $script:CredentialAsks | Should -Be 2 -Because $said
        @($script:ReusePrompts).Count | Should -Be 0 -Because $said
        $script:PsilinkShareCredentialServer | Should -Be 'fs-09' -Because $said
    }

    It 'drops both halves of the answer' {
        # The flow's own drop -- the finally around Part 2 and the call
        # before each exit within it -- runs in a child process whose script
        # scope no case here can read, so what is held here is that the drop
        # clears both the credential and the server it was given for.
        $script:PsilinkShareCredential = @{ Username = 'psilinkci'; Domain = ''; Password = 'hunter2' }
        $script:PsilinkShareCredentialServer = 'fs-04'

        Clear-ShareCredential

        $script:PsilinkShareCredential | Should -BeNullOrEmpty
        $script:PsilinkShareCredentialServer | Should -BeNullOrEmpty
    }

    AfterAll {
        # Left as the session found it: no engine, and no answer held for one.
        $script:PsilinkEngine = ''
        $script:PsilinkShareCredential = $null
        $script:PsilinkShareCredentialServer = ''
    }
}

Describe 'Join-SharePath' {
    It 'joins the two parts with the separator a share takes' {
        Join-SharePath -Parent 'clinic-study' -Child 'from-clinic' |
            Should -Be 'clinic-study/from-clinic'
    }

    It 'answers either part alone when the other is empty' {
        Join-SharePath -Parent '' -Child 'from-clinic' | Should -Be 'from-clinic'
        Join-SharePath -Parent 'clinic-study' -Child '' | Should -Be 'clinic-study'
        Join-SharePath -Parent '' -Child '' | Should -BeNullOrEmpty
    }
}

Describe 'The pair of folders an exchange over two folders needs' {
    It 'accepts two folders side by side' {
        $verdict = Test-RendezvousPair -InboundPath '\\fileserver\exchange\study\from-clinic' `
            -OutboundPath '\\fileserver\exchange\study\to-clinic' `
            -InboundName 'from-clinic' -OutboundName 'to-clinic'

        $verdict.Usable | Should -BeTrue
    }

    It 'refuses one folder given twice, however it was written' {
        # Either separator, a trailing one, and a different case are all the
        # same folder to the file server.
        foreach ($outbound in @('\\fileserver\exchange\drop', '//fileserver/exchange/drop',
                '\\fileserver\exchange\drop\', '\\FILESERVER\Exchange\DROP')) {
            $verdict = Test-RendezvousPair -InboundPath '\\fileserver\exchange\drop' `
                -OutboundPath $outbound -InboundName 'drop' -OutboundName 'drop'
            $verdict.Usable | Should -BeFalse -Because "[$outbound]"
            $verdict.Remedy | Should -Not -BeNullOrEmpty -Because "[$outbound]"
        }
    }

    It 'refuses a folder inside the other, whichever way round it is' {
        # This side would read its own writes back as the partner's.
        $inside = Test-RendezvousPair -InboundPath '\\fileserver\exchange\study' `
            -OutboundPath '\\fileserver\exchange\study\to-clinic' `
            -InboundName 'study' -OutboundName 'to-clinic'
        $outside = Test-RendezvousPair -InboundPath '\\fileserver\exchange\study\from-clinic' `
            -OutboundPath '\\fileserver\exchange\study' `
            -InboundName 'from-clinic' -OutboundName 'study'

        $inside.Usable | Should -BeFalse
        $inside.Reason | Should -Match 'inside'
        $outside.Usable | Should -BeFalse
        $outside.Reason | Should -Match 'inside'
    }

    It 'refuses a folder with no name of its own' {
        # A drive root and a share root reduce to no name, and an invitation
        # holds a name for each folder of a pair: the console can put a locator
        # on neither half, so it refuses every shared-folder exchange.
        $verdict = Test-RendezvousPair -InboundPath 'D:\' -OutboundPath 'C:\drops\to-clinic' `
            -InboundName (Get-LocalFolderName -Path 'D:\') -OutboundName 'to-clinic'

        $verdict.Usable | Should -BeFalse
        $verdict.Remedy | Should -Not -BeNullOrEmpty
    }

    It 'refuses two folders of the same name' {
        # The partner is given a name per folder and has to tell the two apart.
        $verdict = Test-RendezvousPair -InboundPath '\\fileserver\in\psilink' `
            -OutboundPath '\\fileserver\out\psilink' `
            -InboundName 'psilink' -OutboundName 'psilink'

        $verdict.Usable | Should -BeFalse
        $verdict.Reason | Should -Match 'psilink'
    }

    It 'keeps a folder on this PC apart from one on a share' {
        $verdict = Test-RendezvousPair -InboundPath 'C:\drops\from-clinic' `
            -OutboundPath '\\fileserver\exchange\to-clinic' `
            -InboundName 'from-clinic' -OutboundName 'to-clinic'

        $verdict.Usable | Should -BeTrue
    }

    It 'names a reason and a remedy on every refusal' {
        # The refusal is the whole of what the operator gets, so neither half of
        # it may be empty.
        foreach ($case in @(
                @{ In = 'C:\drops\x'; Out = 'C:\drops\x'; InName = 'x'; OutName = 'x' },
                @{ In = 'C:\drops'; Out = 'C:\drops\x'; InName = 'drops'; OutName = 'x' },
                @{ In = 'D:\'; Out = 'C:\drops\x'; InName = ''; OutName = 'x' },
                @{ In = 'C:\a\x'; Out = 'C:\b\x'; InName = 'x'; OutName = 'x' })) {
            $verdict = Test-RendezvousPair -InboundPath $case.In -OutboundPath $case.Out `
                -InboundName $case.InName -OutboundName $case.OutName
            $verdict.Usable | Should -BeFalse -Because "[$($case.In) | $($case.Out)]"
            $verdict.Reason | Should -Not -BeNullOrEmpty -Because "[$($case.In) | $($case.Out)]"
            $verdict.Remedy | Should -Not -BeNullOrEmpty -Because "[$($case.In) | $($case.Out)]"
        }
    }
}

Describe 'A folder as the correction from the DFS tab leaves it' {
    It 'rebuilds the full path from the server and share confirmed' {
        $corrected = Get-CorrectedShareTarget -Resolved (
            Resolve-DropPath -Raw '\\namespace\dfs\clinic-study\from-clinic') `
            -Server 'fs-04' -Share 'exchange'

        $corrected.Server | Should -Be 'fs-04'
        $corrected.Share | Should -Be 'exchange'
        $corrected.Unc | Should -Be '\\fs-04\exchange'
        $corrected.SubPath | Should -Be 'clinic-study/from-clinic'
        $corrected.Full | Should -Be '\\fs-04\exchange\clinic-study\from-clinic'
    }

    It 'gives a folder on this PC back as it stands' {
        $local = Get-CorrectedShareTarget -Resolved @{ Kind = 'Local'; LocalPath = 'C:\drops\to-clinic' } `
            -Server 'fs-04' -Share 'exchange'

        $local.Kind | Should -Be 'Local'
        $local.LocalPath | Should -Be 'C:\drops\to-clinic'
    }

    It 'names a folder that is a share root after the share it was corrected to' {
        # The name the console mints into the invitation: a folder that IS the
        # share root takes the share's name, so a leg left at the namespace
        # would give the partner a name for a share that holds nothing of
        # theirs.
        $corrected = Get-CorrectedShareTarget -Resolved (Resolve-DropPath -Raw '\\namespace\from-clinic') `
            -Server 'fs-04' -Share 'exchange'

        Get-RendezvousFolderName -Share $corrected.Share -SubPath $corrected.SubPath |
            Should -Be 'exchange'
    }

    It 'refuses a pair the corrections put on one real folder' {
        # Two paths that named two folders, and one folder behind both: the
        # check before the console starts is held against the corrected paths,
        # or it passes a console that refuses every exchange.
        $before = Test-RendezvousPair -InboundPath '\\namespace\from-clinic' `
            -OutboundPath '\\fs-04\exchange' -InboundName 'from-clinic' -OutboundName 'exchange'
        $before.Usable | Should -BeTrue -Because 'the paths as typed name two folders'

        $inbound = Get-CorrectedShareTarget -Resolved (Resolve-DropPath -Raw '\\namespace\from-clinic') `
            -Server 'fs-04' -Share 'exchange'
        $outbound = Get-CorrectedShareTarget -Resolved (Resolve-DropPath -Raw '\\fs-04\exchange') `
            -Server 'fs-04' -Share 'exchange'
        $verdict = Test-RendezvousPair `
            -InboundPath (Get-ComparableFolderPath -Resolved $inbound) `
            -OutboundPath (Get-ComparableFolderPath -Resolved $outbound) `
            -InboundName (Get-RendezvousFolderName -Share $inbound.Share -SubPath $inbound.SubPath) `
            -OutboundName (Get-RendezvousFolderName -Share $outbound.Share -SubPath $outbound.SubPath)

        $verdict.Usable | Should -BeFalse
        $verdict.Reason | Should -Match 'same folder'
    }

    It 'refuses a pair a correction puts one inside the other' {
        $inbound = Get-CorrectedShareTarget -Resolved (
            Resolve-DropPath -Raw '\\namespace\dfs\from-clinic') -Server 'fs-04' -Share 'exchange'
        $outbound = Resolve-DropPath -Raw '\\fs-04\exchange'
        $verdict = Test-RendezvousPair `
            -InboundPath (Get-ComparableFolderPath -Resolved $inbound) `
            -OutboundPath (Get-ComparableFolderPath -Resolved $outbound) `
            -InboundName (Get-RendezvousFolderName -Share $inbound.Share -SubPath $inbound.SubPath) `
            -OutboundName (Get-RendezvousFolderName -Share $outbound.Share -SubPath $outbound.SubPath)

        $verdict.Usable | Should -BeFalse
        $verdict.Reason | Should -Match 'inside the other'
    }
}

Describe 'The volumes a run made, named on the way out' {
    It 'names every volume and the command that removes them' {
        $records = Show-VolumeRemoval -VolumeNames @('psilink-sync', 'psilink-sync-outbound') 6>&1
        $text = @($records | ForEach-Object { [string] $_ }) -join ' '

        $text | Should -Match 'cleartext in each volume''s'
        $text | Should -Match 'volume inspect psilink-sync psilink-sync-outbound'
        $text | Should -Match 'volume rm psilink-sync psilink-sync-outbound'
    }

    It 'reads one volume in the singular' {
        $records = Show-VolumeRemoval -VolumeNames @('psilink-sync') 6>&1
        $text = @($records | ForEach-Object { [string] $_ }) -join ' '

        $text | Should -Match 'cleartext in the volume''s'
        $text | Should -Match 'volume rm psilink-sync'
    }

    It 'prints nothing for a run that made none' {
        $records = Show-VolumeRemoval -VolumeNames @() 6>&1
        $text = @($records | ForEach-Object { [string] $_ }) -join ''

        $text | Should -BeNullOrEmpty
    }
}

Describe 'The name the launcher gives a folder on this PC' {
    It 'names a folder by its own last segment' {
        Get-LocalFolderName -Path 'C:\Users\dana\Egnyte\agency-a-agency-b' |
            Should -Be 'agency-a-agency-b'
    }

    It 'ignores a trailing separator, and reads either one' {
        Get-LocalFolderName -Path 'C:\drops\studyA\' | Should -Be 'studyA'
        Get-LocalFolderName -Path 'C:/drops/studyA' | Should -Be 'studyA'
    }

    It 'gives no name for a drive root, which has none' {
        # Naming it 'D:' would ask the partner to match a drive letter that means
        # nothing on their machine; the console degrades to no name instead.
        Get-LocalFolderName -Path 'D:\' | Should -BeNullOrEmpty
        Get-LocalFolderName -Path 'D:' | Should -BeNullOrEmpty
    }

    It 'gives no name for a path it could read no segment out of' {
        Get-LocalFolderName -Path '' | Should -BeNullOrEmpty
        Get-LocalFolderName -Path '\' | Should -BeNullOrEmpty
    }

    It 'answers the same in a constrained language mode' {
        # The other run that reaches the console without the setup script's
        # functions: an application-control policy has left the session in
        # ConstrainedLanguage, and the launcher does not attempt the dot-source
        # there at all. The mode is set here rather than by a policy this suite
        # could impose, so what this holds is the half that is the launcher's
        # own -- that naming a folder is nothing a constrained session refuses.
        $command = "`$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; " +
            ". '$launcherScript' -LoadFunctionsOnly; " +
            "'NAME:' + (Get-LocalFolderName -Path 'C:\drops\studyA\') + " +
            "':' + (Get-LocalFolderName -Path 'D:\') + ':END'"
        $run = Start-LauncherChild -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command)

        $stdout = ([string] $run.Output).Trim()
        $stderr = ([string] $run.Errors).Trim()
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) " +
            "err=$($stderr -replace '\s+', ' ')"
        $run.TimedOut | Should -BeFalse -Because $shape
        $stdout | Should -Be 'NAME:studyA::END' -Because $shape
    }

    It 'answers as the setup script''s rule does, over every shape a path takes' {
        # The launcher names a local folder itself so that a run which could not
        # load the setup script still gives the partner a name, and this is what
        # holds that copy to the rule it copies: both are dot-sourced above, and
        # an edit to either that the other did not get fails here.
        foreach ($path in @(
                'C:\Users\dana\Egnyte\agency-a-agency-b', 'C:\drops\studyA\',
                'C:/drops/studyA', 'C:\drops\\studyA', 'C:\drops\study A ',
                'C:\drops', 'C:\', 'D:\', 'D:', '', '\', '/', 'Z:\studyA',
                '\\server\exchange\agency-a\agency-b', '\\server\exchange',
                '\\?\C:\drops\x', 'relative\folder')) {
            $fromLauncher = Get-LocalFolderName -Path $path
            $fromSetupScript = Get-RendezvousFolderName -Path $path
            $fromLauncher | Should -Be $fromSetupScript -Because "[$path]"
        }
    }
}

Describe 'The launcher flow, driven against a stub engine' {
    BeforeAll {
        $script:FlowRoot = Join-Path $env:TEMP ('psilink-launcher-flow-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        $script:FlowBin = Join-Path $script:FlowRoot 'bin'
        $script:FlowStub = Join-Path $script:FlowRoot 'stub'
        $script:FlowData = Join-Path $script:FlowRoot 'data'
        # A call log of its own per flow case, so that what one run called is
        # read back whatever else in this file has run.
        $script:SplitStub = Join-Path $script:FlowRoot 'split-stub'
        $script:LocalStub = Join-Path $script:FlowRoot 'local-stub'
        $script:RefusalStub = Join-Path $script:FlowRoot 'refusal-stub'
        $script:TwoVolumeStub = Join-Path $script:FlowRoot 'two-volume-stub'
        $script:MountFailStub = Join-Path $script:FlowRoot 'mount-fail-stub'
        # A second stub engine, on a PATH entry of its own: the stub below
        # answers every battery the same way, and one case needs the checks
        # over a volume to fail while the ones before it pass.
        $script:MountFailBin = Join-Path $script:FlowRoot 'mount-fail-bin'
        $script:LocalInbound = Join-Path $script:FlowRoot 'from-clinic'
        $script:LocalOutbound = Join-Path $script:FlowRoot 'to-clinic'
        foreach ($directory in @($script:FlowRoot, $script:FlowBin, $script:FlowStub, $script:FlowData,
                $script:SplitStub, $script:LocalStub, $script:RefusalStub, $script:TwoVolumeStub,
                $script:MountFailStub, $script:MountFailBin,
                $script:LocalInbound, $script:LocalOutbound)) {
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
        }
        $script:FlowCalls = Join-Path $script:FlowStub 'calls.log'

        function Invoke-LauncherFlow {
            <#  One launcher run against the stub engine: the stub first on PATH
                and nothing else that could answer behind it, so a runner with a
                real engine installed is never reached. $BinDir names which stub
                engine answers, and defaults to the one that blocks nothing.
                Returns the run with the stub's call log read back on it. #>
            param(
                [Parameter(Mandatory = $true)][string] $Launcher,
                [Parameter(Mandatory = $true)][string] $StubDir,
                [string] $BinDir = '',
                [string[]] $Arguments = @(),
                [string[]] $InputLines = @(),
                [int] $TimeoutSeconds = 150
            )

            $engineDir = $BinDir
            if (-not $engineDir) { $engineDir = $script:FlowBin }

            $originalPath = $env:PATH
            $originalStubDir = $env:PSILINK_STUB_DIR
            try {
                $env:PATH = @($engineDir,
                    (Join-Path $env:SystemRoot 'System32'),
                    $env:SystemRoot,
                    (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')) -join ';'
                $env:PSILINK_STUB_DIR = $StubDir
                $run = Start-LauncherChild -Arguments (@(
                        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$Launcher`"") + $Arguments) `
                    -InputLines $InputLines -TimeoutSeconds $TimeoutSeconds
            } finally {
                $env:PATH = $originalPath
                if ($null -eq $originalStubDir) {
                    Remove-Item 'env:PSILINK_STUB_DIR' -ErrorAction SilentlyContinue
                } else {
                    $env:PSILINK_STUB_DIR = $originalStubDir
                }
            }

            $calls = ''
            $log = Join-Path $StubDir 'calls.log'
            if (Test-Path -LiteralPath $log) { $calls = [string] (Get-Content -LiteralPath $log -Raw) }
            $run['Calls'] = $calls
            return $run
        }

        function Get-FlowShape {
            <#  The run's shape and its tail, for a -Because: the failure
                annotation is the only diagnostic that leaves the runner. #>
            param($Run)

            $output = [string] $Run.Output
            return "timedout=$($Run.TimedOut) exit=$($Run.Exit) " +
                "calls=$(@(([string] $Run.Calls) -split '\r?\n').Count) tail=" +
                (($output.Substring([Math]::Max(0, $output.Length - 300))) -replace '\s+', ' ')
        }

        function Get-ConsoleCalls {
            <#  The recorded calls that started the console. 'serve' is matched
                as the last argument of the run, which 'The console argument
                vector' above holds, rather than anywhere in the line: the
                engine's own 'version --format {{.Server.Os}}' and a volume made
                for a file server both hold the word as text and start nothing. #>
            param([string] $Calls)

            return @($Calls -split '\r?\n' | ForEach-Object { $_.Trim() } |
                    Where-Object { $_ -and (($_ -split '\s+')[-1] -eq 'serve') })
        }

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

        # The same engine, except that the checks over a volume fail: the
        # share answers over the network and the volume is made, and only the
        # battery run through it says no. A fatal verdict rather than one to
        # retry, so the run stops where it is rather than prompting.
        Set-Content -LiteralPath (Join-Path $script:MountFailBin 'docker.cmd') -Encoding Ascii -Value @(
            '@echo off',
            'echo %* >> "%PSILINK_STUB_DIR%\calls.log"',
            'echo %* | findstr /c:"doctor mount" >nul',
            'if not errorlevel 1 goto :mount',
            'echo %* | findstr /c:"doctor" >nul',
            'if not errorlevel 1 echo {"version":1,"mode":"probe","overall":"ok","checks":[]}',
            'exit /b 0',
            ':mount',
            'echo {"version":1,"mode":"mount","overall":"fatal","checks":[]}',
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

        # A second copy with nothing beside it, and a stub log of its own so
        # that what it called is read back whatever else in this file has run.
        # The flow's other route past the setup script -- a constrained language
        # mode -- is an application-control policy this suite cannot impose over
        # a whole run, and both routes leave the flow on the same branch.
        $script:AloneRoot = Join-Path $script:FlowRoot 'alone'
        $script:AloneStub = Join-Path $script:AloneRoot 'stub'
        $script:AloneData = Join-Path $script:AloneRoot 'agency-a-agency-b'
        foreach ($directory in @($script:AloneRoot, $script:AloneStub, $script:AloneData)) {
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
        }
        $script:AloneCalls = Join-Path $script:AloneStub 'calls.log'
        $script:AloneLauncher = Join-Path $script:AloneRoot 'Start-Psilink.ps1'
        [IO.File]::WriteAllText($script:AloneLauncher, $stamped)

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
        $served = @(Get-ConsoleCalls -Calls $calls) -join ' :: '

        $created | Should -BeLike "*$volumeName*" -Because $shape
        $checked | Should -BeLike "*--volume ${volumeName}:/rz*" -Because $shape
        $served | Should -BeLike "*--volume ${volumeName}:/rendezvous*" -Because $shape
        $output | Should -BeLike "*volume rm $volumeName*" -Because $shape

        # The setup script's default for the same parameter name, which its
        # param() block puts in place of what the operator typed.
        $calls | Should -Not -BeLike '*psilink-sync*' -Because $shape
        $output | Should -Not -BeLike '*psilink-sync*' -Because $shape
    }

    It 'reaches a pair on one share through one volume over the folder above them' {
        # The whole of the network pair, driven end to end: one volume for the
        # folder that holds both, a folder named for each leg within it, and
        # each leg checked through the volume it will be reached by.
        $volumeName = 'psilinkci-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
        $run = Invoke-LauncherFlow -Launcher $script:FlowLauncher -StubDir $script:SplitStub `
            -Arguments @(
                '-DataRoot', "`"$script:FlowData`"",
                '-RendezvousDir', '\\psilink-ci-server\exchange\clinic-study\from-clinic',
                '-RendezvousOutboundDir', '\\psilink-ci-server\exchange\clinic-study\to-clinic',
                '-VolumeName', $volumeName,
                '-Port', $script:FlowPort,
                '-NoBrowser') `
            -InputLines @('y', '', '', '', '')

        $calls = [string] $run.Calls
        $output = [string] $run.Output
        $shape = Get-FlowShape -Run $run

        $run.TimedOut | Should -BeFalse -Because $shape
        $output | Should -Match 'The console is at' -Because $shape

        $created = @($calls -split '\r?\n' | Where-Object { $_ -like '*volume create*' }) -join ' :: '
        $probed = @($calls -split '\r?\n' | Where-Object { $_ -like '*doctor probe*' })
        $checked = @($calls -split '\r?\n' | Where-Object { $_ -like '*doctor mount*' }) -join ' :: '
        $served = @(Get-ConsoleCalls -Calls $calls) -join ' :: '

        # One volume, over the folder that holds both rather than over either.
        @($calls -split '\r?\n' | Where-Object { $_ -like '*volume create*' }).Count |
            Should -Be 1 -Because $shape
        $created | Should -BeLike '*device=//psilink-ci-server/exchange/clinic-study*' -Because $shape
        $created | Should -BeLike "*$volumeName*" -Because $shape

        # Each folder asked about over the share, then checked again through the
        # volume: the marker the first leaves is what the second looks for.
        $probed.Count | Should -Be 2 -Because $shape
        $checked | Should -BeLike '*doctor mount /rz/from-clinic*' -Because $shape
        $checked | Should -BeLike '*doctor mount /rz/to-clinic*' -Because $shape

        $served | Should -BeLike "*--volume ${volumeName}:/rendezvous *" -Because $shape
        $served | Should -BeLike '*JOB_RENDEZVOUS_DIR=/rendezvous/from-clinic*' -Because $shape
        $served | Should -BeLike '*JOB_RENDEZVOUS_OUTBOUND_DIR=/rendezvous/to-clinic*' -Because $shape
        $served | Should -BeLike '*JOB_RENDEZVOUS_NAME=from-clinic*' -Because $shape
        $served | Should -BeLike '*JOB_RENDEZVOUS_OUTBOUND_NAME=to-clinic*' -Because $shape

        # Nothing here removes the volume, so the closing screen has to name it.
        $output | Should -BeLike "*volume rm $volumeName*" -Because $shape
    }

    It 'reaches a pair of folders on this PC as two mounts' {
        # No share, so no volume and no credential: each folder is bind-mounted
        # as it stands and checked over that mount.
        $run = Invoke-LauncherFlow -Launcher $script:FlowLauncher -StubDir $script:LocalStub `
            -Arguments @(
                '-DataRoot', "`"$script:FlowData`"",
                '-RendezvousDir', "`"$script:LocalInbound`"",
                '-RendezvousOutboundDir', "`"$script:LocalOutbound`"",
                '-Port', $script:FlowPort,
                '-NoBrowser') `
            -InputLines @('', '')

        $calls = [string] $run.Calls
        $output = [string] $run.Output
        $shape = Get-FlowShape -Run $run

        $run.TimedOut | Should -BeFalse -Because $shape
        $output | Should -Match 'The console is at' -Because $shape

        $checked = @($calls -split '\r?\n' | Where-Object { $_ -like '*doctor mount*' })
        $served = @(Get-ConsoleCalls -Calls $calls) -join ' :: '

        $checked.Count | Should -Be 2 -Because $shape
        $calls | Should -Not -BeLike '*volume create*' -Because $shape

        $served | Should -BeLike '*from-clinic:/rendezvous *' -Because $shape
        $served | Should -BeLike '*to-clinic:/rendezvous-out*' -Because $shape
        $served | Should -BeLike '*JOB_RENDEZVOUS_DIR=/rendezvous *' -Because $shape
        $served | Should -BeLike '*JOB_RENDEZVOUS_OUTBOUND_DIR=/rendezvous-out*' -Because $shape
        $served | Should -BeLike '*JOB_RENDEZVOUS_NAME=from-clinic*' -Because $shape
        $served | Should -BeLike '*JOB_RENDEZVOUS_OUTBOUND_NAME=to-clinic*' -Because $shape
    }

    It 'refuses a pair with only one folder given, and names what to give' {
        # Half a pair never falls back to the single-folder shape: the console
        # would read the data root as the folder the partner writes into, and
        # the run would sync the key file, the input and the results to them.
        $run = Invoke-LauncherFlow -Launcher $script:FlowLauncher -StubDir $script:RefusalStub `
            -Arguments @(
                '-DataRoot', "`"$script:FlowData`"",
                '-RendezvousOutboundDir', '\\psilink-ci-server\exchange\to-clinic',
                '-Port', $script:FlowPort,
                '-NoBrowser') `
            -TimeoutSeconds 60

        $output = [string] $run.Output
        $shape = Get-FlowShape -Run $run

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 1 -Because $shape
        $output | Should -BeLike '*Only one of the two folders shared with your partner*' -Because $shape
        $output | Should -BeLike '*-RendezvousDir*' -Because $shape
        (@(Get-ConsoleCalls -Calls ([string] $run.Calls)) -join ' :: ') |
            Should -BeNullOrEmpty -Because $shape
    }

    It 'refuses a pair whose folders are one inside the other' {
        $run = Invoke-LauncherFlow -Launcher $script:FlowLauncher -StubDir $script:RefusalStub `
            -Arguments @(
                '-DataRoot', "`"$script:FlowData`"",
                '-RendezvousDir', "`"$script:LocalInbound`"",
                '-RendezvousOutboundDir', "`"$(Join-Path $script:LocalInbound 'to-clinic')`"",
                '-Port', $script:FlowPort,
                '-NoBrowser') `
            -TimeoutSeconds 60

        $output = [string] $run.Output
        $shape = Get-FlowShape -Run $run

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 1 -Because $shape
        $output | Should -BeLike '*inside the other*' -Because $shape
        (@(Get-ConsoleCalls -Calls ([string] $run.Calls)) -join ' :: ') |
            Should -BeNullOrEmpty -Because $shape
    }

    It 'names the folder for the console with no setup script beside it' {
        # A folder on this PC is what this run still supports, and its name is
        # part of what supporting it means: the partner is told which folder to
        # look for by the invitation the console mints, and a run that passed no
        # name would leave them nothing to match.
        $originalPath = $env:PATH
        $originalStubDir = $env:PSILINK_STUB_DIR
        try {
            $env:PATH = @($script:FlowBin,
                (Join-Path $env:SystemRoot 'System32'),
                $env:SystemRoot,
                (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')) -join ';'
            $env:PSILINK_STUB_DIR = $script:AloneStub
            $run = Start-LauncherChild -Arguments @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$script:AloneLauncher`"",
                '-DataRoot', "`"$script:AloneData`"",
                '-Port', $script:FlowPort,
                '-NoBrowser') `
                -InputLines @('', '') -TimeoutSeconds 150
        } finally {
            $env:PATH = $originalPath
            if ($null -eq $originalStubDir) {
                Remove-Item 'env:PSILINK_STUB_DIR' -ErrorAction SilentlyContinue
            } else {
                $env:PSILINK_STUB_DIR = $originalStubDir
            }
        }

        $calls = ''
        if (Test-Path -LiteralPath $script:AloneCalls) {
            $calls = [string] (Get-Content -LiteralPath $script:AloneCalls -Raw)
        }
        $output = [string] $run.Output
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) calls=$(@($calls -split '\r?\n').Count) tail=" +
            (($output.Substring([Math]::Max(0, $output.Length - 300))) -replace '\s+', ' ')

        $run.TimedOut | Should -BeFalse -Because $shape
        # The branch this case is here to drive: without it the run resolved
        # paths after all, and the name it passed came from the other rule.
        $output | Should -BeLike '*Setup-PsilinkFileDrop.ps1 is not in this folder*' -Because $shape
        $output | Should -Match 'The console is at' -Because $shape

        $served = @(Get-ConsoleCalls -Calls $calls) -join ' :: '
        $served | Should -BeLike '*JOB_RENDEZVOUS_NAME=agency-a-agency-b*' -Because $shape
    }

    It 'explains nothing about folder layout when -DataRoot named the folder' {
        # -DataRoot is the answer that question asks for, so the explanation
        # ahead of it has nothing left to explain. The folder named here does
        # not exist, which ends the run just below the branch -- far enough to
        # read what it printed, and short of anything that starts a container.
        $missing = Join-Path $script:FlowRoot 'no-such-working-folder'
        $run = Invoke-LauncherFlow -Launcher $script:FlowLauncher -StubDir $script:RefusalStub `
            -Arguments @(
                '-DataRoot', "`"$missing`"",
                '-Port', $script:FlowPort,
                '-NoBrowser') `
            -TimeoutSeconds 60

        $output = [string] $run.Output
        $shape = Get-FlowShape -Run $run

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 1 -Because $shape
        $output | Should -BeLike '*There is no folder at*' -Because $shape
        $output | Should -Not -BeLike '*One folder for all of it*' -Because $shape
        $output | Should -Not -BeLike '*Use one folder for everything*' -Because $shape
    }

    It 'names the volume already made when a later folder is refused' {
        # Two folders on two shares take a volume each, and the first is made
        # before the second is confirmed. A run that stops at the second has
        # left a volume holding the share password, so what the closing screen
        # would have said is said on the way out instead.
        $volumeName = 'psilinkci-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
        $run = Invoke-LauncherFlow -Launcher $script:FlowLauncher -StubDir $script:TwoVolumeStub `
            -Arguments @(
                '-DataRoot', "`"$script:FlowData`"",
                '-RendezvousDir', '\\psilink-ci-fs\exchange\from-clinic',
                '-RendezvousOutboundDir', '\\psilink-ci-fs\outbound\to-clinic',
                '-VolumeName', $volumeName,
                '-Port', $script:FlowPort,
                '-NoBrowser') `
            -InputLines @('', 'n', '', '', '')

        $calls = [string] $run.Calls
        $output = [string] $run.Output
        $shape = Get-FlowShape -Run $run

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 1 -Because $shape
        # Where the run stopped: the second folder's server and share were not
        # confirmed, and neither route out of that reaches a second volume.
        $output | Should -BeLike '*DFS tab*' -Because $shape
        @($calls -split '\r?\n' | Where-Object { $_ -like '*volume create*' }).Count |
            Should -Be 1 -Because $shape
        (@(Get-ConsoleCalls -Calls $calls) -join ' :: ') | Should -BeNullOrEmpty -Because $shape

        $output | Should -BeLike '*cleartext*' -Because $shape
        $output | Should -BeLike "*volume rm $volumeName*" -Because $shape
        $output | Should -Not -BeLike "*$volumeName-outbound*" -Because $shape
    }

    It 'names the volume it made when the checks over it fail' {
        # The volume is made before the folders are checked through it, so a
        # failure there leaves one behind holding the share password. Nothing
        # here removes it, so the run names it on the way out rather than
        # leaving the operator a volume they were never told about.
        $volumeName = 'psilinkci-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
        $run = Invoke-LauncherFlow -Launcher $script:FlowLauncher -StubDir $script:MountFailStub `
            -BinDir $script:MountFailBin `
            -Arguments @(
                '-DataRoot', "`"$script:FlowData`"",
                '-RendezvousDir', '\\psilink-ci-server\exchange\clinic-study\from-clinic',
                '-RendezvousOutboundDir', '\\psilink-ci-server\exchange\clinic-study\to-clinic',
                '-VolumeName', $volumeName,
                '-Port', $script:FlowPort,
                '-NoBrowser') `
            -InputLines @('', '') -TimeoutSeconds 90

        $calls = [string] $run.Calls
        $output = [string] $run.Output
        $shape = Get-FlowShape -Run $run

        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 1 -Because $shape

        # Where the run stopped: the volume was made, and the first folder
        # checked through it is what failed.
        @($calls -split '\r?\n' | Where-Object { $_ -like '*volume create*' }).Count |
            Should -Be 1 -Because $shape
        $checked = @($calls -split '\r?\n' | Where-Object { $_ -like '*doctor mount*' })
        $checked.Count | Should -Be 1 -Because $shape
        $checked[0] | Should -BeLike '*doctor mount /rz/from-clinic*' -Because $shape
        (@(Get-ConsoleCalls -Calls $calls) -join ' :: ') | Should -BeNullOrEmpty -Because $shape

        $output | Should -BeLike '*cleartext*' -Because $shape
        $output | Should -BeLike "*volume rm $volumeName*" -Because $shape
    }
}
