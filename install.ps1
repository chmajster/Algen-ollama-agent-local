#Requires -Version 5.1

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$InstallRoot = "$env:LOCALAPPDATA\Algen\LocalCodeAgent",
    [string]$RepositoryUrl = "https://github.com/chmajster/Algen-ollama-agent-local.git",
    [string]$Ref = "main",
    [string]$Model = "qwen3.5:9b",
    [string]$OllamaHost = "http://127.0.0.1:11434",
    [ValidateSet("quick", "full")][string]$Mode = "quick",
    [int]$NodeMemoryMb = $(if ($env:ALGEN_NODE_MEMORY_MB) { [int]$env:ALGEN_NODE_MEMORY_MB } else { 1024 }),
    [ValidateRange(1, 10080)][int]$FetchIntervalMinutes = 60,
    [switch]$SkipDependencyInstall,
    [switch]$SkipModelPull,
    [switch]$SkipVSCodeInstall,
    [switch]$SkipVSCodeConfiguration,
    [switch]$SkipTests,
    [switch]$SkipDoctor,
    [switch]$NoLaunch,
    [switch]$Force,
    [switch]$Unattended,
    [Parameter(DontShow = $true)][switch]$ElevatedRelaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:CurrentStage = "initialization"
$script:LogPath = $null
$script:ResolvedInstallRoot = $null
$script:RepositoryDirectory = $null
$script:Executables = @{}
$script:PackageManager = $null
$script:Cmdlet = $PSCmdlet
$script:VsixPath = $null
$script:BuildSucceeded = $false
$script:DoctorSucceeded = $false
$script:RepositoryChanged = $true
$script:StatePath = $null
$script:FetchPerformed = $false

Import-Module (Join-Path $PSScriptRoot "scripts\InstallerCommand.psm1") -Force

function Write-InstallLog {
    param([ValidateSet("INFO", "WARN", "ERROR")][string]$Level, [string]$Message)
    $clean = $Message -replace '[\r\n]+', ' '
    $clean = $clean -replace '(?i)(authorization\s*:\s*(?:bearer\s+)?)[^\s]+', '$1[REDACTED]'
    $clean = $clean -replace '(?i)((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+', '$1[REDACTED]'
    $line = '{0} level={1} stage="{2}" message="{3}"' -f (Get-Date -Format "o"), $Level, $script:CurrentStage, ($clean -replace '"', "'")
    Write-Host $line
    if ($script:LogPath) { Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8 }
}

function Set-InstallStage {
    param([string]$Name)
    $script:CurrentStage = $Name
    Write-InstallLog INFO "Starting stage"
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ";"
    Write-InstallLog INFO "Refreshed process PATH from machine and user scopes"
}

function Resolve-Executable {
    param([string[]]$Names, [string[]]$Locations = @())
    foreach ($name in $Names) {
        $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { return $command.Source }
    }
    foreach ($location in $Locations) {
        if ($location -and (Test-Path -LiteralPath $location -PathType Leaf)) { return (Resolve-Path -LiteralPath $location).Path }
    }
    return $null
}

function Resolve-Dependencies {
    $pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    $script:Executables = @{
        git = Resolve-Executable @("git.exe") @("$env:ProgramFiles\Git\cmd\git.exe")
        node = Resolve-Executable @("node.exe") @("$env:ProgramFiles\nodejs\node.exe")
        npm = Resolve-Executable @("npm.cmd") @("$env:ProgramFiles\nodejs\npm.cmd")
        ollama = Resolve-Executable @("ollama.exe") @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe")
        code = Resolve-Executable @("code.cmd", "code.exe") @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd", "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd", "$pf86\Microsoft VS Code\bin\code.cmd")
    }
    foreach ($key in $script:Executables.Keys) {
        $value = $script:Executables[$key]
        Write-InstallLog INFO ("Executable {0}: {1}" -f $key, $(if ($value) { $value } else { "not found" }))
    }
}

