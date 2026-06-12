param(
  [string]$RepoRoot = 'C:\PAI_Platform',
  [string]$C2AiGoldRoot = $(if ($env:P247_CLINE_ROOT) { $env:P247_CLINE_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }),
  [string]$LmStudioBaseUrl = 'http://127.0.0.1:1234',
  [string]$ModelId = 'gemma-4-E4B-it-GGUF',
  [string]$ModelPath = $(if ($env:P2AI_LMSTUDIO_MODEL_PATH) { $env:P2AI_LMSTUDIO_MODEL_PATH } else { 'google/gemma-4-e4b' }),
  [int]$ContextTokens = 32768,
  [int]$CompletionTokens = 2048,
  [string]$GpuOffload = $(if ($env:P2AI_LMSTUDIO_GPU_OFFLOAD) { $env:P2AI_LMSTUDIO_GPU_OFFLOAD } else { 'max' }),
  [int]$ExpectedGpuLayers = $(if ($env:P2AI_LMSTUDIO_EXPECTED_GPU_LAYERS) { [int]$env:P2AI_LMSTUDIO_EXPECTED_GPU_LAYERS } else { 43 }),
  [int]$AutostartDelayMs = 3500,
  [int]$VsCodeWindowTimeoutSeconds = 90,
  [int]$ObserveSeconds = 45,
  [string]$AutostartTask = 'Lees docs/CLINE_CODEBASE_ANALYSIS/00_INDEX_OVERZICHT.md en geef in 3 bullets een korte samenvatting. Gebruik read_file en sluit af met attempt_completion.',
  [string]$ArtifactRoot = '',
  [switch]$SkipLmStudioStart,
  [switch]$SkipBuild,
  [switch]$EnableAgentsMdRules,
  [switch]$KeepLogStreams
)

$ErrorActionPreference = 'Stop'

if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

