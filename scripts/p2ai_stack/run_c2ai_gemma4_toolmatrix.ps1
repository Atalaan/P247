param(
  [string]$RepoRoot = 'C:\PAI_Platform',
  [string]$ClineRoot = $(if ($env:P247_CLINE_ROOT) { $env:P247_CLINE_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }),
  [string]$ModelId = 'gemma-4-E4B-it-GGUF',
  [string]$LmStudioBaseUrl = 'http://127.0.0.1:1234',
  [int]$ContextTokens = 32768,
  [int]$CompletionTokens = 2048,
  [int]$TimeoutSecondsPerCase = 520,
  [int]$VsCodeWindowTimeoutSeconds = 90,
  [int]$ClineStartTimeoutSeconds = 120,
  [int]$VsCodeUpdateWaitSeconds = 15,
  [string[]]$CaseId = @(),
  [switch]$SkipBuild,
  [switch]$CloseVsCodeOnFailure,
  [switch]$DisableAgentsMdRules,
  [switch]$EnableAgentsMdRules
)

$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$disableAgentsMdRulesForRun = -not [bool]$EnableAgentsMdRules
if ($DisableAgentsMdRules) {
  $disableAgentsMdRulesForRun = $true
}

function Write-TextFile([string]$path, [string]$text) {
  $parent = Split-Path -Parent $path
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
}

function New-Slug([string]$value) {
  return ($value -replace '[^A-Za-z0-9_-]+', '_' -replace '_+', '_').Trim('_').ToLowerInvariant()
}

function Read-JsonFile([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  return Get-Content $path -Raw | ConvertFrom-Json
}

function Write-JsonFile([string]$path, $value, [int]$depth = 20) {
  Write-TextFile -path $path -text ($value | ConvertTo-Json -Depth $depth)
}

function Ensure-WindowScreenshotSupport {
  Add-Type -AssemblyName System.Drawing
  if (-not ('P2AiWindowCapture' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class P2AiWindowCapture {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, UInt32 nFlags);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  public static extern void mouse_event(UInt32 dwFlags, UInt32 dx, UInt32 dy, UInt32 dwData, UIntPtr dwExtraInfo);

  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, UInt32 dwFlags, UIntPtr dwExtraInfo);
}
"@
  }
}

function Initialize-DedicatedVsCodeUserDataDir([string]$Path) {
  $userDir = Join-Path $Path 'User'
  New-Item -ItemType Directory -Force -Path $userDir | Out-Null
  $settingsPath = Join-Path $userDir 'settings.json'
  $settings = [ordered]@{
    'workbench.startupEditor' = 'none'
    'workbench.welcomePage.walkthroughs.openOnInstall' = $false
    'extensions.ignoreRecommendations' = $true
    'telemetry.telemetryLevel' = 'off'
    'update.mode' = 'none'
    'github.copilot.enable' = [ordered]@{
      '*' = $false
    }
  }
  Write-JsonFile -path $settingsPath -value $settings -depth 8
}

function Initialize-DedicatedVsCodeWorkspaceState([string]$UserDataDir, [string]$WorkspaceRoot, [bool]$DisableAgentsMd) {
  if (-not $DisableAgentsMd) { return }
  $sqlite = Get-Command sqlite3.exe -ErrorAction SilentlyContinue
  if (-not $sqlite) {
    $sqlite = Get-Command sqlite3 -ErrorAction SilentlyContinue
  }
  if (-not $sqlite) {
    throw 'sqlite3 is required to preseed VS Code workspace state for -DisableAgentsMdRules.'
  }

  # VS Code uses a stable workspaceStorage id for this C:\PAI_Platform folder
  # across the dedicated test user-data dirs. Preseeding this workspace memento
  # disables the AGENTS.md project-rule toggle without modifying AGENTS.md.
  $workspaceStorageId = '01119fdce3d826a30d3cd1273d9f2466'
  $workspaceStorageDir = Join-Path $UserDataDir "User\workspaceStorage\$workspaceStorageId"
  New-Item -ItemType Directory -Force -Path $workspaceStorageDir | Out-Null
  $folderUri = 'file:///' + (($WorkspaceRoot -replace '\\', '/') -replace ':', '%3A')
  Write-JsonFile -path (Join-Path $workspaceStorageDir 'workspace.json') -value ([ordered]@{ folder = $folderUri }) -depth 4

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

function Dismiss-DedicatedVsCodeStartupDialogs([IntPtr]$windowHandle) {
  if ($windowHandle -eq [IntPtr]::Zero) { return $false }
  try {
    Ensure-WindowScreenshotSupport
    [P2AiWindowCapture]::ShowWindow($windowHandle, 9) | Out-Null
    [P2AiWindowCapture]::SetForegroundWindow($windowHandle) | Out-Null
    Start-Sleep -Milliseconds 500
    $rect = New-Object 'P2AiWindowCapture+RECT'
    if (-not [P2AiWindowCapture]::GetWindowRect($windowHandle, [ref]$rect)) { return $false }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) { return $false }

    # VS Code 1.123 can show a first-run Copilot dialog over the Extension
    # Development Host. Click its "Continue without Signing In" area on the
    # dedicated test window so screenshots can prove the C2Ai UI underneath.
    $clicks = @(
      @{ x = 0.78; y = 0.77; label = 'primary_bottom_right' },
      @{ x = 0.78; y = 0.77; label = 'primary_bottom_right_repeat' },
      @{ x = 0.81; y = 0.22; label = 'modal_close_x' },
      @{ x = 0.78; y = 0.77; label = 'primary_bottom_right_final' }
    )
    foreach ($click in $clicks) {
      $x = [int]($rect.Left + ($width * [double]$click.x))
      $y = [int]($rect.Top + ($height * [double]$click.y))
      [P2AiWindowCapture]::SetCursorPos($x, $y) | Out-Null
      Start-Sleep -Milliseconds 250
      [P2AiWindowCapture]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 80
      [P2AiWindowCapture]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 1000
    }
    for ($i = 0; $i -lt 2; $i++) {
      [P2AiWindowCapture]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 80
      [P2AiWindowCapture]::keybd_event(0x1B, 0, 0x0002, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 500
    }
    return $true
  } catch {
    Write-Warning "Could not dismiss VS Code startup dialog: $($_.Exception.Message)"
    return $false
  }
}

function Save-WindowScreenshot([IntPtr]$windowHandle, [string]$path) {
  if ($windowHandle -eq [IntPtr]::Zero) { return $false }
  try {
    Ensure-WindowScreenshotSupport
    [P2AiWindowCapture]::ShowWindow($windowHandle, 9) | Out-Null
    [P2AiWindowCapture]::SetForegroundWindow($windowHandle) | Out-Null
    Start-Sleep -Milliseconds 600
    $rect = New-Object 'P2AiWindowCapture+RECT'
    if (-not [P2AiWindowCapture]::GetWindowRect($windowHandle, [ref]$rect)) { return $false }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) { return $false }
    $parent = Split-Path -Parent $path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
      $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
      return $true
    } finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  } catch {
    Write-Warning "Could not capture VS Code window screenshot: $($_.Exception.Message)"
    return $false
  }
}

