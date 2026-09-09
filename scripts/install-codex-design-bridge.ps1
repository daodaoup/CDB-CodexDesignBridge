[CmdletBinding()]
param(
  [string]$SourcePath = "",
  [string]$DestinationRoot = "",
  [string]$CodexCommand = "codex.cmd",
  [string]$Marketplace = "personal",
  [string]$ReportPath = "",
  [switch]$CheckOnly,
  [switch]$SkipProcessCheck,
  [switch]$WaitForExit,
  [int]$WaitTimeoutSeconds = 600
)

$ErrorActionPreference = "Stop"
$pluginName = "codex-design-bridge"
$pluginSelector = "$pluginName@$Marketplace"
$profileDirectory = [Environment]::GetFolderPath("UserProfile")
$localAppDataDirectory = [Environment]::GetFolderPath("LocalApplicationData")
if (-not $localAppDataDirectory) {
  $localAppDataDirectory = Join-Path $profileDirectory "AppData\Local"
}
$dedicatedMarketplaceRootOverride = $env:CODEX_DESIGN_BRIDGE_LOCAL_MARKETPLACE_ROOT
$marketplaceExplicit = $PSBoundParameters.ContainsKey("Marketplace")
$destinationRootExplicit = $PSBoundParameters.ContainsKey("DestinationRoot") -and [bool]$DestinationRoot
$reportPathExplicit = $PSBoundParameters.ContainsKey("ReportPath") -and [bool]$ReportPath
$bootstrapMarketplace = $false
$marketplaceAdded = $false
$needsMarketplaceAdd = $false
$localMarketplaceRoot = ""
$mcpNodePath = ""
$scriptDirectory = Split-Path -Parent $PSCommandPath
$packageRoot = Split-Path -Parent $scriptDirectory
$coreFiles = @(
  ".codex-plugin\plugin.json",
  ".mcp.json",
  "assets\icon.png",
  "mcp\browser-capture.mjs",
  "mcp\workspace.html",
  "mcp\gateway.mjs",
  "mcp\daemon.mjs",
  "mcp\server.mjs",
  "mcp\fast-page-patch.mjs",
  "mcp\local-figma-bridge.mjs",
  "mcp\local-workspace-server.mjs",
  "mcp\design-offer-store.mjs",
  "mcp\sync-baseline-store.mjs",
  "mcp\patch-transaction.mjs",
  "mcp\project-contract.mjs",
  "mcp\preview-process-guard.cjs",
  "mcp\workspace-lease.mjs",
  "shared\page-capture.mjs",
  "shared\change-set-v16.schema.json",
  "shared\design-offer-v16.schema.json",
  "shared\page-ir-responsive-v2.mjs",
  "shared\page-ir-responsive-v2.schema.json",
  "shared\runtime-contract.mjs",
  "shared\page.mjs",
  "shared\svg.mjs",
  "skills\start-design\SKILL.md",
  "skills\start-design\agents\openai.yaml"
)

function Resolve-PluginSource {
  param([string]$RequestedPath)

  $candidates = @()
  if ($RequestedPath) {
    $candidates += $RequestedPath
  } else {
    $candidates += (Join-Path $packageRoot "codex-plugin\$pluginName")
    $candidates += (Join-Path $packageRoot $pluginName)
  }

  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
      continue
    }
    $resolved = (Resolve-Path -LiteralPath $candidate).Path
    if (Test-Path -LiteralPath (Join-Path $resolved ".codex-plugin\plugin.json") -PathType Leaf) {
      return $resolved
    }
  }

  throw "Codex Design Bridge source was not found. Extract the complete release package and try again."
}

function Read-PluginManifest {
  param([string]$PluginPath)

  $manifestPath = Join-Path $PluginPath ".codex-plugin\plugin.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Plugin manifest was not found: $manifestPath"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
  if ($manifest.name -ne $pluginName) {
    throw "Unexpected plugin manifest name: $($manifest.name)"
  }
  if (-not $manifest.version) {
    throw "Plugin manifest does not contain a version."
  }
  foreach ($relativePath in $coreFiles) {
    $fullPath = Join-Path $PluginPath $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "Release package is missing a core file: $relativePath"
    }
  }
  return $manifest
}