function Write-TextFile([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function Write-JsonFile([string]$Path, $Value, [int]$Depth = 20) {
  Write-TextFile -Path $Path -Text ($Value | ConvertTo-Json -Depth $Depth)
}

function Invoke-TextCommand([scriptblock]$Command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    return ((& $Command 2>&1 | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine)
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Get-LmsExe {
  $candidate = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
  if (Test-Path -LiteralPath $candidate) {
    return $candidate
  }
  $cmd = Get-Command lms.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  throw "LM Studio CLI not found. Expected $candidate or lms.exe on PATH."
}

function Invoke-LmsText([string[]]$Arguments) {
  return Invoke-TextCommand { & $script:LmsExe @Arguments }
}

function Test-LmsServerRunning([string]$StatusText) {
  return ($StatusText -match 'running' -and $StatusText -notmatch 'not running')
}

function Wait-LmStudioModelsHttp([string]$BaseUrl, [int]$TimeoutSeconds = 60) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $attempts = @()
  do {
    try {
      $models = Invoke-RestMethod -Uri "$BaseUrl/v1/models" -TimeoutSec 5
      Write-JsonFile (Join-Path $script:ArtifactRoot 'http_v1_models_probe_attempts.json') $attempts 12
      return $models
    } catch {
      $attempts += [pscustomobject]@{
        ts = (Get-Date).ToString('o')
        error = $_.Exception.Message
      }
      Start-Sleep -Seconds 2
    }
  } while ((Get-Date) -lt $deadline)

  Write-JsonFile (Join-Path $script:ArtifactRoot 'http_v1_models_probe_attempts.json') $attempts 12
  throw "LM Studio /v1/models did not become reachable within $TimeoutSeconds seconds."
}

function Stop-VsCodeUpdater([string]$Stage) {
  $processes = @(
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ProcessName -like 'CodeSetup*' -or $_.Path -like '*vscode-stable-user-x64*CodeSetup*' }
  )

  Write-JsonFile (Join-Path $script:ArtifactRoot "vscode_updater_${Stage}_before.json") (
    $processes | Select-Object Id,ProcessName,Path,StartTime
  )

  foreach ($process in $processes) {
    try {
      Stop-Process -Id $process.Id -Force -ErrorAction Stop
    } catch {
      Write-Warning "Could not stop VS Code updater pid $($process.Id): $($_.Exception.Message)"
    }
  }

  Start-Sleep -Milliseconds 500
  $remaining = @(
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ProcessName -like 'CodeSetup*' -or $_.Path -like '*vscode-stable-user-x64*CodeSetup*' }
  )
  Write-JsonFile (Join-Path $script:ArtifactRoot "vscode_updater_${Stage}_after.json") (
    $remaining | Select-Object Id,ProcessName,Path,StartTime
  )
}

function Stop-ExistingExtensionDevelopmentHosts {
  $hosts = @(
    Get-Process -Name Code -ErrorAction SilentlyContinue |
      Where-Object {
        $_.MainWindowHandle -ne [IntPtr]::Zero -and
        $_.MainWindowTitle.Contains('[Extension Development Host]') -and
        $_.MainWindowTitle.Contains('PAI_Platform')
      }
  )
  Write-JsonFile (Join-Path $script:ArtifactRoot 'vscode_existing_extension_hosts_before.json') (
    $hosts | Select-Object Id,MainWindowTitle,Path,StartTime
  ) 8

  foreach ($hostProcess in $hosts) {
    try {
      Stop-Process -Id $hostProcess.Id -Force -ErrorAction Stop
    } catch {
      Write-Warning "Could not stop old Extension Development Host pid $($hostProcess.Id): $($_.Exception.Message)"
    }
  }

  Start-Sleep -Seconds 2
  $remaining = @(
    Get-Process -Name Code -ErrorAction SilentlyContinue |
      Where-Object {
        $_.MainWindowHandle -ne [IntPtr]::Zero -and
        $_.MainWindowTitle.Contains('[Extension Development Host]') -and
        $_.MainWindowTitle.Contains('PAI_Platform')
      }
  )
  Write-JsonFile (Join-Path $script:ArtifactRoot 'vscode_existing_extension_hosts_after.json') (
    $remaining | Select-Object Id,MainWindowTitle,Path,StartTime
  ) 8
}

function Initialize-DedicatedVsCodeUserDataDir([string]$Path) {
  $userDir = Join-Path $Path 'User'
  New-Item -ItemType Directory -Force -Path $userDir | Out-Null
  $settings = [ordered]@{
    'workbench.startupEditor' = 'none'
    'workbench.welcomePage.walkthroughs.openOnInstall' = $false
    'extensions.ignoreRecommendations' = $true
    'telemetry.telemetryLevel' = 'off'
    'update.mode' = 'none'
    'github.copilot.enable' = [ordered]@{ '*' = $false }
  }
  Write-JsonFile (Join-Path $userDir 'settings.json') $settings 8
}

function Initialize-DedicatedVsCodeWorkspaceState([string]$UserDataDir, [string]$WorkspaceRoot, [bool]$DisableAgentsMd) {
  if (-not $DisableAgentsMd) { return }
  $sqlite = Get-Command sqlite3.exe -ErrorAction SilentlyContinue
  if (-not $sqlite) {
    $sqlite = Get-Command sqlite3 -ErrorAction SilentlyContinue
  }
  if (-not $sqlite) {
    throw 'sqlite3 is required to preseed VS Code workspace state for AGENTS.md disabled mode.'
  }

  $workspaceStorageId = '01119fdce3d826a30d3cd1273d9f2466'
  $workspaceStorageDir = Join-Path $UserDataDir "User\workspaceStorage\$workspaceStorageId"
  New-Item -ItemType Directory -Force -Path $workspaceStorageDir | Out-Null
  $folderUri = 'file:///' + (($WorkspaceRoot -replace '\\', '/') -replace ':', '%3A')
  Write-JsonFile (Join-Path $workspaceStorageDir 'workspace.json') ([ordered]@{ folder = $folderUri }) 4

  $agentsPath = Join-Path $WorkspaceRoot 'AGENTS.md'
  if ($agentsPath.Length -gt 1 -and $agentsPath[1] -eq ':') {
    $agentsPath = $agentsPath.Substring(0, 1).ToLowerInvariant() + $agentsPath.Substring(1)
  }
  $stateValue = [ordered]@{
    workflowToggles = [ordered]@{}
    localClineRulesToggles = [ordered]@{}
    localWindsurfRulesToggles = [ordered]@{}
    localCursorRulesToggles = [ordered]@{}
    localAgentsRulesToggles = [ordered]@{
      $agentsPath = $false
    }
  } | ConvertTo-Json -Compress -Depth 8

  $dbPath = Join-Path $workspaceStorageDir 'state.vscdb'
  $escapedStateValue = $stateValue.Replace("'", "''")
  $sql = @"
CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
INSERT OR REPLACE INTO ItemTable(key,value) VALUES('p2ai-local.c2ai-dev','$escapedStateValue');
"@
  $sql | & $sqlite.Source $dbPath
}

function Ensure-WindowApi {
  Add-Type -AssemblyName System.Drawing
  if (-not ('P2AiGoldWindowApi' -as [type])) {
    Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class P2AiGoldWindowApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  public static extern void mouse_event(UInt32 dwFlags, UInt32 dx, UInt32 dy, UInt32 dwData, UIntPtr dwExtraInfo);
}
"@
  }
}

