param(
  [string]$ConfigFile = '',
  [string]$CoreUrl = '',
  [string]$Role = '',
  [string]$DeviceName = '',
  [string]$ProjectRoots = '',
  [string]$CodexCommand = '',
  [string]$CodexHome = '',
  [string]$EnrollmentTokenFile = '',
  [string]$TokenFile = '',
  [string]$UpdatePublicKey = '',
  [Nullable[bool]]$AllowPowerActions,
  [Nullable[bool]]$PreventSleepDuringJobs,
  [Nullable[bool]]$RequireSignedUpdates,
  [switch]$RemoveEnrollmentToken,
  [switch]$RemoveToken,
  [switch]$ConsumeSecretFiles,
  [switch]$ConsumeInputFiles,
  [switch]$NoRestart
)
$ErrorActionPreference = 'Stop'
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this command as Administrator.' }
$SystemDirectoryAcl = '*S-1-5-18:(OI)(CI)F'
$AdministratorsDirectoryAcl = '*S-1-5-32-544:(OI)(CI)F'
$SystemFileAcl = '*S-1-5-18:F'
$AdministratorsFileAcl = '*S-1-5-32-544:F'
$CurrentAdministratorAcl = "*$($Identity.User.Value):(OI)(CI)F"
$CurrentAdministratorFileAcl = "*$($Identity.User.Value):F"