function Get-CodeProcessesForUserDataDir([string]$userDataDir) {
  Ensure-WindowScreenshotSupport
  $escaped = $userDataDir.Replace('\', '\\')
  $allCode = @(Get-CimInstance Win32_Process -Filter "Name = 'Code.exe'" -ErrorAction SilentlyContinue)
  $matched = @($allCode | Where-Object {
      ($_.CommandLine -and $_.CommandLine.Contains($userDataDir)) -or
      ($_.CommandLine -and $_.CommandLine.Contains($escaped))
    })

  $matchedIds = @{}
  foreach ($proc in $matched) { $matchedIds[[int]$proc.ProcessId] = $true }

  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($proc in $allCode) {
      $procId = [int]$proc.ProcessId
      $parentPid = [int]$proc.ParentProcessId
      if (-not $matchedIds.ContainsKey($procId) -and $matchedIds.ContainsKey($parentPid)) {
        $matchedIds[$procId] = $true
        $changed = $true
      }
    }
  }

  $results = @()
  foreach ($proc in $allCode) {
    $procId = [int]$proc.ProcessId
    if (-not $matchedIds.ContainsKey($procId)) { continue }
    $mainWindowHandle = 0
    $mainWindowTitle = ''
    $isVisible = $false
    $isMinimized = $false
    try {
      $psProc = Get-Process -Id $procId -ErrorAction Stop
      $mainWindowHandle = [int64]$psProc.MainWindowHandle
      $mainWindowTitle = $psProc.MainWindowTitle
      if ($mainWindowHandle -ne 0) {
        $windowHandle = [IntPtr][int64]$mainWindowHandle
        $isVisible = [P2AiWindowCapture]::IsWindowVisible($windowHandle)
        $isMinimized = [P2AiWindowCapture]::IsIconic($windowHandle)
      }
    } catch {
      $mainWindowHandle = 0
      $mainWindowTitle = ''
      $isVisible = $false
      $isMinimized = $false
    }
    $results += [pscustomobject]@{
      process_id = $procId
      parent_process_id = [int]$proc.ParentProcessId
      name = $proc.Name
      command_line = $proc.CommandLine
      creation_date = if ($proc.CreationDate -is [datetime]) {
        $proc.CreationDate.ToString('o')
      } elseif ($proc.CreationDate) {
        try { [Management.ManagementDateTimeConverter]::ToDateTime([string]$proc.CreationDate).ToString('o') } catch { [string]$proc.CreationDate }
      } else {
        $null
      }
      main_window_handle = $mainWindowHandle
      main_window_title = $mainWindowTitle
      has_window = ($mainWindowHandle -ne 0)
      is_visible = $isVisible
      is_minimized = $isMinimized
      has_visible_window = (($mainWindowHandle -ne 0) -and $isVisible)
    }
  }
  return $results
}

function Wait-CodeWindowForUserDataDir([string]$userDataDir, [int]$timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  $lastProcesses = @()
  while ((Get-Date) -lt $deadline) {
    $lastProcesses = @(Get-CodeProcessesForUserDataDir $userDataDir)
    $window = @($lastProcesses | Where-Object { $_.has_visible_window } | Select-Object -First 1)
    if ($window.Count -gt 0) {
      return [ordered]@{
        status = 'window_detected'
        selected_window = [ordered]@{
          process_id = $window[0].process_id
          main_window_handle = $window[0].main_window_handle
          main_window_title = $window[0].main_window_title
          is_visible = $window[0].is_visible
          is_minimized = $window[0].is_minimized
        }
        process_count = $lastProcesses.Count
        process_ids = @($lastProcesses | ForEach-Object { $_.process_id })
      }
    }
    Start-Sleep -Seconds 2
  }
  return [ordered]@{
    status = 'window_not_detected'
    selected_window = $null
    process_count = $lastProcesses.Count
    process_ids = @($lastProcesses | ForEach-Object { $_.process_id })
  }
}