function Invoke-External {
    param([string]$FilePath, [string[]]$Arguments = @(), [string]$Description = $FilePath, [switch]$Capture)
    Write-InstallLog INFO ("Command: " + (Format-ExternalCommand -FilePath $FilePath -Arguments $Arguments))
    $previousErrorPreference = $ErrorActionPreference
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $maxOutputBytes = 1024 * $(if ($env:ALGEN_MAX_COMMAND_OUTPUT_KB) { [int]$env:ALGEN_MAX_COMMAND_OUTPUT_KB } else { 256 })
    $capturedBytes = 0
    $diagnosticWriter = $null
    $diagnosticPath = $null
    try {
        $ErrorActionPreference = "Continue"
        & $FilePath @Arguments 2>&1 | ForEach-Object {
            $line = $_.ToString()
            $lineBytes = [Text.Encoding]::UTF8.GetByteCount($line) + 1
            if ($capturedBytes + $lineBytes -le $maxOutputBytes) {
                [void]$lines.Add($line)
                $capturedBytes += $lineBytes
            } else {
                if (-not $diagnosticWriter) {
                    $diagnosticDirectory = if ($script:LogPath) { Split-Path $script:LogPath } else { [IO.Path]::GetTempPath() }
                    $diagnosticPath = Join-Path $diagnosticDirectory ("command-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff"))
                    $diagnosticWriter = New-Object IO.StreamWriter($diagnosticPath, $false, (New-Object Text.UTF8Encoding($false)))
                    foreach ($capturedLine in $lines) { $diagnosticWriter.WriteLine($capturedLine) }
                }
                $diagnosticWriter.WriteLine($line)
            }
        }
        $exitCode = $LASTEXITCODE
    } finally {
        if ($diagnosticWriter) { $diagnosticWriter.Dispose() }
        $ErrorActionPreference = $previousErrorPreference
    }
    if ($DebugPreference -ne "SilentlyContinue") {
        foreach ($line in $lines) { Write-InstallLog INFO ("process-output: " + $line) }
    } elseif ($lines.Count -gt 0) { Write-InstallLog INFO "External process produced $($lines.Count) output line(s); use -Debug for details" }
    if ($diagnosticPath) { Write-InstallLog WARN "Command output exceeded $maxOutputBytes bytes; full output saved to $diagnosticPath" }
    Write-InstallLog INFO "External process exit code: $exitCode"
    if ($exitCode -ne 0) { throw "$Description failed with exit code $exitCode." }
    if ($Capture) { return $lines.ToArray() }
}

function Get-NodeVersion {
    if (-not $script:Executables.node) { return $null }
    $output = Invoke-External $script:Executables.node @("--version") "node.exe" -Capture
    $text = (($output | Select-Object -Last 1) -replace '^v', '').Trim()
    $version = $null
    if (-not [Version]::TryParse($text, [ref]$version)) { throw "Unable to parse Node.js version '$text'." }
    Write-InstallLog INFO "Detected Node.js version $version"
    return $version
}

function Get-PackageManager {
    $choco = Resolve-Executable @("choco.exe")
    if ($choco) { return @{ Name = "Chocolatey"; Path = $choco } }
    $winget = Resolve-Executable @("winget.exe") @("$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe")
    if ($winget) { return @{ Name = "winget"; Path = $winget } }
    return $null
}

function Invoke-PackageAction {
    param([string]$Action, [string]$ChocolateyId, [string]$WingetId)
    if ($script:PackageManager.Name -eq "Chocolatey") {
        Write-InstallLog INFO "Command: choco.exe $Action $ChocolateyId -y --no-progress"
        $previousErrorPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            $lines = @(& $script:PackageManager.Path $Action $ChocolateyId -y --no-progress 2>&1 | ForEach-Object { $_.ToString() })
            $code = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previousErrorPreference }
        foreach ($line in $lines) { Write-InstallLog INFO ("process-output: " + $line) }
        Write-InstallLog INFO "External process exit code: $code"
        if ($code -notin @(0, 1641, 3010)) { throw "Chocolatey failed for package '$ChocolateyId' with exit code $code." }
    } else {
        $arguments = @($Action, "--id", $WingetId, "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity")
        Invoke-External $script:PackageManager.Path $arguments "winget.exe"
    }
}

