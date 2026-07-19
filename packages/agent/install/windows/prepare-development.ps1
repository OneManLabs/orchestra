param(
  [string]$BootstrapRoot = 'C:\FleetBootstrap',
  [string]$NodeVersion = '22.17.1',
  [string]$NodeArchiveSha256 = 'b1fdb5635ba860f6bf71474f2ca882459a582de49b1d869451e3ad188e3943eb'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this preparation command as Administrator.' }
$SystemDirectoryAcl = '*S-1-5-18:(OI)(CI)F'
$AdministratorsDirectoryAcl = '*S-1-5-32-544:(OI)(CI)F'
$CurrentAdministratorDirectoryAcl = "*$($Identity.User.Value):(OI)(CI)F"
if ($NodeVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'NodeVersion must contain exactly three numeric components.' }
if ($NodeArchiveSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'NodeArchiveSha256 must be a 64-character SHA-256 digest.' }

$BootstrapRoot = [IO.Path]::GetFullPath($BootstrapRoot)
if ($BootstrapRoot -eq [IO.Path]::GetPathRoot($BootstrapRoot)) { throw 'BootstrapRoot must be a dedicated non-root directory.' }
New-Item -ItemType Directory -Force -Path $BootstrapRoot | Out-Null
$BootstrapInformation = Get-Item -LiteralPath $BootstrapRoot -Force
if (($BootstrapInformation.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'BootstrapRoot must not be a symbolic link or reparse point.' }
& icacls.exe $BootstrapRoot /inheritance:r /grant:r $SystemDirectoryAcl $AdministratorsDirectoryAcl $CurrentAdministratorDirectoryAcl /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to secure BootstrapRoot.' }

function Receive-FileAtomic([string]$Uri, [string]$Destination) {
  if (Test-Path -LiteralPath $Destination) {
    $ExistingDestination = Get-Item -LiteralPath $Destination -Force
    if ($ExistingDestination.PSIsContainer -or ($ExistingDestination.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Download destination must be a regular non-reparse file: $Destination"
    }
  }
  $Temporary = "$Destination.$([Guid]::NewGuid().ToString('N')).download"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Temporary
    Move-Item -LiteralPath $Temporary -Destination $Destination -Force
  } finally {
    Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
  }
}

function Assert-RegularNonReparseFile([string]$Path, [string]$Description) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Description was not found: $Path" }
  $Information = Get-Item -LiteralPath $Path -Force
  if ($Information.PSIsContainer -or ($Information.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Description must be a regular non-reparse file: $Path"
  }
}

$NodeArchiveName = "node-v$NodeVersion-win-x64.zip"
$NodeDirectoryName = "node-v$NodeVersion-win-x64"
$NodeArchive = Join-Path $BootstrapRoot $NodeArchiveName
$NodeChecksums = Join-Path $BootstrapRoot 'SHASUMS256.txt'
$NodeDirectory = Join-Path $BootstrapRoot $NodeDirectoryName

if (-not (Test-Path -LiteralPath $NodeArchive)) {
  Receive-FileAtomic "https://nodejs.org/dist/v$NodeVersion/$NodeArchiveName" $NodeArchive
}
Assert-RegularNonReparseFile $NodeArchive 'Node.js archive'
Receive-FileAtomic "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" $NodeChecksums
Assert-RegularNonReparseFile $NodeChecksums 'Node.js checksum manifest'

$ChecksumPattern = "^(?<Hash>[0-9a-fA-F]{64})\s+\*?$([regex]::Escape($NodeArchiveName))$"
$ChecksumLine = Get-Content -LiteralPath $NodeChecksums |
  Where-Object { $_ -match $ChecksumPattern } |
  Select-Object -First 1
if (-not $ChecksumLine) { throw 'Node.js checksum entry was not found.' }

$ExpectedNodeHash = ([regex]::Match($ChecksumLine, $ChecksumPattern).Groups['Hash'].Value).ToLowerInvariant()
$PinnedNodeHash = $NodeArchiveSha256.ToLowerInvariant()
if ($ExpectedNodeHash -ne $PinnedNodeHash) { throw 'Published Node.js checksum does not match the pinned bootstrap checksum.' }
$ActualNodeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $NodeArchive).Hash.ToLowerInvariant()
if ($ActualNodeHash -ne $PinnedNodeHash) { throw 'Node.js archive checksum verification failed.' }

$ExtractionRoot = Join-Path $BootstrapRoot ("node-extract-{0}" -f [Guid]::NewGuid().ToString('N'))
try {
  Expand-Archive -LiteralPath $NodeArchive -DestinationPath $ExtractionRoot
  $ExtractedDirectory = Join-Path $ExtractionRoot $NodeDirectoryName
  if (-not (Test-Path -LiteralPath (Join-Path $ExtractedDirectory 'node.exe') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $ExtractedDirectory 'LICENSE') -PathType Leaf)) {
    throw 'The portable Node.js archive is incomplete.'
  }
  if (Test-Path -LiteralPath $NodeDirectory) {
    $ExistingNodeDirectory = Get-Item -LiteralPath $NodeDirectory -Force
    if (($ExistingNodeDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Node.js extraction destination must not be a symbolic link or reparse point.' }
    Remove-Item -LiteralPath $NodeDirectory -Recurse -Force
  }
  Move-Item -LiteralPath $ExtractedDirectory -Destination $NodeDirectory
} finally {
  Remove-Item -LiteralPath $ExtractionRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$NodeExecutable = Join-Path $NodeDirectory 'node.exe'
$NodeLicense = Join-Path $NodeDirectory 'LICENSE'
if (-not (Test-Path -LiteralPath $NodeExecutable) -or -not (Test-Path -LiteralPath $NodeLicense)) {
  throw 'The portable Node.js archive is incomplete.'
}

$env:Path = "$NodeDirectory;$env:Path"
$BundleBuilder = Join-Path $BootstrapRoot 'packages\agent\install\build-bundle.mjs'
$Bundle = Join-Path $BootstrapRoot 'bundle'
Assert-RegularNonReparseFile $BundleBuilder 'Fleet Agent bundle builder'
& $NodeExecutable $BundleBuilder --out $Bundle
if ($LASTEXITCODE -ne 0) { throw 'Fleet Agent runtime bundle creation failed.' }

$WinSw = Join-Path $BootstrapRoot 'WinSW-x64.exe'
if (-not (Test-Path -LiteralPath $WinSw)) {
  Receive-FileAtomic 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' $WinSw
}
Assert-RegularNonReparseFile $WinSw 'WinSW executable'
$ExpectedWinSwHash = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'
$ActualWinSwHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $WinSw).Hash.ToLowerInvariant()
if ($ActualWinSwHash -ne $ExpectedWinSwHash) { throw 'WinSW checksum verification failed.' }

[pscustomobject]@{
  Bundle = $Bundle
  NodeExecutable = $NodeExecutable
  NodeLicense = $NodeLicense
  WinSw = $WinSw
}