function Get-LatestClineTaskDir([string]$userDataDir) {
  $tasksRoot = Join-Path $userDataDir 'User\globalStorage\saoudrizwan.claude-dev\tasks'
  if (-not (Test-Path -LiteralPath $tasksRoot)) { return $null }
  return @(Get-ChildItem -LiteralPath $tasksRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'ui_messages.json') } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1)[0]
}

function Wait-ClineArtifactStart([string]$artifactRoot, [string]$userDataDir, [int]$timeoutSeconds) {
  $candidatePaths = @(
    (Join-Path $artifactRoot 'cline_artifact_manifest.json'),
    (Join-Path $artifactRoot 'latest_c2ai_visual_state.json'),
    (Join-Path $artifactRoot 'latest_controller_state_radar.json'),
    (Join-Path $artifactRoot 'c2ai_visual_events.jsonl')
  )
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    foreach ($path in $candidatePaths) {
      if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path).Length -gt 0)) {
        return [ordered]@{
          status = 'artifact_detected'
          path = $path
          source = 'p2ai_artifact_root'
        }
      }
    }
    $taskDir = Get-LatestClineTaskDir -userDataDir $userDataDir
    if ($taskDir) {
      return [ordered]@{
        status = 'artifact_detected'
        path = (Join-Path $taskDir.FullName 'ui_messages.json')
        task_dir = $taskDir.FullName
        source = 'cline_global_storage'
      }
    }
    Start-Sleep -Seconds 2
  }
  return [ordered]@{
    status = 'artifact_not_detected'
    path = $null
    task_dir = $null
    source = $null
    expected_paths = $candidatePaths
  }
}

function Stop-CodeForUserDataDir([string]$userDataDir) {
  $processes = @(Get-CodeProcessesForUserDataDir $userDataDir)
  foreach ($proc in $processes) {
    try {
      Stop-Process -Id $proc.process_id -Force -ErrorAction Stop
    } catch {
      Write-Warning "Could not terminate Code.exe pid=$($proc.process_id): $($_.Exception.Message)"
    }
  }
}

function Stop-ExistingExtensionDevelopmentHosts([string]$logDir) {
  $hosts = @(
    Get-Process -Name Code -ErrorAction SilentlyContinue |
      Where-Object {
        $_.MainWindowHandle -ne [IntPtr]::Zero -and
        $_.MainWindowTitle.Contains('[Extension Development Host]') -and
        $_.MainWindowTitle.Contains('PAI_Platform')
      }
  )
  Write-JsonFile (Join-Path $logDir 'vscode_existing_extension_hosts_before.json') (
    $hosts | Select-Object Id,MainWindowTitle,Path,StartTime
  ) 8
  foreach ($hostProcess in $hosts) {
    try {
      Stop-Process -Id $hostProcess.Id -Force -ErrorAction Stop
    } catch {
      Write-Warning "Could not stop old Extension Development Host pid=$($hostProcess.Id): $($_.Exception.Message)"
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
  Write-JsonFile (Join-Path $logDir 'vscode_existing_extension_hosts_after.json') (
    $remaining | Select-Object Id,MainWindowTitle,Path,StartTime
  ) 8
}

function Get-CodeCommand {
  $cmd = Get-Command code.cmd -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cmd = Get-Command code -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $default = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'
  if (Test-Path $default) { return $default }
  $defaultExe = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'
  if (Test-Path $defaultExe) { return $defaultExe }
  throw 'Could not find VS Code code command.'
}

function Get-VsCodeUpdaterProcesses {
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      ($_.Name -like 'CodeSetup*') -or
      ($_.CommandLine -and $_.CommandLine -match 'vscode-stable-user-x64\\CodeSetup') -or
      ($_.CommandLine -and $_.CommandLine -match 'vscode-stable-user-x64.*update-progress')
    })
  return @($processes | ForEach-Object {
      [pscustomobject]@{
        process_id = [int]$_.ProcessId
        parent_process_id = [int]$_.ParentProcessId
        name = $_.Name
        command_line = $_.CommandLine
      }
    })
}

function Stop-VsCodeUpdaterProcesses {
  $processes = @(Get-VsCodeUpdaterProcesses)
  foreach ($proc in $processes) {
    try {
      Stop-Process -Id $proc.process_id -Force -ErrorAction Stop
    } catch {
      Write-Warning "Could not stop VS Code updater pid=$($proc.process_id): $($_.Exception.Message)"
    }
  }
  Start-Sleep -Seconds 2
  return [ordered]@{
    stopped_processes = $processes
    remaining_processes = @(Get-VsCodeUpdaterProcesses)
  }
}

function Get-VsCodeUpdateTempState {
  $stateDir = Join-Path $env:TEMP 'vscode-stable-user-x64'
  if (-not (Test-Path -LiteralPath $stateDir)) {
    return [ordered]@{
      state_dir = $stateDir
      exists = $false
      files = @()
    }
  }
  $files = @(Get-ChildItem -LiteralPath $stateDir -Force -ErrorAction SilentlyContinue | Select-Object FullName,Length,LastWriteTime)
  return [ordered]@{
    state_dir = $stateDir
    exists = $true
    files = @($files | ForEach-Object {
        [ordered]@{
          path = $_.FullName
          length = $_.Length
          last_write_time = $_.LastWriteTime.ToString('o')
        }
      })
  }
}