function Get-RelaunchArguments {
    $quote = { param([string]$value) '"' + ($value -replace '"', '\"') + '"' }
    $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (& $quote $PSCommandPath))
    foreach ($name in @("InstallRoot", "RepositoryUrl", "Ref", "Model", "OllamaHost", "Mode", "NodeMemoryMb", "FetchIntervalMinutes")) {
        $arguments += "-$name"; $arguments += (& $quote ([string](Get-Variable -Name $name -ValueOnly)))
    }
    foreach ($name in @("SkipDependencyInstall", "SkipModelPull", "SkipVSCodeInstall", "SkipVSCodeConfiguration", "SkipTests", "SkipDoctor", "NoLaunch", "Force", "Unattended")) {
        if ((Get-Variable -Name $name -ValueOnly).IsPresent) { $arguments += "-$name" }
    }
    $arguments += "-ElevatedRelaunch"
    return ($arguments -join " ")
}

function Test-OllamaReady {
    try {
        $response = Invoke-RestMethod -Method Get -Uri ($OllamaHost.TrimEnd('/') + "/api/version") -TimeoutSec 5
        return ($null -ne $response)
    } catch { return $false }
}

function Assert-ValidParameters {
    if (-not [Environment]::Is64BitOperatingSystem) { throw "A 64-bit Windows installation is required." }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw "This installer supports Windows only." }
    $repositoryUri = $null
    if (-not [Uri]::TryCreate($RepositoryUrl, [UriKind]::Absolute, [ref]$repositoryUri) -or $repositoryUri.Scheme -notin @("https", "http") -or -not $repositoryUri.Host -or $repositoryUri.UserInfo) { throw "RepositoryUrl must be an HTTP(S) URL without credentials." }
    if ([string]::IsNullOrWhiteSpace($Ref) -or $Ref -notmatch '^[A-Za-z0-9._/-]+$' -or $Ref -match '(^|/)\.\.(/|$)|\.lock$|[~^:?*\[\\]') { throw "Ref contains unsafe Git revision characters." }
    if ($Model -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$') { throw "Model has an invalid Ollama model name." }
    $hostUri = $null
    if (-not [Uri]::TryCreate($OllamaHost, [UriKind]::Absolute, [ref]$hostUri) -or $hostUri.Scheme -notin @("http", "https") -or -not $hostUri.Host -or $hostUri.UserInfo) { throw "OllamaHost must be an HTTP(S) URL without credentials." }
    $script:ResolvedInstallRoot = [IO.Path]::GetFullPath($InstallRoot)
    $root = [IO.Path]::GetPathRoot($script:ResolvedInstallRoot)
    if ($script:ResolvedInstallRoot.TrimEnd('\') -eq $root.TrimEnd('\')) { throw "InstallRoot cannot be a filesystem root." }
    $script:RepositoryDirectory = Join-Path $script:ResolvedInstallRoot "source"
    $script:StatePath = Join-Path $script:ResolvedInstallRoot "installer-state.json"
    $env:OLLAMA_HOST = $OllamaHost
    $env:NODE_OPTIONS = "--max-old-space-size=$NodeMemoryMb"
    Write-InstallLog INFO "Validated repository URL, ref, model, host, and install path"
}

function Test-OriginMatch {
    param([string]$Actual, [string]$Expected)
    $normalize = { param($url) ($url.Trim().TrimEnd('/') -replace '\.git$', '').ToLowerInvariant() }
    return (& $normalize $Actual) -eq (& $normalize $Expected)
}

function Test-GitReference {
    param([string]$Reference, [switch]$UseShowRef)
    $arguments = if ($UseShowRef) { @("-C", $script:RepositoryDirectory, "show-ref", "--verify", "--quiet", $Reference) } else { @("-C", $script:RepositoryDirectory, "rev-parse", "--verify", "--quiet", $Reference) }
    Write-InstallLog INFO ("Command: git.exe " + ($arguments -join " "))
    $previousErrorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $lines = @(& $script:Executables.git @arguments 2>&1 | ForEach-Object { $_.ToString() })
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousErrorPreference }
    foreach ($line in $lines) { Write-InstallLog INFO ("process-output: " + $line) }
    Write-InstallLog INFO "External process exit code: $exitCode"
    return ($exitCode -eq 0)
}

function Update-Repository {
    if (-not (Test-Path -LiteralPath $script:RepositoryDirectory)) {
        Invoke-External $script:Executables.git @("clone", $RepositoryUrl, $script:RepositoryDirectory) "git clone"
        $script:FetchPerformed = $true
    } else {
        $inside = Invoke-External $script:Executables.git @("-C", $script:RepositoryDirectory, "rev-parse", "--is-inside-work-tree") "git rev-parse" -Capture
        if (($inside | Select-Object -Last 1).Trim() -ne "true") { throw "Repository directory is not a valid Git worktree." }
        $origin = (Invoke-External $script:Executables.git @("-C", $script:RepositoryDirectory, "remote", "get-url", "origin") "git remote" -Capture | Select-Object -Last 1).Trim()
        if (-not (Test-OriginMatch $origin $RepositoryUrl)) { throw "Existing origin '$origin' does not match RepositoryUrl '$RepositoryUrl'." }
        $localHead = (Invoke-External $script:Executables.git @("-C", $script:RepositoryDirectory, "rev-parse", "HEAD") "git rev-parse" -Capture | Select-Object -Last 1).Trim()
        $cachedRemoteReference = "refs/remotes/origin/$Ref"
        $cachedRemoteHead = if (Test-GitReference $cachedRemoteReference -UseShowRef) {
            (Invoke-External $script:Executables.git @("-C", $script:RepositoryDirectory, "rev-parse", $cachedRemoteReference) "git rev-parse cached origin" -Capture | Select-Object -Last 1).Trim()
        } else { $null }
        $savedState = Get-InstallerState
        $lastFetch = [DateTimeOffset]::MinValue
        $hasRecentFetch = $savedState.lastFetchAt -and [DateTimeOffset]::TryParse([string]$savedState.lastFetchAt, [ref]$lastFetch) -and
            ([DateTimeOffset]::UtcNow - $lastFetch.ToUniversalTime()).TotalMinutes -lt $FetchIntervalMinutes
        if ($Mode -eq "quick" -and $cachedRemoteHead -and $localHead -eq $cachedRemoteHead -and $hasRecentFetch -and -not $Force) {
            $script:RepositoryChanged = $false
            Write-InstallLog INFO "Local commit matches cached origin/$Ref and the last fetch is recent; network fetch skipped"
        } else {
            Invoke-External $script:Executables.git @("-C", $script:RepositoryDirectory, "fetch", "--prune", "origin") "git fetch"
            $script:FetchPerformed = $true
        }
    }

    $remoteBranch = "refs/remotes/origin/$Ref"
    $isBranch = Test-GitReference $remoteBranch -UseShowRef
    $target = if ($isBranch) { "origin/$Ref" } else { "$Ref^{commit}" }
    if (-not (Test-GitReference $target)) { throw "Ref '$Ref' was not found after fetching origin." }
    $targetCommit = (Invoke-External $script:Executables.git @("-C", $script:RepositoryDirectory, "rev-parse", $target) "git rev-parse target" -Capture | Select-Object -Last 1).Trim()
    $headCommit = (Invoke-External $script:Executables.git @("-C", $script:RepositoryDirectory, "rev-parse", "HEAD") "git rev-parse HEAD" -Capture | Select-Object -Last 1).Trim()
    if ($targetCommit -ne $headCommit) {
        $dirty = Invoke-External $script:Executables.git @("-C", $script:RepositoryDirectory, "status", "--porcelain") "git status" -Capture
        if ($dirty.Count -gt 0) { throw "Git worktree is dirty and cannot be updated safely. Commit or stash changes first; -Force never discards changes." }
        if ($isBranch) {
            if (Test-GitReference "refs/heads/$Ref" -UseShowRef) { Invoke-External $script:Executables.git @("-C", $script:RepositoryDirectory, "checkout", $Ref) "git checkout" }
            else { Invoke-External $script:Executables.git @("-C", $script:RepositoryDirectory, "checkout", "--track", "-b", $Ref, "origin/$Ref") "git checkout" }
            Invoke-External $script:Executables.git @("-C", $script:RepositoryDirectory, "merge", "--ff-only", "origin/$Ref") "git merge --ff-only"
        } else {
            Invoke-External $script:Executables.git @("-C", $script:RepositoryDirectory, "checkout", "--detach", $targetCommit) "git checkout"
        }
    } else { Write-InstallLog INFO "Repository already resolves to requested ref $Ref ($targetCommit)" }
    Write-InstallLog INFO "Repository path: $script:RepositoryDirectory"
}

function Get-InstallerState {
    $defaults = [ordered]@{ lockHash = ""; commit = ""; dependenciesComplete = $false; artifactsComplete = $false; lastFetchAt = "" }
    if (-not (Test-Path -LiteralPath $script:StatePath -PathType Leaf)) { return [pscustomobject]$defaults }
    try {
        $saved = Get-Content -Raw -LiteralPath $script:StatePath | ConvertFrom-Json
        foreach ($name in @($defaults.Keys)) {
            if ($saved.PSObject.Properties.Name -contains $name) { $defaults[$name] = $saved.$name }
        }
        return [pscustomobject]$defaults
    } catch { Write-InstallLog WARN "Installer state is unreadable; required work will be repeated"; return [pscustomobject]$defaults }
}

function Save-InstallerState {
    param([string]$LockHash, [string]$Commit, [bool]$DependenciesComplete, [bool]$ArtifactsComplete, [string]$LastFetchAt)
    $state = [ordered]@{ version = 2; lockHash = $LockHash; commit = $Commit; dependenciesComplete = $DependenciesComplete; artifactsComplete = $ArtifactsComplete; lastFetchAt = $LastFetchAt; completedAt = (Get-Date -Format o) }
    $temporary = "$($script:StatePath).tmp"
    $state | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $script:StatePath -Force
}

function Test-NodeModulesComplete {
    $modules = Join-Path $script:RepositoryDirectory "node_modules"
    return (Test-Path -LiteralPath $modules -PathType Container) -and (Test-Path -LiteralPath (Join-Path $modules ".package-lock.json") -PathType Leaf)
}

function Test-RequiredArtifacts {
    return (Test-Path -LiteralPath (Join-Path $script:RepositoryDirectory "apps\agent-runtime\dist\serverEntry.js") -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $script:RepositoryDirectory "apps\vscode-extension\dist\extension.js") -PathType Leaf)
}