$StateDir = Join-Path $env:ProgramData 'Fleet Canvas\agent'
$ConfigPath = Join-Path $StateDir 'service-config.json'
if ($ConfigFile -and [IO.Path]::GetFullPath($ConfigFile) -eq [IO.Path]::GetFullPath($ConfigPath)) { throw 'ConfigFile must be a separate preseed file, not the installed service configuration.' }
$AllowedKeys = @(
  'FLEET_CORE_URL', 'FLEET_DEVICE_ROLE', 'FLEET_DEVICE_NAME', 'FLEET_AGENT_DATA_DIR',
  'FLEET_CREDENTIAL_FILE', 'FLEET_PROJECT_ROOTS', 'FLEET_ENROLLMENT_TOKEN', 'FLEET_TOKEN',
  'FLEET_ALLOW_POWER_ACTIONS', 'FLEET_PREVENT_SLEEP_DURING_JOBS', 'FLEET_UPDATE_PUBLIC_KEY',
  'FLEET_REQUIRE_SIGNED_UPDATES', 'FLEET_CODEX_COMMAND', 'CODEX_HOME'
)

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
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Configuration input does not exist: $Path" }
  $Information = Get-Item -LiteralPath $Path -Force
  if (($Information.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Configuration input must not be a symbolic link or reparse point: $Path" }
  $Acl = Get-Acl -LiteralPath $Path
  $AllowedSids = @('S-1-5-18', 'S-1-5-32-544', $Identity.User.Value)
  $OwnerSid = $Acl.Owner
  try { $OwnerSid = ([Security.Principal.NTAccount]$Acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value } catch {}
  if ($AllowedSids -notcontains $OwnerSid) { throw "Configuration input must be owned by SYSTEM, Administrators, or the invoking administrator: $Path" }
  $WriteMask = [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  $Unsafe = $Acl.Access | Where-Object {
    $Sid = $_.IdentityReference.Value
    try { $Sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch {}
    $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $WriteMask) -ne 0 -and $AllowedSids -notcontains $Sid
  }
  if ($Unsafe) { throw "Configuration input is writable by a non-administrative identity: $Path" }
}

function Read-OneLineSecret([string]$Path) {
  Assert-SafeInputFile $Path
  $Value = (Get-Content -LiteralPath $Path -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains("`r") -or $Value.Contains("`n") -or $Value.Contains([char]0)) {
    throw "Secret file must contain exactly one non-empty line: $Path"
  }
  return $Value
}

$Config = [ordered]@{}
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
  Assert-SafeInputFile $ConfigPath
  $Existing = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  foreach ($Property in $Existing.PSObject.Properties) {
    if ($AllowedKeys -contains $Property.Name -and $Property.Value -is [string]) { $Config[$Property.Name] = $Property.Value }
  }
}
if ($ConfigFile) {
  Assert-SafeInputFile $ConfigFile
  $Incoming = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
  foreach ($Property in $Incoming.PSObject.Properties) {
    if ($AllowedKeys -notcontains $Property.Name) { throw "Unsupported service configuration key: $($Property.Name)" }
    if ($Property.Value -isnot [string]) { throw "Service configuration values must be strings: $($Property.Name)" }
    $Config[$Property.Name] = $Property.Value
  }
}

if ($CoreUrl) {
  $ParsedUrl = $null
  if (-not [Uri]::TryCreate($CoreUrl, [UriKind]::Absolute, [ref]$ParsedUrl) -or $ParsedUrl.Scheme -notin @('http', 'https', 'ws', 'wss') -or $ParsedUrl.UserInfo) { throw 'CoreUrl must be an http(s) or ws(s) URL without embedded credentials.' }
  $Config.FLEET_CORE_URL = $CoreUrl
}
if ($Role) {
  if ($Role -notin @('core', 'gpu', 'worker', 'gateway', 'storage', 'workstation', 'phone', 'unknown')) { throw 'Invalid device role.' }
  $Config.FLEET_DEVICE_ROLE = $Role
}
if ($DeviceName) { $Config.FLEET_DEVICE_NAME = $DeviceName }
if ($ProjectRoots) { $Config.FLEET_PROJECT_ROOTS = $ProjectRoots }
if ($CodexCommand) { $Config.FLEET_CODEX_COMMAND = Assert-RegularCodexCommand $CodexCommand }
if ($CodexHome) { $Config.CODEX_HOME = Resolve-AbsoluteWindowsPath $CodexHome 'CodexHome' }
if ($UpdatePublicKey) { $Config.FLEET_UPDATE_PUBLIC_KEY = $UpdatePublicKey }
if ($EnrollmentTokenFile) { $Config.FLEET_ENROLLMENT_TOKEN = Read-OneLineSecret $EnrollmentTokenFile }
if ($TokenFile) { $Config.FLEET_TOKEN = Read-OneLineSecret $TokenFile }
if ($RemoveEnrollmentToken) { $Config.Remove('FLEET_ENROLLMENT_TOKEN') }
if ($RemoveToken) { $Config.Remove('FLEET_TOKEN') }
if ($null -ne $AllowPowerActions) { $Config.FLEET_ALLOW_POWER_ACTIONS = $AllowPowerActions.Value.ToString().ToLowerInvariant() }
if ($null -ne $PreventSleepDuringJobs) { $Config.FLEET_PREVENT_SLEEP_DURING_JOBS = $PreventSleepDuringJobs.Value.ToString().ToLowerInvariant() }
if ($null -ne $RequireSignedUpdates) { $Config.FLEET_REQUIRE_SIGNED_UPDATES = $RequireSignedUpdates.Value.ToString().ToLowerInvariant() }

if (-not $Config.Contains('FLEET_CORE_URL')) { $Config.FLEET_CORE_URL = 'http://127.0.0.1:4780' }
if (-not $Config.Contains('FLEET_DEVICE_ROLE')) { $Config.FLEET_DEVICE_ROLE = 'workstation' }
if (-not $Config.Contains('FLEET_AGENT_DATA_DIR')) { $Config.FLEET_AGENT_DATA_DIR = Join-Path $StateDir 'state' }
if (-not $Config.Contains('FLEET_REQUIRE_SIGNED_UPDATES')) { $Config.FLEET_REQUIRE_SIGNED_UPDATES = 'true' }

foreach ($Entry in $Config.GetEnumerator()) {
  if ($Entry.Value.Contains("`r") -or $Entry.Value.Contains("`n") -or $Entry.Value.Contains([char]0)) { throw "Configuration values must be single-line: $($Entry.Key)" }
}
if ($Config.Contains('FLEET_DEVICE_ROLE') -and $Config.FLEET_DEVICE_ROLE -notin @('core', 'gpu', 'worker', 'gateway', 'storage', 'workstation', 'phone', 'unknown')) { throw 'Invalid configured device role.' }
if ($Config.Contains('FLEET_CORE_URL')) {
  $ParsedUrl = $null
  if (-not [Uri]::TryCreate($Config.FLEET_CORE_URL, [UriKind]::Absolute, [ref]$ParsedUrl) -or $ParsedUrl.Scheme -notin @('http', 'https', 'ws', 'wss') -or $ParsedUrl.UserInfo) { throw 'Configured Core URL is invalid.' }
}
if ($Config.Contains('FLEET_CODEX_COMMAND') -and $Config.FLEET_CODEX_COMMAND) { $Config.FLEET_CODEX_COMMAND = Assert-RegularCodexCommand $Config.FLEET_CODEX_COMMAND }
if ($Config.Contains('CODEX_HOME') -and $Config.CODEX_HOME) { $Config.CODEX_HOME = Initialize-SecureCodexHome $Config.CODEX_HOME }

New-Item -ItemType Directory -Force $StateDir | Out-Null
$StateDirectoryInformation = Get-Item -LiteralPath $StateDir -Force
if (($StateDirectoryInformation.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Fleet Agent state directory must not be a symbolic link or reparse point.' }
& icacls.exe $StateDir /inheritance:r /grant:r $SystemDirectoryAcl $AdministratorsDirectoryAcl $CurrentAdministratorAcl /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to secure the Fleet Agent state directory.' }
$Temporary = Join-Path $StateDir ("service-config.{0}.tmp" -f [Guid]::NewGuid().ToString('N'))
try {
  $Config | ConvertTo-Json | Set-Content -LiteralPath $Temporary -Encoding UTF8
  & icacls.exe $Temporary /inheritance:r /grant:r $SystemFileAcl $AdministratorsFileAcl $CurrentAdministratorFileAcl /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to secure the Fleet Agent service configuration.' }
  & icacls.exe $Temporary /setowner '*S-1-5-32-544' /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to assign the Fleet Agent service configuration owner.' }
  Move-Item -LiteralPath $Temporary -Destination $ConfigPath -Force
} finally {
  Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
}

if ($ConsumeSecretFiles -or $ConsumeInputFiles) {
  foreach ($Path in @($EnrollmentTokenFile, $TokenFile) | Where-Object { $_ } | Select-Object -Unique) { Remove-Item -LiteralPath $Path -Force }
}
if ($ConsumeInputFiles -and $ConfigFile) { Remove-Item -LiteralPath $ConfigFile -Force }
if (-not $NoRestart -and (Get-Service -Name FleetCanvasAgent -ErrorAction SilentlyContinue)) {
  Restart-Service -Name FleetCanvasAgent
}
Write-Host "Fleet Agent configuration written to $ConfigPath"