function Wait-VsCodeUpdaterIdle([int]$timeoutSeconds) {
  $samples = @()
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  do {
    $processes = @(Get-VsCodeUpdaterProcesses)
    $samples += [ordered]@{
      ts = (Get-Date).ToString('o')
      process_count = $processes.Count
      processes = $processes
    }
    if ($processes.Count -eq 0) {
      return [ordered]@{
        status = 'idle'
        timeout_seconds = $timeoutSeconds
        samples = $samples
        temp_state = Get-VsCodeUpdateTempState
      }
    }
    if ($timeoutSeconds -le 0) { break }
    Start-Sleep -Seconds ([Math]::Min(5, [Math]::Max(1, [int](($deadline - (Get-Date)).TotalSeconds))))
  } while ((Get-Date) -lt $deadline)

  $finalProcesses = @(Get-VsCodeUpdaterProcesses)
  return [ordered]@{
    status = 'update_in_progress'
    timeout_seconds = $timeoutSeconds
    samples = $samples
    final_processes = $finalProcesses
    temp_state = Get-VsCodeUpdateTempState
  }
}

function Get-VsCodeMainLogs([string]$userDataDir) {
  if (-not (Test-Path -LiteralPath $userDataDir)) { return @() }
  return @(Get-ChildItem -LiteralPath $userDataDir -Recurse -File -Filter main.log -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 5 |
    ForEach-Object {
      [ordered]@{
        path = $_.FullName
        length = $_.Length
        last_write_time = $_.LastWriteTime.ToString('o')
      }
    })
}

function Get-ToolCalls([string]$eventsPath) {
  if (-not (Test-Path $eventsPath)) { return @() }
  $calls = @()
  foreach ($line in Get-Content $eventsPath) {
    if (-not $line.Contains('gemma4_kessler_tool_call_emitted')) { continue }
    try {
      $event = $line | ConvertFrom-Json
      $args = $event.payload.arguments
      $calls += [ordered]@{
        created_at = $event.created_at
        tool_name = $event.payload.tool_name
        arguments = $args
      }
    } catch {
      $calls += [ordered]@{
        created_at = $null
        tool_name = 'parse_error'
        arguments = $line
      }
    }
  }
  return $calls
}

function Convert-ClineToolName([string]$toolName) {
  $map = @{
    readFile = 'read_file'
    listFiles = 'list_files'
    searchFiles = 'search_files'
    listCodeDefinitionNames = 'list_code_definition_names'
    writeToFile = 'write_to_file'
    replaceInFile = 'replace_in_file'
    executeCommand = 'execute_command'
    attemptCompletion = 'attempt_completion'
    askFollowupQuestion = 'ask_followup_question'
    planModeRespond = 'plan_mode_respond'
  }
  if ($map.ContainsKey($toolName)) { return $map[$toolName] }
  return $toolName
}

function Get-ToolCallsFromUiMessages([string]$messagesPath) {
  $messages = Read-JsonFile $messagesPath
  if (-not $messages) { return @() }
  $calls = @()
  foreach ($message in @($messages)) {
    if ($message.say -ne 'tool' -or -not $message.text) { continue }
    try {
      $payload = $message.text | ConvertFrom-Json
      $toolName = Convert-ClineToolName ([string]$payload.tool)
      $calls += [ordered]@{
        created_at = $message.ts
        tool_name = $toolName
        arguments = $payload
      }
    } catch {
      $calls += [ordered]@{
        created_at = $message.ts
        tool_name = 'parse_error'
        arguments = $message.text
      }
    }
  }
  return $calls
}

function Get-LastCompletion([string]$messagesPath) {
  $messages = Read-JsonFile $messagesPath
  if (-not $messages) { return $null }
  if ($messages.messages) {
    return @($messages.messages | Where-Object { $_.say -eq 'completion_result' } | Select-Object -Last 1)[0]
  }
  return @(@($messages) | Where-Object { $_.say -eq 'completion_result' } | Select-Object -Last 1)[0]
}