function Invoke-PlannedExternal {
    param([string]$Target, [string]$Action, [string]$FilePath, [string[]]$Arguments)
    if ($script:Cmdlet.ShouldProcess($Target, $Action)) { Invoke-External $FilePath $Arguments $Action }
}

function Get-InstalledModels {
    $lines = Invoke-External $script:Executables.ollama @("list") "ollama.exe list" -Capture
    return @($lines | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ })
}

try {
    Set-InstallStage "validate parameters and environment"
    Assert-ValidParameters
    if (-not $WhatIfPreference) {
        $logsDirectory = Join-Path $script:ResolvedInstallRoot "logs"
        New-Item -ItemType Directory -Path $logsDirectory -Force | Out-Null
        $script:LogPath = Join-Path $logsDirectory ("install-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
        New-Item -ItemType File -Path $script:LogPath -Force | Out-Null
        Write-InstallLog INFO "Installer log initialized"
    } else { Write-InstallLog INFO "WhatIf mode: no files or external state will be changed" }

    Set-InstallStage "detect package manager"
    $script:PackageManager = Get-PackageManager
    if ($script:PackageManager) { Write-InstallLog INFO "Selected package manager: $($script:PackageManager.Name)" }
    else { Write-InstallLog WARN "Neither Chocolatey nor winget is available" }
    Resolve-Dependencies

    Set-InstallStage "install or update missing dependencies"
    $nodeVersion = Get-NodeVersion
    $needs = @()
    if (-not $script:Executables.git) { $needs += @{ Label="Git"; Choco="git"; Winget="Git.Git"; Action="install" } }
    if (-not $script:Executables.node -or -not $script:Executables.npm) { $needs += @{ Label="Node.js LTS"; Choco="nodejs-lts"; Winget="OpenJS.NodeJS.LTS"; Action="install" } }
    elseif ($nodeVersion.Major -lt 22) { $needs += @{ Label="Node.js LTS"; Choco="nodejs-lts"; Winget="OpenJS.NodeJS.LTS"; Action="upgrade" } }
    if (-not $script:Executables.ollama) { $needs += @{ Label="Ollama"; Choco="ollama"; Winget="Ollama.Ollama"; Action="install" } }
    if (-not $script:Executables.code -and -not $SkipVSCodeInstall) { $needs += @{ Label="VS Code"; Choco="vscode"; Winget="Microsoft.VisualStudioCode"; Action="install" } }
    if ($needs.Count -gt 0 -and $SkipDependencyInstall) { throw "Missing or outdated dependencies: $(($needs.Label) -join ', '). -SkipDependencyInstall permits validation only." }
    if ($needs.Count -gt 0 -and -not $script:PackageManager) { throw "Dependencies are missing or outdated, but neither Chocolatey nor winget is available." }
    if ($needs.Count -gt 0 -and $script:PackageManager.Name -eq "Chocolatey" -and -not (Test-Admin) -and -not $WhatIfPreference) {
        if ($ElevatedRelaunch) { throw "Chocolatey requires administrator privileges and the elevated relaunch did not acquire them." }
        Write-InstallLog INFO "Relaunching installer as administrator for Chocolatey"
        $process = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList (Get-RelaunchArguments) -Wait -PassThru
        Write-InstallLog INFO "Elevated installer exit code: $($process.ExitCode)"
        exit $process.ExitCode
    }
    foreach ($dependency in $needs) {
        if ($script:Cmdlet.ShouldProcess($dependency.Label, "$($dependency.Action) using $($script:PackageManager.Name)")) {
            Invoke-PackageAction $dependency.Action $dependency.Choco $dependency.Winget
        }
    }

    Set-InstallStage "refresh current process PATH"
    Refresh-ProcessPath
    Resolve-Dependencies
    $nodeVersion = Get-NodeVersion
    if (-not $WhatIfPreference) {
        foreach ($required in @("git", "node", "npm", "ollama")) { if (-not $script:Executables[$required]) { throw "Required executable '$required' was not found." } }
        if ($nodeVersion.Major -lt 22) { throw "Node.js 22 or newer is required; detected $nodeVersion." }
        if (-not $script:Executables.code) { throw "VS Code CLI was not found. Install VS Code with its PATH option or omit -SkipVSCodeInstall." }
    }

    Set-InstallStage "clone or safely update repository"
    if ($script:Cmdlet.ShouldProcess($script:RepositoryDirectory, "Clone or fast-forward repository to $Ref")) { Update-Repository }

    Set-InstallStage "install npm dependencies"
    $lockPath = Join-Path $script:RepositoryDirectory "package-lock.json"
    $lockHash = if (Test-Path -LiteralPath $lockPath -PathType Leaf) { (Get-FileHash -Algorithm SHA256 -LiteralPath $lockPath).Hash } else { "no-lockfile" }
    $state = Get-InstallerState
    $dependenciesCurrent = -not $Force -and $Mode -eq "quick" -and (Test-NodeModulesComplete) -and
        $state.dependenciesComplete -eq $true -and $state.lockHash -eq $lockHash
    if ($dependenciesCurrent) {
        Write-InstallLog INFO "Dependencies are current; npm install skipped"
    } else {
        $npmAction = if (Test-Path -LiteralPath $lockPath) { "ci" } else { "install" }
        Invoke-PlannedExternal $script:RepositoryDirectory "Install npm dependencies" $script:Executables.npm @($npmAction, "--prefix", $script:RepositoryDirectory, "--no-audit", "--no-fund")
    }

    Set-InstallStage "validate and build monorepo"
    $headCommit = if ($WhatIfPreference) { "whatif" } else { (Invoke-External $script:Executables.git @("-C", $script:RepositoryDirectory, "rev-parse", "HEAD") "git rev-parse" -Capture | Select-Object -Last 1).Trim() }
    $artifactsCurrent = -not $Force -and $Mode -eq "quick" -and -not $script:RepositoryChanged -and
        $state.artifactsComplete -eq $true -and $state.commit -eq $headCommit -and (Test-RequiredArtifacts)
    if ($Mode -eq "full") {
        foreach ($command in @("format:check", "typecheck", "lint")) { Invoke-PlannedExternal $script:RepositoryDirectory "Run $command" $script:Executables.npm @("run", $command, "--prefix", $script:RepositoryDirectory) }
        if (-not $SkipTests) { Invoke-PlannedExternal $script:RepositoryDirectory "Run unit tests" $script:Executables.npm @("run", "test", "--prefix", $script:RepositoryDirectory) }
        Invoke-PlannedExternal $script:RepositoryDirectory "Build monorepo" $script:Executables.npm @("run", "build", "--prefix", $script:RepositoryDirectory)
    } elseif ($artifactsCurrent) {
        Write-InstallLog INFO "Runtime and extension artifacts match the current commit; build skipped"
    } else {
        Invoke-PlannedExternal $script:RepositoryDirectory "Build runtime and direct dependencies" $script:Executables.npm @("--prefix", $script:RepositoryDirectory, "exec", "tsc", "--", "-b", "apps/agent-runtime", "--pretty", "false")
        Invoke-PlannedExternal $script:RepositoryDirectory "Build VS Code extension" $script:Executables.npm @("run", "build", "--workspace", "apps/vscode-extension", "--prefix", $script:RepositoryDirectory)
    }
    if (-not $WhatIfPreference) { $script:BuildSucceeded = Test-RequiredArtifacts }

    Set-InstallStage "build VS Code VSIX"
    $buildStart = Get-Date
    $existingVsix = Get-ChildItem -LiteralPath (Join-Path $script:RepositoryDirectory "artifacts") -Filter "*.vsix" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($artifactsCurrent -and $existingVsix) {
        $script:VsixPath = $existingVsix
        Write-InstallLog INFO "Current VSIX artifact reused"
    } else {
        $packageScript = if ($Mode -eq "quick") { "package:vsix:no-build" } else { "package:vsix" }
        Invoke-PlannedExternal $script:RepositoryDirectory "Package VS Code extension" $script:Executables.npm @("run", $packageScript, "--workspace", "apps/vscode-extension", "--prefix", $script:RepositoryDirectory)
    }
    if (-not $WhatIfPreference) {
        if (-not $script:VsixPath) { $script:VsixPath = Get-ChildItem -LiteralPath (Join-Path $script:RepositoryDirectory "artifacts") -Filter "*.vsix" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1 }
        if (-not $script:VsixPath -or $script:VsixPath.Length -le 0) { throw "A non-empty VSIX was not found." }
        Write-InstallLog INFO "Generated VSIX path: $($script:VsixPath.FullName)"
    }

    Set-InstallStage "install VSIX"
    if ($artifactsCurrent -and $existingVsix) { Write-InstallLog INFO "VS Code extension artifact is current; forced reinstall skipped" }
    elseif ($script:VsixPath) { Invoke-PlannedExternal $script:VsixPath.FullName "Install VS Code extension" $script:Executables.code @("--install-extension", $script:VsixPath.FullName, "--force") }
    elseif ($WhatIfPreference) { Write-InstallLog INFO "WhatIf: would install the newly generated VSIX" }

    Set-InstallStage "start and verify Ollama"
    if ($WhatIfPreference) { Write-InstallLog INFO "WhatIf: Ollama readiness probe skipped" }
    elseif (-not (Test-OllamaReady)) {
        if ($script:Cmdlet.ShouldProcess($OllamaHost, "Start detached Ollama server")) {
            $ollamaOut = Join-Path (Split-Path $script:LogPath) ("ollama-{0}.out.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
            $ollamaErr = Join-Path (Split-Path $script:LogPath) ("ollama-{0}.err.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
            Write-InstallLog INFO "Command: ollama.exe serve (detached; stdout=$ollamaOut; stderr=$ollamaErr)"
            Start-Process -FilePath $script:Executables.ollama -ArgumentList @("serve") -WindowStyle Hidden -RedirectStandardOutput $ollamaOut -RedirectStandardError $ollamaErr | Out-Null
            $deadline = (Get-Date).AddSeconds(60)
            while ((Get-Date) -lt $deadline -and -not (Test-OllamaReady)) { Start-Sleep -Seconds 2 }
            if (-not (Test-OllamaReady)) { throw "Ollama API did not become ready at $OllamaHost within 60 seconds." }
        }
    } else { Write-InstallLog INFO "Ollama API is ready at $OllamaHost" }

    Set-InstallStage "pull configured model when missing"
    if (-not $WhatIfPreference) {
        $models = Get-InstalledModels
        if ($Model -notin $models) {
            if ($SkipModelPull) { throw "Configured model '$Model' is missing and -SkipModelPull was specified." }
            Invoke-PlannedExternal $Model "Pull Ollama model" $script:Executables.ollama @("pull", $Model)
        } else { Write-InstallLog INFO "Configured model is already installed: $Model" }
    } else { Write-InstallLog INFO "WhatIf: would check ollama list and pull $Model only if missing" }

    Set-InstallStage "configure VS Code"
    if (-not $SkipVSCodeConfiguration) {
        $settingsPath = Join-Path $env:APPDATA "Code\User\settings.json"
        $helperPath = Join-Path $script:RepositoryDirectory "scripts\configure-vscode-settings.mjs"
        Invoke-PlannedExternal $settingsPath "Update only Local Code Agent connection settings (JSONC backup and atomic write)" $script:Executables.node @($helperPath, $settingsPath, $OllamaHost, $Model)
    } else { Write-InstallLog INFO "VS Code configuration skipped by request" }

    Set-InstallStage "run project diagnostics"
    if (-not $SkipDoctor -and $Mode -eq "full") {
        Invoke-PlannedExternal $script:RepositoryDirectory "npm.cmd run agent -- doctor" $script:Executables.npm @("run", "agent", "--prefix", $script:RepositoryDirectory, "--", "doctor")
        if (-not $WhatIfPreference) { $script:DoctorSucceeded = $true }
    }

    Set-InstallStage "verify final state"
    if (-not $WhatIfPreference) {
        Resolve-Dependencies
        if (-not $script:Executables.git -or -not $script:Executables.npm) { throw "Final executable verification failed." }
        if ((Get-NodeVersion).Major -lt 22) { throw "Final Node.js version verification failed." }
        if (-not $script:BuildSucceeded -or -not $script:VsixPath -or $script:VsixPath.Length -le 0) { throw "Final build or VSIX verification failed." }
        $extensionPackage = Get-Content -Raw -LiteralPath (Join-Path $script:RepositoryDirectory "apps\vscode-extension\package.json") | ConvertFrom-Json
        $extensionId = "$($extensionPackage.publisher).$($extensionPackage.name)"
        $extensions = Invoke-External $script:Executables.code @("--list-extensions", "--show-versions") "VS Code extension verification" -Capture
        if (-not ($extensions | Where-Object { $_ -match ('^' + [Regex]::Escape($extensionId) + '@') })) { throw "Extension '$extensionId' is not listed by VS Code." }
        if (-not (Test-OllamaReady)) { throw "Ollama API final verification failed." }
        if ($Model -notin (Get-InstalledModels)) { throw "Configured model '$Model' is not listed by Ollama." }
        if (-not $SkipDoctor -and $Mode -eq "full" -and -not $script:DoctorSucceeded) { throw "Doctor final verification failed." }
        $fetchTimestamp = if ($script:FetchPerformed) { [DateTimeOffset]::UtcNow.ToString("o") } else { [string]$state.lastFetchAt }
        Save-InstallerState $lockHash $headCommit $true $true $fetchTimestamp
        Write-InstallLog INFO "Final verification passed: Git, Node, npm, build, VSIX, extension, Ollama, model$(if (-not $SkipDoctor -and $Mode -eq 'full') { ', doctor' })"
    } else { Write-InstallLog INFO "WhatIf: would verify every enabled final-state check" }

    Set-InstallStage "optionally open VS Code"
    if (-not $NoLaunch) { Invoke-PlannedExternal $script:RepositoryDirectory "Open repository in a new VS Code window" $script:Executables.code @("--new-window", $script:RepositoryDirectory) }
    Write-InstallLog INFO "Installation completed successfully"
    exit 0
} catch {
    $message = $_.Exception.Message
    try { Write-InstallLog ERROR $message } catch { Write-Error $message }
    Write-Host "Installation failed during stage: $script:CurrentStage" -ForegroundColor Red
    Write-Host "Error: $message" -ForegroundColor Red
    Write-Host ("Log: " + $(if ($script:LogPath) { $script:LogPath } else { "not created (WhatIf or early validation failure)" })) -ForegroundColor Red
    exit 1
}