function Get-CoreHashes {
  param([string]$PluginPath)

  $hashes = [ordered]@{}
  foreach ($relativePath in $coreFiles) {
    $normalized = $relativePath.Replace("\", "/")
    $hashes[$normalized] = (Get-FileHash -LiteralPath (Join-Path $PluginPath $relativePath) -Algorithm SHA256).Hash
  }
  return $hashes
}

function Assert-HashesMatch {
  param(
    [System.Collections.IDictionary]$Expected,
    [System.Collections.IDictionary]$Actual,
    [string]$Label
  )

  foreach ($relativePath in $Expected.Keys) {
    if ($Expected[$relativePath] -ne $Actual[$relativePath]) {
      throw "$Label file verification failed: $relativePath"
    }
  }
}

function Resolve-CodexCommandPath {
  param([string]$RequestedCommand)

  if ($RequestedCommand -and $RequestedCommand -ne "codex.cmd") {
    if (Test-Path -LiteralPath $RequestedCommand -PathType Leaf) {
      return (Resolve-Path -LiteralPath $RequestedCommand).Path
    }
    $explicitCommand = Get-Command $RequestedCommand -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($explicitCommand) {
      return $explicitCommand.Source
    }
    throw "Codex command was not found: $RequestedCommand"
  }

  $localBinRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
  if (Test-Path -LiteralPath $localBinRoot -PathType Container) {
    $localExecutables = @(
      Get-ChildItem -LiteralPath $localBinRoot -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName "codex.exe" } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        ForEach-Object { Get-Item -LiteralPath $_ }
    )
    $localExecutable = $localExecutables |
      Sort-Object LastWriteTimeUtc -Descending |
      Select-Object -First 1
    if ($localExecutable) {
      return $localExecutable.FullName
    }
  }

  foreach ($candidate in @("codex.cmd", "codex.exe", "codex")) {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($command) {
      return $command.Source
    }
  }

  throw "Codex CLI was not found. Reinstall or update Codex, then run this installer again."
}