function Get-ExtensionHostWindows([datetime]$StartedAfter) {
  return @(
    Get-Process -Name Code -ErrorAction SilentlyContinue |
      Where-Object {
        $_.MainWindowHandle -ne [IntPtr]::Zero -and
        $_.MainWindowTitle.Contains('[Extension Development Host]') -and
        $_.MainWindowTitle.Contains('PAI_Platform')
      } |
      ForEach-Object {
        [pscustomobject]@{
          hwnd = $_.MainWindowHandle.ToInt64()
          process_id = $_.Id
          title = $_.MainWindowTitle
          start_time = $_.StartTime
          is_new_for_run = ($_.StartTime -and $_.StartTime -ge $StartedAfter.AddSeconds(-5))
        }
      }
  )
}

function Wait-ExtensionHostWindow([datetime]$StartedAfter, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $windows = @(Get-ExtensionHostWindows -StartedAfter $StartedAfter)
    $window = $windows |
      Sort-Object @{ Expression = 'is_new_for_run'; Descending = $true }, @{ Expression = 'start_time'; Descending = $true } |
      Select-Object -First 1
    if ($window) {
      Write-JsonFile (Join-Path $script:ArtifactRoot 'vscode_target_window.json') $window 6
      return $window
    }
    Start-Sleep -Milliseconds 500
  }
  throw "No visible Extension Development Host window appeared within $TimeoutSeconds seconds."
}

function Save-WindowScreenshot($Window, [string]$Path) {
  Ensure-WindowApi
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $windowHandle = [IntPtr]([int64]$Window.hwnd)
  [void][P2AiGoldWindowApi]::ShowWindow($windowHandle, 9)
  [void][P2AiGoldWindowApi]::SetForegroundWindow($windowHandle)
  Start-Sleep -Milliseconds 700
  $rect = New-Object P2AiGoldWindowApi+RECT
  if (-not [P2AiGoldWindowApi]::GetWindowRect($windowHandle, [ref]$rect)) {
    throw "Could not get window rect for screenshot."
  }
  $width = [Math]::Max(1, $rect.Right - $rect.Left)
  $height = [Math]::Max(1, $rect.Bottom - $rect.Top)
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  Write-JsonFile ([System.IO.Path]::ChangeExtension($Path, '.window.json')) $Window 6
}

