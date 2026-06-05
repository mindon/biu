#!/usr/bin/env pwsh
# biu installer for Windows
#
# Usage:
#   powershell -c "irm https://raw.githubusercontent.com/mindon/biu/main/install.ps1 | iex"
#   &([scriptblock]::Create((irm https://raw.githubusercontent.com/mindon/biu/main/install.ps1))) -Version v1.1.9
#
# Parameters:
#   -Version <String>          Release tag to install (default: "latest", e.g. "v1.1.9")
#   -NoPathUpdate              Skip updating user PATH
#   -NoRegisterInstallation    Skip writing the Add/Remove Programs entry
#   -DownloadWithoutCurl       Use Invoke-RestMethod instead of curl.exe
#
# Environment overrides:
#   BIU_INSTALL   Install root (default: %USERPROFILE%\.biu)
#   GITHUB        GitHub origin (default: https://github.com)
#
# biu is a single self-compiled binary, so this script just downloads
# the prebuilt biu-windows-<arch>.exe from GitHub Releases and places
# it at $env:BIU_INSTALL\bin\biu.exe.

param(
  [String]$Version = "latest",
  [Switch]$NoPathUpdate = $false,
  [Switch]$NoRegisterInstallation = $false,
  [Switch]$DownloadWithoutCurl = $false
)

# filter out potential noise from `irm | iex` pipelines
$ErrorActionPreference = "Stop"

# ---- Windows version check (>= Win10 1809 / Server 2019) ----
$MinBuild = 17763
$MinBuildName = "Windows 10 1809 / Server 2019"

$WinVer = [System.Environment]::OSVersion.Version
if ($WinVer.Major -lt 10 -or ($WinVer.Major -eq 10 -and $WinVer.Build -lt $MinBuild)) {
  Write-Warning "biu requires at least $MinBuildName or newer."
  Write-Warning "The install will still attempt to continue, but may fail."
}

$ErrorActionPreference = "Stop"

# ---- arch / target ----
$Arch = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $Arch = $env:PROCESSOR_ARCHITEW6432 }
switch ($Arch) {
  "AMD64" { $Target = "windows-x64" }
  "ARM64" { $Target = "windows-aarch64" }
  default {
    Write-Error "Unsupported architecture: $Arch (only AMD64 and ARM64 are supported)"
    exit 1
  }
}

# ---- paths ----
if (-not $env:BIU_INSTALL) {
  $env:BIU_INSTALL = "${Home}\.biu"
}
$BiuRoot = $env:BIU_INSTALL
$BiuBin = "${BiuRoot}\bin"
$BiuExe = "${BiuBin}\biu.exe"

if (-not (Test-Path $BiuBin)) {
  New-Item -ItemType Directory -Force -Path $BiuBin | Out-Null
}

# ---- resolve download URL ----
if (-not $env:GITHUB) { $env:GITHUB = "https://github.com" }
$GithubRepo = "$($env:GITHUB)/mindon/biu"
$Asset = "biu-${Target}.exe"

if ($Version -eq "latest" -or [string]::IsNullOrEmpty($Version)) {
  $Uri = "${GithubRepo}/releases/latest/download/${Asset}"
} else {
  $Uri = "${GithubRepo}/releases/download/${Version}/${Asset}"
}

Write-Output "Downloading biu from ${Uri}"