function Run-MatrixCase([hashtable]$case, [string]$matrixRoot, [string]$codeCommand, [string]$clineRoot) {
  $slug = New-Slug $case.id
  $matrixSlug = New-Slug (Split-Path $matrixRoot -Leaf)
  $artifactRoot = Join-Path $matrixRoot $slug
  $userDataDir = Join-Path (Join-Path $RepoRoot 'test_artifacts\vscode_userdata') "$matrixSlug`_$slug"
  $extensionsDir = Join-Path (Join-Path $RepoRoot 'test_artifacts\vscode_extensions') "$matrixSlug`_$slug"
  $screenshotsDir = Join-Path $artifactRoot 'vscode_window_screenshots'
  New-Item -ItemType Directory -Force -Path $artifactRoot, $userDataDir, $extensionsDir, $screenshotsDir | Out-Null
  Initialize-DedicatedVsCodeUserDataDir $userDataDir
  Initialize-DedicatedVsCodeWorkspaceState -UserDataDir $userDataDir -WorkspaceRoot $RepoRoot -DisableAgentsMd $disableAgentsMdRulesForRun

  Stop-CodeForUserDataDir $userDataDir
  $captureScript = Join-Path $RepoRoot 'scripts\p2ai_stack\capture_c2ai_lmstudio_vscode_logging.ps1'
  $beforeCaptureRoot = Join-Path $artifactRoot 'lmstudio_vscode_capture_before'
  if (Test-Path -LiteralPath $captureScript) {
    try {
      & $captureScript `
        -RepoRoot $RepoRoot `
        -ArtifactRoot $beforeCaptureRoot `
        -StreamSeconds 0 `
        -LmStudioBaseUrl $LmStudioBaseUrl | Out-Null
    } catch {
      Write-Warning "LM Studio pre-case capture failed for $($case.id): $($_.Exception.Message)"
    }
  }

  $env:P2AI_CLINE_ARTIFACT_ROOT = $artifactRoot
  $env:P2AI_CLINE_AUTOSTART_TASK = $case.prompt
  $env:P2AI_CLINE_AUTOSTART_DELAY_MS = '1800'
  $env:P2AI_CLINE_LMSTUDIO_BASE_URL = $LmStudioBaseUrl
  $env:P2AI_CLINE_LMSTUDIO_MODEL_ID = $ModelId
  $env:P2AI_CLINE_LMSTUDIO_CONTEXT_TOKENS = [string]$ContextTokens
  $env:P2AI_CLINE_COMPACT_PROMPT = '1'
  $env:P2AI_CLINE_AGENTS_MD_RULES_DISABLED = if ($disableAgentsMdRulesForRun) { '1' } else { '0' }
  $env:P2AI_C2AI_GEMMA4_PROTOCOL = 'kessler'
  $env:P2AI_C2AI_MAX_COMPLETION_TOKENS = [string]$CompletionTokens
  $env:P2AI_CLINE_DISABLE_CHECKPOINTS = '1'
  $env:P2AI_CLINE_DEV_MONITOR = '1'
  $env:P2AI_CLINE_VISUAL_DIAGNOSTICS = '1'
  $env:P2AI_CLINE_ARTIFACT_MAX_STRING_CHARS = '35000'
  $env:P2AI_CLINE_AUTOSTART_ALLOW_WRITES = if ($case.allowWrites) { '1' } else { '0' }
  $env:P2AI_CLINE_AUTOSTART_ALLOW_COMMANDS = if ($case.allowCommands) { $case.allowCommands } else { 'none' }

  $start = Get-Date
  $args = @(
    '--new-window',
    "--extensionDevelopmentPath=$clineRoot",
    "--user-data-dir=$userDataDir",
    "--extensions-dir=$extensionsDir",
    '--disable-extension',
    'GitHub.copilot',
    '--disable-extension',
    'GitHub.copilot-chat',
    $RepoRoot
  )
  $launchStatePath = Join-Path $artifactRoot 'vscode_launch_state.json'
  $launchState = [ordered]@{
    status = 'starting'
    started_at = $start.ToString('o')
    screenshot_rule = 'A benchmark VS Code launch is valid only after a PNG screenshot of the dedicated visible window has been captured.'
    code_command = $codeCommand
    argument_list = $args
    extension_development_path = $clineRoot
    user_data_dir = $userDataDir
    extensions_dir = $extensionsDir
    workspace = $RepoRoot
    launcher_process_id = $null
    launcher_exit_code = $null
    vscode_update_preflight = $null
    window_probe = $null
    cline_start_probe = $null
    vscode_main_logs = @()
    screenshots = @()
  }
  Write-JsonFile $launchStatePath $launchState

  $eventsPath = Join-Path $artifactRoot 'c2ai_visual_events.jsonl'
  $messagesPath = Join-Path $artifactRoot 'latest_cline_messages.json'
  $status = 'timeout'
  $deadline = $start.AddSeconds($TimeoutSecondsPerCase)
  $windowProbe = [ordered]@{
    status = 'not_started'
    selected_window = $null
    processes = @()
  }

  $updatePreflight = Wait-VsCodeUpdaterIdle -timeoutSeconds $VsCodeUpdateWaitSeconds
  $updatePreflightPath = Join-Path $artifactRoot 'vscode_update_preflight.json'
  $launchState.vscode_update_preflight = $updatePreflight
  $launchState.vscode_update_preflight_path = $updatePreflightPath
  Write-JsonFile $updatePreflightPath $updatePreflight
  Write-JsonFile $launchStatePath $launchState

  if ($updatePreflight.status -ne 'idle') {
    $updateStopPath = Join-Path $artifactRoot 'vscode_update_stop.json'
    $updateStop = Stop-VsCodeUpdaterProcesses
    Write-JsonFile $updateStopPath $updateStop
    $launchState.vscode_update_stop_path = $updateStopPath
    $updatePreflight = Wait-VsCodeUpdaterIdle -timeoutSeconds 10
    $launchState.vscode_update_preflight_after_stop = $updatePreflight
    Write-JsonFile $launchStatePath $launchState
  }

  if ($updatePreflight.status -ne 'idle') {
      $status = 'failed_vscode_update_in_progress'
      $deadline = Get-Date
      $launchState.status = 'failed_vscode_update_in_progress'
      Write-JsonFile $launchStatePath $launchState
      Write-Warning "VS Code updater/setup is still active after stop attempt; refusing to start benchmark VS Code without a visible-window guarantee."
  } else {
    Stop-ExistingExtensionDevelopmentHosts -logDir $artifactRoot
    Write-Host "Starting dedicated VS Code for case $($case.id) with user-data-dir: $userDataDir"
    $proc = Start-Process -FilePath $codeCommand -ArgumentList $args -WindowStyle Normal -PassThru
    if ($proc) {
      $launchState.launcher_process_id = $proc.Id
      Write-JsonFile $launchStatePath $launchState
    }

    $windowProbe = Wait-CodeWindowForUserDataDir -userDataDir $userDataDir -timeoutSeconds $VsCodeWindowTimeoutSeconds
    $launchState.window_probe = $windowProbe
    if ($proc -and $proc.HasExited) {
      $launchState.launcher_exit_code = $proc.ExitCode
    }
    $launchState.vscode_main_logs = @(Get-VsCodeMainLogs $userDataDir)

    if ($windowProbe.status -eq 'window_detected' -and $windowProbe.selected_window) {
      $windowScreenshot = Join-Path $screenshotsDir '01_after_window_detected.png'
      $windowHandle = [IntPtr][int64]$windowProbe.selected_window.main_window_handle
      $launchState.startup_dialog_dismissed_before_window_screenshot = Dismiss-DedicatedVsCodeStartupDialogs $windowHandle
      $windowScreenshotCaptured = Save-WindowScreenshot -windowHandle $windowHandle -path $windowScreenshot
      if ($windowScreenshotCaptured) {
        $launchState.screenshots += $windowScreenshot
        $launchState.window_screenshot = $windowScreenshot
      }
      $launchState.status = 'window_detected'
      Write-JsonFile $launchStatePath $launchState
      Write-Host "Detected dedicated VS Code window pid=$($windowProbe.selected_window.process_id) title='$($windowProbe.selected_window.main_window_title)'"

      if (-not $windowScreenshotCaptured) {
        $status = 'failed_vscode_screenshot_failed'
        $deadline = Get-Date
        $launchState.status = 'failed_vscode_screenshot_failed'
        Write-Warning "Dedicated VS Code window was detected, but its screenshot could not be captured for $($case.id)."
      } else {
        $clineStartProbe = Wait-ClineArtifactStart -artifactRoot $artifactRoot -userDataDir $userDataDir -timeoutSeconds $ClineStartTimeoutSeconds
        $launchState.cline_start_probe = $clineStartProbe
        if ($clineStartProbe.status -eq 'artifact_detected') {
          $clineScreenshot = Join-Path $screenshotsDir '02_after_cline_artifact.png'
          $freshWindow = @(Get-CodeProcessesForUserDataDir $userDataDir | Where-Object { $_.has_visible_window } | Select-Object -First 1)
          $clineScreenshotCaptured = $false
          if ($freshWindow.Count -gt 0) {
            $freshWindowHandle = [IntPtr][int64]$freshWindow[0].main_window_handle
            $launchState.startup_dialog_dismissed_before_cline_screenshot = Dismiss-DedicatedVsCodeStartupDialogs $freshWindowHandle
            $clineScreenshotCaptured = Save-WindowScreenshot -windowHandle $freshWindowHandle -path $clineScreenshot
            if ($clineScreenshotCaptured) {
              $launchState.screenshots += $clineScreenshot
              $launchState.cline_screenshot = $clineScreenshot
            }
          }
          if ($clineScreenshotCaptured) {
            $launchState.status = 'cline_artifact_detected'
            Write-Host "Cline/C2Ai artifact detected for case $($case.id): $($clineStartProbe.path)"
          } else {
            $status = 'failed_cline_screenshot_failed'
            $deadline = Get-Date
            $launchState.status = 'failed_cline_screenshot_failed'
            Write-Warning "Cline/C2Ai artifact appeared, but the dedicated VS Code window screenshot could not be captured after artifact start."
          }
        } else {
          $status = 'failed_cline_not_started'
          $deadline = Get-Date
          $launchState.status = 'failed_cline_not_started'
          Write-Warning "Dedicated VS Code opened and was screenshotted, but no Cline/C2Ai artifact appeared for $($case.id) within $ClineStartTimeoutSeconds seconds."
        }
      }
      Write-JsonFile $launchStatePath $launchState
    } else {
      $status = 'failed_vscode_not_opened'
      $deadline = Get-Date
      $launchState.status = 'failed_vscode_not_opened'
      Write-JsonFile $launchStatePath $launchState
      Write-Warning "No dedicated VS Code window appeared for $($case.id) within $VsCodeWindowTimeoutSeconds seconds."
    }
  }

  $lastProgress = ''
  while ((Get-Date) -lt $deadline) {
    $haveCompletion = $false
    $haveFailure = $false
    $haveRequestFailure = $false
    $activeMessagesPath = $messagesPath
    $taskDir = Get-LatestClineTaskDir -userDataDir $userDataDir
    if (-not (Test-Path $activeMessagesPath) -and $taskDir) {
      $activeMessagesPath = Join-Path $taskDir.FullName 'ui_messages.json'
    }
    if (Test-Path $activeMessagesPath) {
      $rawMessages = Get-Content $activeMessagesPath -Raw
      $haveCompletion = $rawMessages -match '"completion_result"'
    }
    if (Test-Path $eventsPath) {
      $rawEvents = Get-Content $eventsPath -Raw
      $haveFailure = $rawEvents -match 'autostart_failed'
      $haveRequestFailure = $rawEvents -match 'gemma4_kessler_request_failed'
    }
    $toolCallsForProgress = @(Get-ToolCalls $eventsPath)
    if ($toolCallsForProgress.Count -eq 0 -and (Test-Path $activeMessagesPath)) {
      $toolCallsForProgress = @(Get-ToolCallsFromUiMessages $activeMessagesPath)
    }
    $toolNames = @($toolCallsForProgress | ForEach-Object { $_.tool_name })
    $progress = "$(Get-Date -Format HH:mm:ss) [$($case.id)] tools=$($toolNames -join ',') completion=$haveCompletion"
    if ($progress -ne $lastProgress) {
      Write-Host $progress
      $lastProgress = $progress
    }
    if ($haveCompletion) { $status = 'completed'; break }
    if ($haveFailure -or $haveRequestFailure) { $status = 'failed'; break }
    Start-Sleep -Seconds 10
  }

  Start-Sleep -Seconds 2
  $activeMessagesPath = $messagesPath
  $taskDir = Get-LatestClineTaskDir -userDataDir $userDataDir
  if (-not (Test-Path $activeMessagesPath) -and $taskDir) {
    $activeMessagesPath = Join-Path $taskDir.FullName 'ui_messages.json'
  }
  $toolCalls = @(Get-ToolCalls $eventsPath)
  if ($toolCalls.Count -eq 0 -and (Test-Path $activeMessagesPath)) {
    $toolCalls = @(Get-ToolCallsFromUiMessages $activeMessagesPath)
  }
  $completion = Get-LastCompletion $activeMessagesPath
  $rawMessages = if (Test-Path $activeMessagesPath) { Get-Content $activeMessagesPath -Raw } else { '' }
  $rawEvents = if (Test-Path $eventsPath) { Get-Content $eventsPath -Raw } else { '' }
  $durationMs = [int]((Get-Date) - $start).TotalMilliseconds
  $finalWindow = @(Get-CodeProcessesForUserDataDir $userDataDir | Where-Object { $_.has_window } | Select-Object -First 1)
  if ($finalWindow.Count -gt 0) {
    $finalScreenshotName = if ($status -eq 'completed') { '99_final.png' } else { "99_$status.png" }
    $finalScreenshot = Join-Path $screenshotsDir $finalScreenshotName
    $finalWindowHandle = [IntPtr][int64]$finalWindow[0].main_window_handle
    $launchState.startup_dialog_dismissed_before_final_screenshot = Dismiss-DedicatedVsCodeStartupDialogs $finalWindowHandle
    if (Save-WindowScreenshot -windowHandle $finalWindowHandle -path $finalScreenshot) {
      $launchState.screenshots += $finalScreenshot
    }
    $launchState.final_window = [ordered]@{
      process_id = $finalWindow[0].process_id
      main_window_handle = $finalWindow[0].main_window_handle
      main_window_title = $finalWindow[0].main_window_title
      is_visible = $finalWindow[0].is_visible
      is_minimized = $finalWindow[0].is_minimized
    }
  }
  $launchState.completed_at = (Get-Date).ToString('o')
  $launchState.final_status = $status
  Write-JsonFile $launchStatePath $launchState
  $afterCaptureRoot = Join-Path $artifactRoot 'lmstudio_vscode_capture_after'
  if (Test-Path -LiteralPath $captureScript) {
    try {
      & $captureScript `
        -RepoRoot $RepoRoot `
        -ArtifactRoot $afterCaptureRoot `
        -StreamSeconds 0 `
        -LmStudioBaseUrl $LmStudioBaseUrl `
        -ExistingClineArtifactRoot $artifactRoot | Out-Null
    } catch {
      Write-Warning "LM Studio post-case capture failed for $($case.id): $($_.Exception.Message)"
    }
  }

  $result = [ordered]@{
    id = $case.id
    description = $case.description
    prompt = $case.prompt
    expected_tools = $case.expectedTools
    status = $status
    duration_ms = $durationMs
    artifact_root = $artifactRoot
    vscode_launch_state = $launchStatePath
    vscode_update_preflight = $updatePreflightPath
    vscode_window_screenshots = $launchState.screenshots
    vscode_window_detected = ($windowProbe.status -eq 'window_detected')
    screenshot_requirement_status = if (@($launchState.screenshots).Count -gt 0) {
      'satisfied'
    } elseif ($status -eq 'failed_vscode_update_in_progress') {
      'blocked_before_window_launch'
    } else {
      'failed_no_dedicated_window_screenshot'
    }
    cline_start_artifact = if ($launchState.cline_start_probe -and $launchState.cline_start_probe.path) { $launchState.cline_start_probe.path } else { $null }
    lmstudio_capture_before = $beforeCaptureRoot
    lmstudio_capture_after = $afterCaptureRoot
    allow_writes = [bool]$case.allowWrites
    allow_commands = if ($case.allowCommands) { $case.allowCommands } else { 'none' }
    tool_calls = $toolCalls
    tool_names = @($toolCalls | ForEach-Object { $_.tool_name })
    completion_text = if ($completion -and $completion.text) { $completion.text } else { $null }
    has_null_command_regression = (($rawMessages -match '"ask"\s*:\s*"command"') -and ($rawMessages -match '"text"\s*:\s*"null"'))
    has_request_failure = ($rawEvents -match 'gemma4_kessler_request_failed')
  }
  Write-JsonFile -path (Join-Path $artifactRoot 'case_result.json') -value $result -depth 20
  if (($status -eq 'completed') -or $CloseVsCodeOnFailure) {
    Stop-CodeForUserDataDir $userDataDir
  } else {
    Write-Warning "Leaving dedicated VS Code open for inspection because case status is '$status'. Rerun with -CloseVsCodeOnFailure to auto-close it."
  }
  return $result
}

$clineRoot = $ClineRoot
if (-not (Test-Path -LiteralPath $clineRoot)) {
  throw "ClineRoot does not exist: $clineRoot"
}
$codeCommand = Get-CodeCommand
$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$matrixRoot = Join-Path $RepoRoot "test_artifacts\acceptance\c2ai_gemma4_toolmatrix_$timestamp"
New-Item -ItemType Directory -Force -Path $matrixRoot | Out-Null

if (-not $SkipBuild) {
  $webviewRoot = Join-Path $clineRoot 'webview-ui'
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
    Write-JsonFile (Join-Path $matrixRoot 'c2ai_gold_webview_missing_modules.json') ([ordered]@{
      missing_modules = $missingWebviewModules
    }) 8
    $webviewInstallLogPath = Join-Path $matrixRoot 'c2ai_gold_webview_npm_ci.log'
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

  $webviewBuildLogPath = Join-Path $matrixRoot 'c2ai_gold_webview_build.log'
  try {
    Push-Location $clineRoot
    & npm.cmd run build:webview *> $webviewBuildLogPath
    $webviewBuildExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($webviewBuildExitCode -ne 0) {
    throw "C2Ai gold webview build failed with exit code $webviewBuildExitCode. See $webviewBuildLogPath."
  }

  $webviewAssetsDir = Join-Path $clineRoot 'webview-ui\build\assets'
  $webviewJs = Join-Path $webviewAssetsDir 'index.js'
  $webviewCss = Join-Path $webviewAssetsDir 'index.css'
  if (-not (Test-Path -LiteralPath $webviewJs) -or -not (Test-Path -LiteralPath $webviewCss)) {
    throw "C2Ai gold webview build incomplete. Missing $webviewJs or $webviewCss."
  }

  $esbuildLogPath = Join-Path $matrixRoot 'c2ai_gold_esbuild.log'
  Push-Location $clineRoot
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

$pythonPath = "test_artifacts/c2ai_toolmatrix/$timestamp/gemma4_word_stats.py"
$cases = @(
  @{
    id = 'read_file_summary'
    description = 'Read a known markdown file and summarize it.'
    expectedTools = @('read_file', 'attempt_completion')
    allowWrites = $false
    allowCommands = 'none'
    prompt = 'Vertel me kort wat er in docs/CLINE_CODEBASE_ANALYSIS/00_INDEX_OVERZICHT.md staat. Gebruik tools als je de inhoud niet kent.'
  },
  @{
    id = 'list_files_docs'
    description = 'List files in a documentation directory.'
    expectedTools = @('list_files', 'attempt_completion')
    allowWrites = $false
    allowCommands = 'none'
    prompt = 'Welke bestanden staan in docs/CLINE_CODEBASE_ANALYSIS? Gebruik de passende tool en noem maximaal 8 bestandsnamen.'
  },
  @{
    id = 'search_files_hostbridge'
    description = 'Search docs for HostBridge references.'
    expectedTools = @('search_files', 'attempt_completion')
    allowWrites = $false
    allowCommands = 'none'
    prompt = 'Zoek in docs/CLINE_CODEBASE_ANALYSIS naar HostBridge. Geef de relevante bestandsnamen en een korte conclusie.'
  },
  @{
    id = 'code_definitions_lmstudio'
    description = 'Inspect code definitions in the LM Studio provider.'
    expectedTools = @('list_code_definition_names', 'attempt_completion')
    allowWrites = $false
    allowCommands = 'none'
    prompt = 'Welke top-level classes of functies staan in third_party/SAM/Cline_Agent/Cline/src/core/api/providers/lmstudio.ts? Gebruik de passende code-inspectietool.'
  },
  @{
    id = 'python_write_execute'
    description = 'Write a Python script into test_artifacts and execute it.'
    expectedTools = @('write_to_file', 'execute_command', 'attempt_completion')
    allowWrites = $true
    allowCommands = 'all'
    prompt = "Maak een klein Python script in $pythonPath dat de zin 'C2Ai Gemma4 toolmatrix test' analyseert en JSON print met word_count en uppercase. Voer het daarna uit met python en geef exact de output. Schrijf alleen in test_artifacts/c2ai_toolmatrix/$timestamp."
  },
  @{
    id = 'python_command_only'
    description = 'Run a safe Python one-liner and summarize stdout.'
    expectedTools = @('execute_command', 'attempt_completion')
    allowWrites = $false
    allowCommands = 'all'
    prompt = 'Voer een veilige Python one-liner uit die JSON print met python_version_major en sum=2+2. Geef daarna exact de stdout terug.'
  }
)

if ($CaseId.Count -gt 0) {
  $requestedCaseIds = @($CaseId | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $cases = @($cases | Where-Object { $requestedCaseIds -contains $_.id })
  if ($cases.Count -eq 0) {
    throw "No benchmark cases matched -CaseId: $($requestedCaseIds -join ', ')"
  }
}

$results = @()
foreach ($case in $cases) {
  $results += Run-MatrixCase -case $case -matrixRoot $matrixRoot -codeCommand $codeCommand -clineRoot $clineRoot
}

$summary = [ordered]@{
  schema = 'p2ai.c2ai.gemma4.toolmatrix'
  version = 1
  created_at = (Get-Date).ToString('o')
  matrix_root = $matrixRoot
  repo_root = $RepoRoot
  cline_root = $clineRoot
  model_id = $ModelId
  lmstudio_base_url = $LmStudioBaseUrl
  context_tokens = $ContextTokens
  completion_tokens = $CompletionTokens
  results = $results
}
$summaryPath = Join-Path $matrixRoot 'toolmatrix_summary.json'
Write-JsonFile -path $summaryPath -value $summary -depth 30

$lines = @()
$lines += "# C2Ai Gemma4 Toolmatrix $timestamp"
$lines += ""
$lines += "| Case | Status | Duration ms | Tool calls | Artifact |"
$lines += "|---|---:|---:|---|---|"
foreach ($result in $results) {
  $toolText = if ($result.tool_names.Count -gt 0) { ($result.tool_names -join ', ') } else { '-' }
  $lines += "| $($result.id) | $($result.status) | $($result.duration_ms) | $toolText | $($result.artifact_root) |"
}
$lines += ""
$lines += "## Notes"
$lines += ""
$lines += '- `has_null_command_regression` must remain false.'
$lines += "- ``python_write_execute`` is limited to ``test_artifacts/c2ai_toolmatrix/$timestamp``."
$lines += '- Tool choice is evaluated from `gemma4_kessler_tool_call_emitted` diagnostic events.'
$mdPath = Join-Path $matrixRoot 'toolmatrix_summary.md'
Write-TextFile -path $mdPath -text ($lines -join [Environment]::NewLine)

Write-Host "SUMMARY_JSON=$summaryPath"
Write-Host "SUMMARY_MD=$mdPath"
$summary | ConvertTo-Json -Depth 30