function Invoke-ThreeWelcomeClicks($Window) {
  Ensure-WindowApi
  $windowHandle = [IntPtr]([int64]$Window.hwnd)
  [void][P2AiGoldWindowApi]::ShowWindow($windowHandle, 9)
  [void][P2AiGoldWindowApi]::SetForegroundWindow($windowHandle)
  Start-Sleep -Milliseconds 800
  $rect = New-Object P2AiGoldWindowApi+RECT
  if (-not [P2AiGoldWindowApi]::GetWindowRect($windowHandle, [ref]$rect)) {
    throw "Could not get window rect for welcome clicks."
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $clicks = @(
    @{ name = 'continue_without_signing_in_button_center'; x = [int]($rect.Left + ($width * 0.745)); y = [int]($rect.Top + ($height * 0.770)) },
    @{ name = 'continue_without_signing_in_button_right'; x = [int]($rect.Left + ($width * 0.785)); y = [int]($rect.Top + ($height * 0.770)) },
    @{ name = 'welcome_modal_close_x_fallback'; x = [int]($rect.Left + ($width * 0.804)); y = [int]($rect.Top + ($height * 0.212)) }
  )
  Write-JsonFile (Join-Path $script:ArtifactRoot 'vscode_welcome_click_plan.json') ([ordered]@{
    target_window = $Window
    window_rect = [ordered]@{
      left = $rect.Left
      top = $rect.Top
      right = $rect.Right
      bottom = $rect.Bottom
      width = $width
      height = $height
    }
    clicks = $clicks
  }) 8
  $events = @()
  foreach ($click in $clicks) {
    [void][P2AiGoldWindowApi]::SetCursorPos($click.x, $click.y)
    Start-Sleep -Milliseconds 250
    [P2AiGoldWindowApi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [P2AiGoldWindowApi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    $events += [pscustomobject]@{
      ts = (Get-Date).ToString('o')
      name = $click.name
      x = $click.x
      y = $click.y
    }
    Start-Sleep -Milliseconds 900
  }
  Write-JsonFile (Join-Path $script:ArtifactRoot 'vscode_welcome_three_clicks.json') $events 6
}

function Start-LmStudioLogStreams([string]$Directory) {
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  $streams = @(
    @{ name = 'server'; args = @('log','stream','--json','--stats','--source','server') },
    @{ name = 'runtime'; args = @('log','stream','--json','--stats','--source','runtime') },
    @{ name = 'model_input'; args = @('log','stream','--json','--stats','--source','model','--filter','input') },
    @{ name = 'model_output'; args = @('log','stream','--json','--stats','--source','model','--filter','output') }
  )
  $started = @()
  foreach ($stream in $streams) {
    try {
      $stdout = Join-Path $Directory ($stream.name + '.jsonl')
      $stderr = Join-Path $Directory ($stream.name + '.stderr.txt')
      $process = Start-Process -FilePath $script:LmsExe -ArgumentList $stream.args -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Hidden
      $started += [pscustomobject]@{ name = $stream.name; pid = $process.Id; stdout = $stdout; stderr = $stderr }
    } catch {
      $started += [pscustomobject]@{ name = $stream.name; error = $_.Exception.Message }
    }
  }
  Write-JsonFile (Join-Path $script:ArtifactRoot 'lmstudio_log_stream_processes.json') $started 6
  return $started
}

function Stop-StartedProcesses($Processes) {
  foreach ($entry in @($Processes)) {
    if (-not $entry.pid) {
      continue
    }
    try {
      Stop-Process -Id $entry.pid -Force -ErrorAction SilentlyContinue
    } catch {
      Write-Warning "Could not stop process $($entry.pid): $($_.Exception.Message)"
    }
  }
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
if (-not $ArtifactRoot) {
  $ArtifactRoot = Join-Path $RepoRoot "test_artifacts\acceptance\c2ai_gold_autostart_repro_$stamp"
}
$script:ArtifactRoot = $ArtifactRoot
$script:LmsExe = Get-LmsExe

New-Item -ItemType Directory -Force -Path $ArtifactRoot | Out-Null
Set-Content -LiteralPath (Join-Path $RepoRoot 'tmp_c2ai_gold_autostart_artifact.txt') -Value $ArtifactRoot -Encoding UTF8

$summary = [ordered]@{
  schema = 'p2ai.c2ai_gold.lmstudio_vscode_autostart'
  started_at = (Get-Date).ToString('o')
  status = 'running'
  artifact_root = $ArtifactRoot
  repo_root = $RepoRoot
  c2ai_gold_root = $C2AiGoldRoot
  lmstudio_base_url = $LmStudioBaseUrl
  model_id = $ModelId
  model_path = $ModelPath
  context_tokens = $ContextTokens
  completion_tokens = $CompletionTokens
}

$logProcesses = @()

try {
  if (-not (Test-Path -LiteralPath $RepoRoot)) {
    throw "RepoRoot does not exist: $RepoRoot"
  }
  if (-not (Test-Path -LiteralPath $C2AiGoldRoot)) {
    throw "C2AiGoldRoot does not exist: $C2AiGoldRoot"
  }

  Stop-VsCodeUpdater -Stage 'before_lmstudio'

  if (-not $SkipLmStudioStart) {
    $env:P2AI_LMSTUDIO_MODEL_PATH = $ModelPath
    $env:P2AI_LMSTUDIO_MODEL_IDENTIFIER = $ModelId
    $env:P2AI_LMSTUDIO_CONTEXT_LENGTH = "$ContextTokens"
    $env:P2AI_LMSTUDIO_GPU_OFFLOAD = $GpuOffload
    $env:P2AI_LMSTUDIO_EXPECTED_GPU_LAYERS = "$ExpectedGpuLayers"
    $lmBat = Join-Path $RepoRoot 'scripts\p2ai_stack\start_lmstudio_gui_via_explorer.bat'
    if (-not (Test-Path -LiteralPath $lmBat)) {
      throw "LM Studio starter BAT missing: $lmBat"
    }
    $lmOutput = Invoke-TextCommand { & $lmBat }
    Set-Content -LiteralPath (Join-Path $ArtifactRoot 'lmstudio_start_output.txt') -Value $lmOutput -Encoding UTF8
  }

  $serverStatus = Invoke-LmsText @('server','status')
  Set-Content -LiteralPath (Join-Path $ArtifactRoot 'lms_server_status.txt') -Value $serverStatus -Encoding UTF8
  if (-not (Test-LmsServerRunning $serverStatus)) {
    throw "LM Studio server is not running after start."
  }

  $psJson = Invoke-LmsText @('ps','--json')
  Set-Content -LiteralPath (Join-Path $ArtifactRoot 'lms_ps.json') -Value $psJson -Encoding UTF8
  $loadedModels = @($psJson | ConvertFrom-Json)
  $loaded = $loadedModels | Where-Object { $_.identifier -eq $ModelId } | Select-Object -First 1
  if (-not $loaded) {
    throw "LM Studio model alias is not loaded: $ModelId"
  }
  if ([int]$loaded.contextLength -ne $ContextTokens) {
    throw "LM Studio model context mismatch: requested $ContextTokens, loaded $($loaded.contextLength)"
  }

  $models = Wait-LmStudioModelsHttp -BaseUrl $LmStudioBaseUrl -TimeoutSeconds 60
  Write-JsonFile (Join-Path $ArtifactRoot 'http_v1_models.json') $models 20

  $logProcesses = Start-LmStudioLogStreams -Directory (Join-Path $ArtifactRoot 'lmstudio_log_streams')

  Stop-VsCodeUpdater -Stage 'before_vscode'
  Stop-ExistingExtensionDevelopmentHosts

  if (-not $SkipBuild) {
    $webviewRoot = Join-Path $C2AiGoldRoot 'webview-ui'
    $requiredWebviewModules = @(
      '@testing-library\jest-dom',
      '@vitejs\plugin-react-swc'
    )
    $missingWebviewModules = @(
      foreach ($modulePath in $requiredWebviewModules) {
        $candidate = Join-Path (Join-Path $webviewRoot 'node_modules') $modulePath
        if (-not (Test-Path -LiteralPath $candidate)) {
          $modulePath
        }
      }
    )
    if ($missingWebviewModules.Count -gt 0) {
      Write-JsonFile (Join-Path $ArtifactRoot 'c2ai_gold_webview_missing_modules.json') ([ordered]@{
        missing_modules = $missingWebviewModules
      }) 8
      $webviewInstallLogPath = Join-Path $ArtifactRoot 'c2ai_gold_webview_npm_ci.log'
      Push-Location $webviewRoot
      try {
        & npm.cmd ci --include=dev *> $webviewInstallLogPath
        $webviewInstallExitCode = $LASTEXITCODE
      } finally {
        Pop-Location
      }
      if ($webviewInstallExitCode -ne 0) {
        throw "C2Ai gold webview npm ci failed with exit code $webviewInstallExitCode. See $webviewInstallLogPath."
      }
    }

    $webviewBuildLogPath = Join-Path $ArtifactRoot 'c2ai_gold_webview_build.log'
    Push-Location $C2AiGoldRoot
    try {
      & npm.cmd run build:webview *> $webviewBuildLogPath
      $webviewBuildExitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if ($webviewBuildExitCode -ne 0) {
      throw "C2Ai gold webview build failed with exit code $webviewBuildExitCode. See $webviewBuildLogPath."
    }

    $webviewAssetsDir = Join-Path $C2AiGoldRoot 'webview-ui\build\assets'
    $webviewJs = Join-Path $webviewAssetsDir 'index.js'
    $webviewCss = Join-Path $webviewAssetsDir 'index.css'
    if (-not (Test-Path -LiteralPath $webviewJs) -or -not (Test-Path -LiteralPath $webviewCss)) {
      throw "C2Ai gold webview build incomplete. Missing $webviewJs or $webviewCss."
    }

    $esbuildLogPath = Join-Path $ArtifactRoot 'c2ai_gold_esbuild.log'
    Push-Location $C2AiGoldRoot
    try {
      & node esbuild.mjs *> $esbuildLogPath
      $esbuildExitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if ($esbuildExitCode -ne 0) {
      throw "C2Ai gold esbuild failed with exit code $esbuildExitCode. See $esbuildLogPath."
    }
  }

  $userDataDir = Join-Path $ArtifactRoot 'vscode_userdata'
  $extensionsDir = Join-Path $ArtifactRoot 'vscode_extensions'
  Initialize-DedicatedVsCodeUserDataDir -Path $userDataDir
  Initialize-DedicatedVsCodeWorkspaceState -UserDataDir $userDataDir -WorkspaceRoot $RepoRoot -DisableAgentsMd (-not [bool]$EnableAgentsMdRules)
  New-Item -ItemType Directory -Force -Path $extensionsDir | Out-Null

  $env:P2AI_CLINE_AUTOSTART_TASK = $AutostartTask
  $env:P2AI_CLINE_ARTIFACT_ROOT = $ArtifactRoot
  $env:P2AI_CLINE_AUTOSTART_DELAY_MS = "$AutostartDelayMs"
  $env:P2AI_CLINE_LMSTUDIO_BASE_URL = $LmStudioBaseUrl
  $env:P2AI_CLINE_LMSTUDIO_MODEL_ID = $ModelId
  $env:P2AI_CLINE_LMSTUDIO_CONTEXT_TOKENS = "$ContextTokens"
  $env:P2AI_CLINE_COMPACT_PROMPT = '1'
  $env:P2AI_CLINE_AGENTS_MD_RULES_DISABLED = if ($EnableAgentsMdRules) { '0' } else { '1' }
  $env:P2AI_C2AI_GEMMA4_PROTOCOL = 'kessler'
  $env:P2AI_C2AI_MAX_COMPLETION_TOKENS = "$CompletionTokens"
  $env:P2AI_CLINE_DEV_MONITOR = '1'
  $env:P2AI_CLINE_VISUAL_DIAGNOSTICS = '1'
  $env:P2AI_CLINE_ARTIFACT_MAX_STRING_CHARS = '35000'
  $env:P2AI_CLINE_DISABLE_CHECKPOINTS = '1'
  $env:P2AI_CLINE_AUTOSTART_ALLOW_WRITES = '0'
  $env:P2AI_CLINE_AUTOSTART_ALLOW_COMMANDS = 'none'

  $code = Get-Command code.cmd -ErrorAction SilentlyContinue
  if (-not $code) {
    $code = Get-Command code -ErrorAction Stop
  }

  $codeArgs = @(
    '--new-window',
    '--disable-workspace-trust',
    '--user-data-dir', $userDataDir,
    '--extensions-dir', $extensionsDir,
    '--extensionDevelopmentPath', $C2AiGoldRoot,
    $RepoRoot
  )
  $launchStartedAt = Get-Date
  $codeProcess = Start-Process -FilePath $code.Source -ArgumentList $codeArgs -PassThru

  Write-JsonFile (Join-Path $ArtifactRoot 'vscode_launch_metadata.json') ([ordered]@{
    code_command = $code.Source
    code_launcher_pid = $codeProcess.Id
    launch_started_at = $launchStartedAt.ToString('o')
    args = $codeArgs
    user_data_dir = $userDataDir
    extensions_dir = $extensionsDir
    extension_development_path = $C2AiGoldRoot
    env = [ordered]@{
      P2AI_CLINE_AUTOSTART_TASK = $env:P2AI_CLINE_AUTOSTART_TASK
      P2AI_CLINE_ARTIFACT_ROOT = $env:P2AI_CLINE_ARTIFACT_ROOT
      P2AI_CLINE_AUTOSTART_DELAY_MS = $env:P2AI_CLINE_AUTOSTART_DELAY_MS
      P2AI_CLINE_LMSTUDIO_BASE_URL = $env:P2AI_CLINE_LMSTUDIO_BASE_URL
      P2AI_CLINE_LMSTUDIO_MODEL_ID = $env:P2AI_CLINE_LMSTUDIO_MODEL_ID
      P2AI_CLINE_LMSTUDIO_CONTEXT_TOKENS = $env:P2AI_CLINE_LMSTUDIO_CONTEXT_TOKENS
      P2AI_CLINE_COMPACT_PROMPT = $env:P2AI_CLINE_COMPACT_PROMPT
      P2AI_CLINE_AGENTS_MD_RULES_DISABLED = $env:P2AI_CLINE_AGENTS_MD_RULES_DISABLED
      P2AI_C2AI_GEMMA4_PROTOCOL = $env:P2AI_C2AI_GEMMA4_PROTOCOL
      P2AI_C2AI_MAX_COMPLETION_TOKENS = $env:P2AI_C2AI_MAX_COMPLETION_TOKENS
      P2AI_CLINE_DEV_MONITOR = $env:P2AI_CLINE_DEV_MONITOR
      P2AI_CLINE_VISUAL_DIAGNOSTICS = $env:P2AI_CLINE_VISUAL_DIAGNOSTICS
      P2AI_CLINE_ARTIFACT_MAX_STRING_CHARS = $env:P2AI_CLINE_ARTIFACT_MAX_STRING_CHARS
      P2AI_CLINE_AUTOSTART_ALLOW_WRITES = $env:P2AI_CLINE_AUTOSTART_ALLOW_WRITES
      P2AI_CLINE_AUTOSTART_ALLOW_COMMANDS = $env:P2AI_CLINE_AUTOSTART_ALLOW_COMMANDS
    }
  }) 12

  $window = Wait-ExtensionHostWindow -StartedAfter $launchStartedAt -TimeoutSeconds $VsCodeWindowTimeoutSeconds
  Save-WindowScreenshot -Window $window -Path (Join-Path $ArtifactRoot 'screenshots\01_before_welcome_clicks.png')
  Invoke-ThreeWelcomeClicks -Window $window
  Start-Sleep -Seconds 3
  Stop-VsCodeUpdater -Stage 'after_vscode_launch'
  Save-WindowScreenshot -Window $window -Path (Join-Path $ArtifactRoot 'screenshots\02_after_three_welcome_clicks.png')

  if ($ObserveSeconds -gt 0) {
    Start-Sleep -Seconds $ObserveSeconds
    Save-WindowScreenshot -Window $window -Path (Join-Path $ArtifactRoot 'screenshots\03_after_autostart_observe.png')
  }

  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -like 'Code*' -or $_.ProcessName -eq 'lms' -or $_.ProcessName -like 'LM Studio*' } |
    Select-Object Id,ProcessName,MainWindowTitle,Path,StartTime |
    ConvertTo-Json -Depth 6 |
    Set-Content -LiteralPath (Join-Path $ArtifactRoot 'processes_final.json') -Encoding UTF8

  $summary.status = 'completed_preflight'
  $summary.completed_at = (Get-Date).ToString('o')
  $summary.target_window = $window
  Write-JsonFile (Join-Path $ArtifactRoot 'run_summary.json') $summary 20
  Write-Host "C2Ai gold autostart artifact: $ArtifactRoot"
  exit 0
} catch {
  $summary.status = 'failed'
  $summary.failed_at = (Get-Date).ToString('o')
  $summary.failure = $_.Exception.Message
  $summary.error_record = ($_ | Out-String)
  $summary.script_stack_trace = $_.ScriptStackTrace
  Write-JsonFile (Join-Path $ArtifactRoot 'run_summary.json') $summary 20
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if (-not $KeepLogStreams) {
    Stop-StartedProcesses -Processes $logProcesses
  }
}
