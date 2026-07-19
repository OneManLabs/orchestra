param(
  [Parameter(Mandatory = $true)][string]$Bundle,
  [Parameter(Mandatory = $true)][string]$WinSw,
  [string]$WinSwSha256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da',
  [string]$NodeExe = '',
  [string]$NodeLicense = '',
  [string]$ConfigFile = '',
  [string]$CoreUrl = 'http://127.0.0.1:4780',
  [string]$EnrollmentToken = '',
  [string]$EnrollmentTokenFile = '',
  [string]$Token = '',
  [string]$TokenFile = '',
  [string]$ProjectRoots = '',
  [string]$CodexCommand = '',
  [string]$CodexHome = '',
  [string]$Role = 'workstation',
  [string]$InstallDir = "$env:ProgramFiles\Fleet Canvas\Agent",
  [switch]$AllowPowerActions,
  [switch]$PreventSleepDuringJobs,
  [string]$UpdatePublicKey = '',
  [switch]$AllowUnsignedDevelopmentUpdates,
  [switch]$Silent,
  [switch]$Headless
)
$ErrorActionPreference = 'Stop'
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this installer as Administrator.' }
$SystemDirectoryAcl = '*S-1-5-18:(OI)(CI)F'
$AdministratorsDirectoryAcl = '*S-1-5-32-544:(OI)(CI)F'
$SystemFileAcl = '*S-1-5-18:F'
$AdministratorsFileAcl = '*S-1-5-32-544:F'
$CurrentAdministratorAcl = "*$($Identity.User.Value):(OI)(CI)F"
$CurrentAdministratorFileAcl = "*$($Identity.User.Value):F"
if (-not (Test-Path (Join-Path $Bundle 'dist\cli.js'))) { throw 'Bundle must be created by build-bundle.mjs.' }
$PtyOmittedMarker = Join-Path $Bundle '.fleet-agent-omit-pty'
$PtyIntentionallyOmitted = (Test-Path $PtyOmittedMarker -PathType Leaf) -and ((Get-Content -LiteralPath $PtyOmittedMarker -Raw).Trim() -eq 'fleet-agent-omit-pty-v1')
if (-not (Test-Path (Join-Path $Bundle 'node_modules\node-pty\package.json')) -and -not $PtyIntentionallyOmitted) { throw 'Bundle is missing node-pty without the appliance-mode marker.' }
if (-not (Test-Path (Join-Path $Bundle 'node_modules\ws\package.json'))) { throw 'Bundle is missing the WebSocket runtime.' }
if (-not (Test-Path $WinSw)) { throw 'WinSW executable was not found. Supply -WinSw with an official WinSW binary.' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $WinSw).Hash.ToLowerInvariant() -ne $WinSwSha256.ToLowerInvariant()) { throw 'WinSW SHA-256 verification failed.' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
if ($InstallDir -eq [IO.Path]::GetPathRoot($InstallDir) -or $InstallDir -eq [IO.Path]::GetFullPath($env:ProgramFiles)) { throw 'Unsafe InstallDir.' }
if (-not $NodeExe) { $NodeExe = (Get-Command node.exe -ErrorAction Stop).Source }
if (-not (Test-Path $NodeExe -PathType Leaf)) { throw 'Node executable was not found.' }
$NodeLicense = if ($NodeLicense) { $NodeLicense } else { Join-Path (Split-Path -Parent $NodeExe) 'LICENSE' }
if (-not (Test-Path $NodeLicense -PathType Leaf)) { throw 'Node.js license file was not found. Supply -NodeLicense.' }
$NodeMajor = [int](& $NodeExe -p "Number(process.versions.node.split('.')[0])")
if ($NodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }

function Resolve-AbsoluteWindowsPath([string]$Path, [string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Contains("`r") -or $Path.Contains("`n") -or $Path.Contains([char]0)) {
    throw "$Name must be a non-empty, single-line absolute Windows path."
  }
  $DriveQualified = $Path -match '^[A-Za-z]:[\\/]'
  $UncQualified = $Path -match '^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)'
  if ((-not $DriveQualified -and -not $UncQualified) -or $Path.StartsWith('\\?\') -or $Path.StartsWith('\\.\')) {
    throw "$Name must be a fully qualified drive or UNC path."
  }
  try { return [IO.Path]::GetFullPath($Path) } catch { throw "$Name is not a valid absolute Windows path." }
}

function Assert-RegularCodexCommand([string]$Path) {
  $FullPath = Resolve-AbsoluteWindowsPath $Path 'CodexCommand'
  if (-not (Test-Path -LiteralPath $FullPath -PathType Leaf)) { throw "CodexCommand does not exist or is not a file: $FullPath" }
  $Information = Get-Item -LiteralPath $FullPath -Force
  if (($Information.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "CodexCommand must not be a symbolic link or reparse point: $FullPath" }
  return $FullPath
}

function Get-CodexHomeDescendantsNoFollow([string]$Path) {
  $Descendants = [Collections.Generic.List[object]]::new()
  $PendingDirectories = [Collections.Generic.Stack[string]]::new()
  $PendingDirectories.Push($Path)
  while ($PendingDirectories.Count -gt 0) {
    $Directory = $PendingDirectories.Pop()
    foreach ($Child in @(Get-ChildItem -LiteralPath $Directory -Force -ErrorAction Stop)) {
      [void]$Descendants.Add($Child)
      if ($Child.PSIsContainer -and ($Child.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        $PendingDirectories.Push($Child.FullName)
      }
    }
  }
  return $Descendants.ToArray()
}

function Initialize-SecureCodexHome([string]$Path) {
  $FullPath = Resolve-AbsoluteWindowsPath $Path 'CodexHome'
  if ($FullPath.TrimEnd([char[]]'\/') -eq [IO.Path]::GetPathRoot($FullPath).TrimEnd([char[]]'\/')) { throw 'CodexHome must not be a filesystem root.' }
  $Probe = $FullPath
  while ($Probe) {
    if (Test-Path -LiteralPath $Probe) {
      $Information = Get-Item -LiteralPath $Probe -Force
      if (($Information.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "CodexHome must not traverse a symbolic link or reparse point: $Probe" }
    }
    $Parent = Split-Path -Parent $Probe
    if (-not $Parent -or $Parent -eq $Probe) { break }
    $Probe = $Parent
  }
  if (Test-Path -LiteralPath $FullPath -PathType Leaf) { throw "CodexHome is not a directory: $FullPath" }
  New-Item -ItemType Directory -Force $FullPath | Out-Null
  $Information = Get-Item -LiteralPath $FullPath -Force
  if (($Information.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "CodexHome must not be a symbolic link or reparse point: $FullPath" }

  # Codex standalone maintains packages\standalone\current as a reparse point.
  # Walk one directory level at a time and never enqueue reparse directories, so
  # that compatibility link is preserved without following it outside this tree.
  $Descendants = @(Get-CodexHomeDescendantsNoFollow $FullPath)

  $AllowedSidValues = @('S-1-5-18', 'S-1-5-32-544', $Identity.User.Value) | Select-Object -Unique
  $RegularDescendants = @($Descendants | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 })
  $Directories = @($RegularDescendants | Where-Object { $_.PSIsContainer } | Sort-Object { $_.FullName.Length })
  $Files = @($RegularDescendants | Where-Object { -not $_.PSIsContainer })
  foreach ($Item in @($Information) + $Directories + $Files) {
    $CurrentItem = Get-Item -LiteralPath $Item.FullName -Force
    if (($CurrentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    $Acl = Get-Acl -LiteralPath $Item.FullName
    $Acl.SetAccessRuleProtection($true, $false)
    foreach ($Rule in @($Acl.Access)) { [void]$Acl.RemoveAccessRuleSpecific($Rule) }
    $InheritanceFlags = if ($CurrentItem.PSIsContainer) {
      [Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [Security.AccessControl.InheritanceFlags]::ContainerInherit
    } else {
      [Security.AccessControl.InheritanceFlags]::None
    }
    foreach ($SidValue in $AllowedSidValues) {
      $Sid = [Security.Principal.SecurityIdentifier]::new($SidValue)
      $Rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $Sid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $InheritanceFlags,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
      )
      [void]$Acl.AddAccessRule($Rule)
    }
    # Files receive FullControl, not a data-only mask. A standalone codex.exe can
    # be hard-linked between CodexHome and Program Files, and therefore shares
    # this DACL; FullControl preserves executable access for all three identities.
    Set-Acl -LiteralPath $Item.FullName -AclObject $Acl
  }
  & icacls.exe $FullPath /setowner '*S-1-5-18' /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to assign CodexHome to the Fleet Agent service identity.' }
  return $FullPath
}

function Assert-SafeInputFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Secret file does not exist: $Path" }
  $Information = Get-Item -LiteralPath $Path -Force
  if (($Information.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Input must not be a symbolic link or reparse point: $Path" }
  $Acl = Get-Acl -LiteralPath $Path
  $AllowedSids = @('S-1-5-18', 'S-1-5-32-544', $Identity.User.Value)
  $OwnerSid = $Acl.Owner
  try { $OwnerSid = ([Security.Principal.NTAccount]$Acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value } catch {}
  if ($AllowedSids -notcontains $OwnerSid) { throw "Input must be owned by SYSTEM, Administrators, or the invoking administrator: $Path" }
  $WriteMask = [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  $Unsafe = $Acl.Access | Where-Object {
    $Sid = $_.IdentityReference.Value
    try { $Sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch {}
    $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $WriteMask) -ne 0 -and $AllowedSids -notcontains $Sid
  }
  if ($Unsafe) { throw "Input is writable by a non-administrative identity: $Path" }
}
function Read-SafeSecret([string]$Path) {
  Assert-SafeInputFile $Path
  $Value = (Get-Content -LiteralPath $Path -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains("`r") -or $Value.Contains("`n") -or $Value.Contains([char]0)) { throw "Secret file must contain exactly one non-empty line: $Path" }
  return $Value
}
if ($EnrollmentTokenFile) { $EnrollmentToken = Read-SafeSecret $EnrollmentTokenFile }
if ($TokenFile) { $Token = Read-SafeSecret $TokenFile }
if ($CodexCommand) { $CodexCommand = Assert-RegularCodexCommand $CodexCommand }
if ($CodexHome) { $CodexHome = Resolve-AbsoluteWindowsPath $CodexHome 'CodexHome' }
if ($Role -notin @('core', 'gpu', 'worker', 'gateway', 'storage', 'workstation', 'phone', 'unknown')) { throw 'Invalid device role.' }
$ParsedCoreUrl = $null
if (-not [Uri]::TryCreate($CoreUrl, [UriKind]::Absolute, [ref]$ParsedCoreUrl) -or $ParsedCoreUrl.Scheme -notin @('http', 'https', 'ws', 'wss') -or $ParsedCoreUrl.UserInfo) { throw 'CoreUrl must be an http(s) or ws(s) URL without embedded credentials.' }
foreach ($Value in @($CoreUrl, $EnrollmentToken, $Token, $ProjectRoots, $CodexCommand, $CodexHome, $Role, $UpdatePublicKey)) {
  if ($Value.Contains("`r") -or $Value.Contains("`n") -or $Value.Contains([char]0)) { throw 'Installer configuration values must be single-line.' }
}
if ($ConfigFile) {
  Assert-SafeInputFile $ConfigFile
  $Preflight = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
  $AllowedPreflight = @('FLEET_CORE_URL','FLEET_DEVICE_ROLE','FLEET_DEVICE_NAME','FLEET_AGENT_DATA_DIR','FLEET_CREDENTIAL_FILE','FLEET_PROJECT_ROOTS','FLEET_ENROLLMENT_TOKEN','FLEET_TOKEN','FLEET_ALLOW_POWER_ACTIONS','FLEET_PREVENT_SLEEP_DURING_JOBS','FLEET_UPDATE_PUBLIC_KEY','FLEET_REQUIRE_SIGNED_UPDATES','FLEET_CODEX_COMMAND','CODEX_HOME')
  foreach ($Property in $Preflight.PSObject.Properties) {
    if ($AllowedPreflight -notcontains $Property.Name -or $Property.Value -isnot [string] -or $Property.Value.Contains("`r") -or $Property.Value.Contains("`n") -or $Property.Value.Contains([char]0)) { throw "Invalid configuration entry: $($Property.Name)" }
  }
  if ($null -ne $Preflight.FLEET_DEVICE_ROLE -and $Preflight.FLEET_DEVICE_ROLE -notin @('core', 'gpu', 'worker', 'gateway', 'storage', 'workstation', 'phone', 'unknown')) { throw 'Invalid configured device role.' }
  if ($null -ne $Preflight.FLEET_CORE_URL) {
    $PreflightUrl = $null
    if (-not [Uri]::TryCreate($Preflight.FLEET_CORE_URL, [UriKind]::Absolute, [ref]$PreflightUrl) -or $PreflightUrl.Scheme -notin @('http', 'https', 'ws', 'wss') -or $PreflightUrl.UserInfo) { throw 'Configured Core URL is invalid.' }
  }
  if ($null -ne $Preflight.FLEET_CODEX_COMMAND -and $Preflight.FLEET_CODEX_COMMAND) { [void](Assert-RegularCodexCommand $Preflight.FLEET_CODEX_COMMAND) }
  if ($null -ne $Preflight.CODEX_HOME -and $Preflight.CODEX_HOME) { [void](Resolve-AbsoluteWindowsPath $Preflight.CODEX_HOME 'CODEX_HOME') }
}

$ServiceExe = Join-Path $InstallDir 'FleetCanvasAgentService.exe'
if (Test-Path $InstallDir) {
  $ExistingInstallDirectory = Get-Item -LiteralPath $InstallDir -Force
  if (($ExistingInstallDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'InstallDir must not be a symbolic link or reparse point.' }
  if (Test-Path -LiteralPath $ServiceExe -PathType Leaf) {
    $ExistingServiceExecutable = Get-Item -LiteralPath $ServiceExe -Force
    if (($ExistingServiceExecutable.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Existing service executable must not be a symbolic link or reparse point.' }
    & $ServiceExe stop 2>$null
    & $ServiceExe uninstall 2>$null
  }
  Remove-Item -Recurse -Force $InstallDir
}
New-Item -ItemType Directory -Force $InstallDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $Bundle '*') $InstallDir
Copy-Item -Force $WinSw $ServiceExe
Copy-Item -Force $NodeExe (Join-Path $InstallDir 'node.exe')
Copy-Item -Force $NodeLicense (Join-Path $InstallDir 'NODE-LICENSE.txt')
$AssetDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item -Force (Join-Path $AssetDir 'FleetCanvasAgentService.xml') (Join-Path $InstallDir 'FleetCanvasAgentService.xml')
Copy-Item -Force (Join-Path $AssetDir 'service-host.mjs') (Join-Path $InstallDir 'service-host.mjs')
Copy-Item -Force (Join-Path $AssetDir 'configure.ps1') (Join-Path $InstallDir 'configure.ps1')
Copy-Item -Force (Join-Path $AssetDir 'uninstall.ps1') (Join-Path $InstallDir 'uninstall.ps1')
Copy-Item -Force (Join-Path $AssetDir 'WINSW-LICENSE.txt') (Join-Path $InstallDir 'WINSW-LICENSE.txt')
Unblock-File -LiteralPath $ServiceExe
& icacls.exe $InstallDir /inheritance:r /grant:r $SystemDirectoryAcl $AdministratorsDirectoryAcl $CurrentAdministratorAcl /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to secure the Fleet Agent installation directory.' }

$StateDir = Join-Path $env:ProgramData 'Fleet Canvas\agent'
New-Item -ItemType Directory -Force $StateDir | Out-Null
$StateDirectoryInformation = Get-Item -LiteralPath $StateDir -Force
if (($StateDirectoryInformation.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Fleet Agent state directory must not be a symbolic link or reparse point.' }
& icacls.exe $StateDir /inheritance:r /grant:r $SystemDirectoryAcl $AdministratorsDirectoryAcl $CurrentAdministratorAcl /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to secure the Fleet Agent state directory.' }
$Config = [ordered]@{}
if ($ConfigFile) {
  Assert-SafeInputFile $ConfigFile
  $Incoming = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
  $Allowed = @('FLEET_CORE_URL','FLEET_DEVICE_ROLE','FLEET_DEVICE_NAME','FLEET_AGENT_DATA_DIR','FLEET_CREDENTIAL_FILE','FLEET_PROJECT_ROOTS','FLEET_ENROLLMENT_TOKEN','FLEET_TOKEN','FLEET_ALLOW_POWER_ACTIONS','FLEET_PREVENT_SLEEP_DURING_JOBS','FLEET_UPDATE_PUBLIC_KEY','FLEET_REQUIRE_SIGNED_UPDATES','FLEET_CODEX_COMMAND','CODEX_HOME')
  foreach ($Property in $Incoming.PSObject.Properties) {
    if ($Allowed -notcontains $Property.Name -or $Property.Value -isnot [string]) { throw "Invalid configuration entry: $($Property.Name)" }
    $Config[$Property.Name] = $Property.Value
  }
}
$Defaults = [ordered]@{
  FLEET_CORE_URL = $CoreUrl
  FLEET_DEVICE_ROLE = $Role
  FLEET_AGENT_DATA_DIR = Join-Path $StateDir 'state'
  FLEET_PROJECT_ROOTS = $ProjectRoots
  FLEET_ENROLLMENT_TOKEN = $EnrollmentToken
  FLEET_TOKEN = $Token
  FLEET_ALLOW_POWER_ACTIONS = if ($AllowPowerActions) { 'true' } else { 'false' }
  FLEET_PREVENT_SLEEP_DURING_JOBS = if ($PreventSleepDuringJobs) { 'true' } else { 'false' }
  FLEET_UPDATE_PUBLIC_KEY = $UpdatePublicKey
  FLEET_REQUIRE_SIGNED_UPDATES = if ($AllowUnsignedDevelopmentUpdates) { 'false' } else { 'true' }
}
foreach ($Entry in $Defaults.GetEnumerator()) { if (-not $Config.Contains($Entry.Key)) { $Config[$Entry.Key] = $Entry.Value } }
if ($CodexCommand -and -not $Config.Contains('FLEET_CODEX_COMMAND')) { $Config.FLEET_CODEX_COMMAND = $CodexCommand }
if ($CodexHome -and -not $Config.Contains('CODEX_HOME')) { $Config.CODEX_HOME = $CodexHome }
if ($Config.Contains('FLEET_CODEX_COMMAND') -and $Config.FLEET_CODEX_COMMAND) { $Config.FLEET_CODEX_COMMAND = Assert-RegularCodexCommand $Config.FLEET_CODEX_COMMAND }
if ($Config.Contains('CODEX_HOME') -and $Config.CODEX_HOME) { $Config.CODEX_HOME = Initialize-SecureCodexHome $Config.CODEX_HOME }
$ConfigPath = Join-Path $StateDir 'service-config.json'
if (Test-Path -LiteralPath $ConfigPath) {
  $ExistingConfig = Get-Item -LiteralPath $ConfigPath -Force
  if (($ExistingConfig.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Fleet Agent service configuration must not be a symbolic link or reparse point.' }
}
$TemporaryConfig = Join-Path $StateDir ("service-config.{0}.tmp" -f [Guid]::NewGuid().ToString('N'))
try {
  $Config | ConvertTo-Json | Set-Content -LiteralPath $TemporaryConfig -Encoding UTF8
  & icacls.exe $TemporaryConfig /inheritance:r /grant:r $SystemFileAcl $AdministratorsFileAcl $CurrentAdministratorFileAcl /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to secure the Fleet Agent service configuration.' }
  & icacls.exe $TemporaryConfig /setowner '*S-1-5-32-544' /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to assign the Fleet Agent service configuration owner.' }
  Move-Item -LiteralPath $TemporaryConfig -Destination $ConfigPath -Force
} finally {
  Remove-Item -LiteralPath $TemporaryConfig -Force -ErrorAction SilentlyContinue
}
& $ServiceExe install
& $ServiceExe start
if (-not ($Silent -or $Headless)) { Write-Host "Fleet Agent installed. After enrollment, run configure.ps1 -RemoveEnrollmentToken -RemoveToken to remove FLEET_ENROLLMENT_TOKEN and FLEET_TOKEN so the device-bound credential is used." }