# ---- download ----
$null = New-Item -ItemType File -Force -Path $BiuExe
try {
  if (-not $DownloadWithoutCurl -and (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    & curl.exe "-#SfLo" "$BiuExe" "$Uri"
    if ($LASTEXITCODE -ne 0) { throw "curl.exe exit code $LASTEXITCODE" }
  } else {
    Invoke-RestMethod -Uri $Uri -OutFile $BiuExe -UseBasicParsing
  }
} catch {
  Write-Output "Download failed: $_"
  Write-Output ""
  Write-Output "If this download is failing, please open an issue:"
  Write-Output "  https://github.com/mindon/biu/issues/new"
  exit 1
}

if (-not (Test-Path $BiuExe) -or ((Get-Item $BiuExe).Length -lt 1024)) {
  Write-Error "Downloaded file at $BiuExe is missing or too small. Aborting."
  exit 1
}

# ---- smoke test ----
$BiuVersionOutput = ""
try {
  $BiuVersionOutput = & $BiuExe --version 2>&1
} catch {
  $LASTEXITCODE = -1
}

if ($LASTEXITCODE -ne 0) {
  Write-Warning "biu was downloaded but '--version' did not run cleanly:"
  Write-Output ($BiuVersionOutput | Out-String)
  Write-Output "If you suspect a missing dependency, please file an issue:"
  Write-Output "  https://github.com/mindon/biu/issues/new"
}

Write-Output "biu was installed successfully!"
Write-Output "  Location: $BiuExe"

# ---- update user PATH ----
function Publish-Env {
  if (-not ("Win32.NativeMethods" -as [Type])) {
    Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
  IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
  uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
  }
  $HWND_BROADCAST = [IntPtr] 0xffff
  $WM_SETTINGCHANGE = 0x1a
  $result = [UIntPtr]::Zero
  [Win32.NativeMethods]::SendMessageTimeout(
    $HWND_BROADCAST, $WM_SETTINGCHANGE,
    [UIntPtr]::Zero, "Environment",
    2, 5000, [ref]$result) | Out-Null
}

function Write-Env {
  param([String]$Key, [String]$Value)
  $RegisterKey = Get-Item -Path 'HKCU:'
  $EnvRegisterKey = $RegisterKey.OpenSubKey('Environment', $true)
  if ($null -eq $Value) {
    $EnvRegisterKey.DeleteValue($Key)
  } else {
    $RegistryValueKind = if ($Value.Contains('%')) {
      [Microsoft.Win32.RegistryValueKind]::ExpandString
    } else {
      [Microsoft.Win32.RegistryValueKind]::String
    }
    $EnvRegisterKey.SetValue($Key, $Value, $RegistryValueKind)
  }
  Publish-Env
}

function Get-Env {
  param([String] $Key)
  $RegisterKey = Get-Item -Path 'HKCU:'
  $EnvRegisterKey = $RegisterKey.OpenSubKey('Environment')
  $EnvRegisterKey.GetValue($Key, $null,
    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}

if (-not $NoPathUpdate) {
  $Path = (Get-Env -Key "Path") -split ';'
  if ($Path -notcontains $BiuBin) {
    $Path += $BiuBin
    Write-Env -Key 'Path' -Value (($Path | Where-Object { $_ }) -join ';')
    $env:PATH = "${env:Path};${BiuBin}"
  }
  Write-Env -Key 'BIU_INSTALL' -Value $BiuRoot
} else {
  Write-Output "Skipping PATH update (-NoPathUpdate)"
}

# ---- register uninstall entry ----
if (-not $NoRegisterInstallation) {
  $rootKey = $null
  try {
    $RegistryKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\biu"
    $rootKey = New-Item -Path $RegistryKey -Force
    New-ItemProperty -Path $RegistryKey -Name "DisplayName" -Value "biu" -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $RegistryKey -Name "InstallLocation" -Value $BiuRoot -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $RegistryKey -Name "Publisher" -Value "mindon" -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $RegistryKey -Name "URLInfoAbout" -Value "https://github.com/mindon/biu" -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $RegistryKey -Name "DisplayIcon" -Value $BiuExe -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $RegistryKey -Name "UninstallString" -Value "powershell -c `"& `'$BiuRoot\uninstall.ps1`'`"" -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $RegistryKey -Name "NoModify" -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $RegistryKey -Name "NoRepair" -Value 1 -PropertyType DWord -Force | Out-Null
  } catch {
    if ($rootKey) { Remove-Item -Path $RegistryKey -Force }
    Write-Warning "Failed to register uninstall entry: $_"
  }
}

Write-Output ""
Write-Output "To get started, restart your terminal and run:"
Write-Output "  biu --help"