function Resolve-NodeCommandPath {
  $candidates = @(
    (Join-Path $profileDirectory ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\node.exe"),
    (Join-Path $profileDirectory ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"),
    (Join-Path $localAppDataDirectory "Programs\ChatGPT\resources\cua_node\node.exe"),
    (Join-Path $localAppDataDirectory "Programs\Codex\resources\cua_node\node.exe"),
    (Join-Path $localAppDataDirectory "OpenAI\ChatGPT\resources\cua_node\node.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  foreach ($candidate in @("node.exe", "node")) {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($command) {
      return $command.Source
    }
  }
  throw "A Node.js runtime was not found. Reinstall or update Codex, then run this installer again."
}

function Set-McpRuntime {
  param([string]$PluginPath)

  $script:mcpNodePath = Resolve-NodeCommandPath
  $configPath = Join-Path $PluginPath ".mcp.json"
  $config = Get-Content -LiteralPath $configPath -Raw -Encoding utf8 | ConvertFrom-Json
  if (-not $config.mcpServers -or -not $config.mcpServers.design_workspace) {
    throw "design_workspace MCP configuration was not found."
  }
  $config.mcpServers.design_workspace.command = $script:mcpNodePath
  $config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding utf8
}

function Invoke-CodexJson {
  param([string[]]$Arguments)

  $output = & $CodexCommand @Arguments 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "Codex command failed with exit code $LASTEXITCODE`: $output"
  }
  try {
    return $output | ConvertFrom-Json
  } catch {
    throw "Codex command did not return valid JSON: $output"
  }
}

function Get-InstalledPlugin {
  $listing = Invoke-CodexJson -Arguments @("plugin", "list", "--json")
  return @($listing.installed) |
    Where-Object { $_.pluginId -eq $pluginSelector } |
    Select-Object -First 1
}

function Get-MarketplaceRoot {
  $listing = Invoke-CodexJson -Arguments @("plugin", "marketplace", "list", "--json")
  $entry = @($listing.marketplaces) |
    Where-Object { $_.name -eq $Marketplace } |
    Select-Object -First 1
  if ($entry) {
    return [string]$entry.root
  }
  return ""
}

function Test-MarketplaceContainsPlugin {
  param([string]$MarketplacePath)

  if (-not (Test-Path -LiteralPath $MarketplacePath -PathType Leaf)) {
    return $false
  }
  $config = Get-Content -LiteralPath $MarketplacePath -Raw -Encoding utf8 | ConvertFrom-Json
  return [bool](@($config.plugins) | Where-Object { $_.name -eq $pluginName } | Select-Object -First 1)
}

function Write-LocalMarketplace {
  param([string]$MarketplacePath)

  $directory = Split-Path -Parent $MarketplacePath
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $payload = [ordered]@{
    name = $Marketplace
    interface = [ordered]@{ displayName = "Codex Design Bridge Local" }
    plugins = @(
      [ordered]@{
        name = $pluginName
        source = [ordered]@{ source = "local"; path = "./plugins/$pluginName" }
        policy = [ordered]@{ installation = "AVAILABLE"; authentication = "ON_INSTALL" }
        category = "Productivity"
      }
    )
  }
  $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $MarketplacePath -Encoding utf8
}

function Assert-SafeManagedPath {
  param(
    [string]$PathToCheck,
    [string]$ExpectedParent,
    [string[]]$AllowedLeafNames
  )

  $fullPath = [IO.Path]::GetFullPath($PathToCheck).TrimEnd("\")
  $fullParent = [IO.Path]::GetFullPath($ExpectedParent).TrimEnd("\")
  $actualParent = Split-Path -Parent $fullPath
  $leaf = Split-Path -Leaf $fullPath
  if ($actualParent -ne $fullParent -or $leaf -notin $AllowedLeafNames) {
    throw "Refusing to operate on an unverified path: $fullPath"
  }
}

function Write-InstallReport {
  param([hashtable]$Report)

  $reportDirectory = Split-Path -Parent $ReportPath
  if ($reportDirectory) {
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
  }
  $Report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding utf8
}

$source = Resolve-PluginSource -RequestedPath $SourcePath
$manifest = Read-PluginManifest -PluginPath $source
$sourceHashes = Get-CoreHashes -PluginPath $source

if (-not $DestinationRoot) {
  $DestinationRoot = Join-Path $profileDirectory "plugins"
}
$DestinationRoot = [IO.Path]::GetFullPath($DestinationRoot)
if (-not $ReportPath) {
  $ReportPath = Join-Path $DestinationRoot ".codex-design-bridge-install-report.json"
}
$ReportPath = [IO.Path]::GetFullPath($ReportPath)

if ($CheckOnly) {
  Write-InstallReport -Report @{
    plugin = $pluginName
    version = $manifest.version
    checkedAt = (Get-Date).ToString("o")
    checkOnly = $true
    sourcePath = $source
    coreFileCount = $coreFiles.Count
    hashes = $sourceHashes
    status = "package-valid"
  }
  Write-Host "Release package verified: Codex Design Bridge $($manifest.version)"
  Write-Host "Report: $ReportPath"
  exit 0
}

if (-not $SkipProcessCheck) {
  $blockingProcesses = @(
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ProcessName -in @("ChatGPT", "Codex") }
  )
  if ($blockingProcesses.Count -gt 0) {
    $processSummary = ($blockingProcesses |
      Sort-Object ProcessName, Id |
      ForEach-Object { "$($_.ProcessName) (PID $($_.Id))" }) -join ", "
    if ($WaitForExit) {
      Write-Host "Waiting for Codex/ChatGPT to exit: $processSummary"
      $deadline = (Get-Date).AddSeconds([Math]::Max(1, $WaitTimeoutSeconds))
      do {
        Start-Sleep -Milliseconds 500
        $blockingProcesses = @(
          Get-Process -ErrorAction SilentlyContinue |
            Where-Object { $_.ProcessName -in @("ChatGPT", "Codex") }
        )
      } while ($blockingProcesses.Count -gt 0 -and (Get-Date) -lt $deadline)
      if ($blockingProcesses.Count -gt 0) {
        throw "Timed out waiting for Codex/ChatGPT to exit. No plugin files were changed."
      }
      Write-Host "Codex/ChatGPT exited. Continuing installation..."
    } else {
      Write-Warning "Codex/ChatGPT background processes are still running: $processSummary"
      $answer = Read-Host "Close these processes automatically and continue? [Y/N]"
      if ($answer -notmatch "^(?i:y|yes)$") {
        throw "Installation cancelled. Close Codex/ChatGPT and run the installer again."
      }

      $stopErrors = @()
      foreach ($process in $blockingProcesses) {
        try {
          Stop-Process -Id $process.Id -Force -ErrorAction Stop
        } catch {
          if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) {
            $stopErrors += "$($process.ProcessName) (PID $($process.Id)): $($_.Exception.Message)"
          }
        }
      }
      Start-Sleep -Milliseconds 1200

      $remainingProcesses = @(
        Get-Process -ErrorAction SilentlyContinue |
          Where-Object { $_.ProcessName -in @("ChatGPT", "Codex") }
      )
      if ($stopErrors.Count -gt 0 -or $remainingProcesses.Count -gt 0) {
        $details = @($stopErrors)
        $details += $remainingProcesses |
          Sort-Object ProcessName, Id |
          ForEach-Object { "$($_.ProcessName) (PID $($_.Id)) is still running" }
        throw "Could not close all Codex/ChatGPT processes. $($details -join '; ')"
      }
      Write-Host "Codex/ChatGPT processes closed. Continuing installation..."
    }
  }
}

$CodexCommand = Resolve-CodexCommandPath -RequestedCommand $CodexCommand
Write-Host "Using Codex CLI: $CodexCommand"

$marketplacePath = Join-Path $profileDirectory ".agents\plugins\marketplace.json"
if ($Marketplace -eq "personal" -and -not (Test-MarketplaceContainsPlugin -MarketplacePath $marketplacePath)) {
  if ($marketplaceExplicit -or $destinationRootExplicit) {
    throw "Personal marketplace does not contain $pluginName. Remove the explicit marketplace/destination options to let the installer create its dedicated local marketplace."
  }
  $Marketplace = "codex-design-bridge-local"
  $pluginSelector = "$pluginName@$Marketplace"
  $localMarketplaceRoot = if ($dedicatedMarketplaceRootOverride) {
    [IO.Path]::GetFullPath($dedicatedMarketplaceRootOverride)
  } else {
    Join-Path $localAppDataDirectory "Codex Design Bridge"
  }
  $DestinationRoot = [IO.Path]::GetFullPath((Join-Path $localMarketplaceRoot "plugins"))
  if (-not $reportPathExplicit) {
    $ReportPath = [IO.Path]::GetFullPath((Join-Path $DestinationRoot ".codex-design-bridge-install-report.json"))
  }
  $bootstrapMarketplace = $true
  $configuredMarketplaceRoot = Get-MarketplaceRoot
  if ($configuredMarketplaceRoot) {
    $configuredMarketplaceRoot = [IO.Path]::GetFullPath($configuredMarketplaceRoot).TrimEnd("\")
    $expectedMarketplaceRoot = [IO.Path]::GetFullPath($localMarketplaceRoot).TrimEnd("\")
    if ($configuredMarketplaceRoot -ne $expectedMarketplaceRoot) {
      throw "Marketplace $Marketplace is already configured from a different location: $configuredMarketplaceRoot"
    }
  } else {
    $needsMarketplaceAdd = $true
  }
}

New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
$targetPath = Join-Path $DestinationRoot $pluginName
$stagingLeaf = ".$pluginName.install-$PID"
$stagingPath = Join-Path $DestinationRoot $stagingLeaf
$backupPath = ""
$targetMoved = $false
$newTargetPlaced = $false

Assert-SafeManagedPath -PathToCheck $targetPath -ExpectedParent $DestinationRoot -AllowedLeafNames @($pluginName)
Assert-SafeManagedPath -PathToCheck $stagingPath -ExpectedParent $DestinationRoot -AllowedLeafNames @($stagingLeaf)

try {
  if (Test-Path -LiteralPath $stagingPath) {
    Remove-Item -LiteralPath $stagingPath -Recurse -Force
  }
  Copy-Item -LiteralPath $source -Destination $stagingPath -Recurse
  $stagingManifest = Read-PluginManifest -PluginPath $stagingPath
  if ($stagingManifest.version -ne $manifest.version) {
    throw "Staged version does not match the release package."
  }
  Assert-HashesMatch -Expected $sourceHashes -Actual (Get-CoreHashes -PluginPath $stagingPath) -Label "Staging"
  Set-McpRuntime -PluginPath $stagingPath
  $sourceHashes = Get-CoreHashes -PluginPath $stagingPath

  $installedBefore = Get-InstalledPlugin
  if ($installedBefore) {
    Invoke-CodexJson -Arguments @("plugin", "remove", $pluginSelector, "--json") | Out-Null
  }

  if (Test-Path -LiteralPath $targetPath) {
    $backupLeaf = "$pluginName.backup-$(Get-Date -Format 'yyyyMMddHHmmss')"
    $backupPath = Join-Path $DestinationRoot $backupLeaf
    Assert-SafeManagedPath -PathToCheck $backupPath -ExpectedParent $DestinationRoot -AllowedLeafNames @($backupLeaf)
    Move-Item -LiteralPath $targetPath -Destination $backupPath
    $targetMoved = $true
  }

  Move-Item -LiteralPath $stagingPath -Destination $targetPath
  $newTargetPlaced = $true
  Assert-HashesMatch -Expected $sourceHashes -Actual (Get-CoreHashes -PluginPath $targetPath) -Label "Personal plugin source"

  if ($bootstrapMarketplace) {
    Write-LocalMarketplace -MarketplacePath (Join-Path $localMarketplaceRoot ".agents\plugins\marketplace.json")
    if ($needsMarketplaceAdd) {
      Invoke-CodexJson -Arguments @("plugin", "marketplace", "add", $localMarketplaceRoot, "--json") | Out-Null
      $marketplaceAdded = $true
    }
  }

  Invoke-CodexJson -Arguments @("plugin", "add", $pluginSelector, "--json") | Out-Null
  $installedAfter = Get-InstalledPlugin
  if (-not $installedAfter) {
    throw "Codex did not report the plugin as installed."
  }
  if ($installedAfter.version -ne $manifest.version) {
    throw "Codex reported version $($installedAfter.version); expected $($manifest.version)."
  }

  $cachePath = Join-Path $profileDirectory ".codex\plugins\cache\$Marketplace\$pluginName\$($manifest.version)"
  if (-not (Test-Path -LiteralPath $cachePath -PathType Container)) {
    throw "New runtime cache was not found: $cachePath"
  }
  $cacheManifest = Read-PluginManifest -PluginPath $cachePath
  if ($cacheManifest.version -ne $manifest.version) {
    throw "Runtime cache version does not match the release package."
  }
  Assert-HashesMatch -Expected $sourceHashes -Actual (Get-CoreHashes -PluginPath $cachePath) -Label "Codex runtime cache"

  Write-InstallReport -Report @{
    plugin = $pluginName
    version = $manifest.version
    installedAt = (Get-Date).ToString("o")
    checkOnly = $false
    status = "installed"
    sourcePath = $source
    targetPath = $targetPath
    installedPath = $cachePath
    marketplace = $Marketplace
    hashesVerified = $true
    pluginListConfirmed = $true
    backupPath = $backupPath
    previousVersion = if ($installedBefore) { $installedBefore.version } else { "" }
    mcpNodePath = $mcpNodePath
    hashes = $sourceHashes
  }

  Write-Host ""
  Write-Host "Installed Codex Design Bridge $($manifest.version)" -ForegroundColor Green
  Write-Host "Runtime cache: $cachePath"
  Write-Host "Install report: $ReportPath"
  Write-Host "Reopen Codex and start a new task."
} catch {
  $failure = $_
  Write-Warning "Installation did not complete. Restoring the previous version."
  try {
    if ($newTargetPlaced -and (Test-Path -LiteralPath $targetPath)) {
      Remove-Item -LiteralPath $targetPath -Recurse -Force
    }
    if ($targetMoved -and $backupPath -and (Test-Path -LiteralPath $backupPath)) {
      Move-Item -LiteralPath $backupPath -Destination $targetPath
    }
    if (Test-Path -LiteralPath $stagingPath) {
      Remove-Item -LiteralPath $stagingPath -Recurse -Force
    }
    if ($installedBefore -and (Test-Path -LiteralPath $targetPath)) {
      Invoke-CodexJson -Arguments @("plugin", "add", $pluginSelector, "--json") | Out-Null
    }
    if ($marketplaceAdded) {
      Invoke-CodexJson -Arguments @("plugin", "marketplace", "remove", $Marketplace, "--json") | Out-Null
    }
  } catch {
    Write-Warning "Automatic recovery also failed: $($_.Exception.Message)"
  }
  throw $failure
}
