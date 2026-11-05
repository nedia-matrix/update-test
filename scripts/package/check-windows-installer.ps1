param(
  [Parameter(Mandatory = $true)][string] $OldInstaller,
  [Parameter(Mandatory = $true)][string] $TauriInstaller,
  [Parameter(Mandatory = $true)][string] $ElectronInstaller,
  [Parameter(Mandatory = $true)][string] $FixtureRoot
)
# A pwsh -> Node -> powershell.exe launch can inherit incompatible PS7 modules.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Requires a disposable GitHub runner.' }

function Get-InstallEntries {
  foreach ($hive in @('HKCU', 'HKLM')) {
    $path = "$($hive):\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    if (!(Test-Path -LiteralPath $path -ErrorAction Stop)) { continue }
    Get-ItemProperty "$path\*" |
      Where-Object { $_.DisplayName -eq 'NediaMatrix' }
  }
}
function Assert($condition, $message) { if (!$condition) { throw $message } }
function Run-Setup($file, $arguments, $expected = 0) {
  $process = Start-Process -FilePath $file -ArgumentList $arguments -PassThru
  # Retain the native handle so fast exits still expose their exit code in PS5.
  $null = $process.Handle
  if (!$process.WaitForExit(120000)) { throw "Installer timed out: $file" }
  Assert ($process.ExitCode -eq $expected) "Installer exit $($process.ExitCode), expected $expected"
}
function Get-Links($scope) {
  $desktop = if ($scope -eq 'allusers') { [Environment]::GetFolderPath('CommonDesktopDirectory') } else { [Environment]::GetFolderPath('DesktopDirectory') }
  $programs = if ($scope -eq 'allusers') { [Environment]::GetFolderPath('CommonPrograms') } else { [Environment]::GetFolderPath('Programs') }
  return @((Join-Path $desktop 'NediaMatrix.lnk'), (Join-Path $programs 'NediaMatrix.lnk'))
}

Assert (@(Get-InstallEntries).Count -eq 0) 'A pre-existing NediaMatrix install must not be modified.'
$data = Join-Path $env:APPDATA '@nedia-matrix\desktop'
Assert (!(Test-Path $data)) 'A pre-existing data directory must not be modified.'
New-Item -ItemType Directory -Force $data | Out-Null
$sentinel = Join-Path $data 'nsis-test-sentinel.txt'
Set-Content -LiteralPath $sentinel -Value 'keep business data'
$shell = New-Object -ComObject WScript.Shell

foreach ($scope in @('currentuser', 'allusers')) {
  # Keep source ASCII for Windows PowerShell 5.1 without a UTF-8 BOM.
  $unicodeSegment = [string][char]0x4E2D + [char]0x6587
  $directory = Join-Path $FixtureRoot "custom directory $unicodeSegment $scope"
  try {
    Run-Setup $OldInstaller "/S /$scope /D=$directory"
    $entry = @(Get-InstallEntries)
    Assert ($entry.Count -eq 1) 'Expected one uninstall entry.'
    $registryPath = $entry[0].PSPath
    Assert ($entry[0].UninstallString.Contains("/$scope")) 'Initial installation scope mismatch.'
    $links = Get-Links $scope
    foreach ($link in $links) {
      Assert (Test-Path $link) "Missing shortcut: $link"
      Assert ($shell.CreateShortcut($link).TargetPath -eq "$directory\NediaMatrix.exe") 'Initial shortcut target mismatch.'
    }

    # Install with no /D or scope override: both must come from the old install.
    Run-Setup $TauriInstaller '/S'
    Assert (Test-Path "$directory\runtime\sidecar.mjs") 'Native payload missing from inherited directory.'
    Assert (!(Test-Path "$directory\resources\app.asar")) 'Old Electron program files remain.'
    Assert (!(Test-Path "$directory\old-electron.txt")) 'Old payload marker remains.'

    # A visible GUI and an orphan sidecar must each block replacement, staying alive.
    foreach ($kind in @('gui', 'sidecar')) {
      $executable = "$directory\NediaMatrix.exe"
      if ($kind -eq 'sidecar') {
        $executable = "$directory\runtime\node.exe"
        Copy-Item "$directory\NediaMatrix.exe" $executable
      }
      $running = Start-Process -FilePath $executable -ArgumentList '-t', '127.0.0.1' -WindowStyle Hidden -PassThru
      try {
        Run-Setup $ElectronInstaller '/S' 10
        Assert (!$running.HasExited) 'Installer terminated an active runtime.'
        Assert (Test-Path "$directory\runtime\sidecar.mjs") 'Blocked installer changed program files.'
      } finally { Stop-Process -Id $running.Id -ErrorAction SilentlyContinue; $running.WaitForExit() }
    }

    Run-Setup $ElectronInstaller '/S'
    Assert (Test-Path "$directory\resources\app.asar") 'Electron payload missing from inherited directory.'
    Assert (!(Test-Path "$directory\runtime")) 'Old Tauri runtime remains.'
    Assert (!(Test-Path "$directory\tauri.txt")) 'Old Tauri marker remains.'
    $entry = @(Get-InstallEntries)
    Assert ($entry.Count -eq 1 -and $entry[0].PSPath -eq $registryPath) 'Uninstall entry changed or duplicated.'
    Assert ($entry[0].UninstallString.Contains("/$scope")) 'Installation scope changed.'
    foreach ($link in $links) {
      Assert (Test-Path $link) "Shortcut lost: $link"
      Assert ($shell.CreateShortcut($link).TargetPath -eq "$directory\NediaMatrix.exe") 'Shortcut target changed.'
    }
    Run-Setup "$directory\Uninstall NediaMatrix.exe" "/S /$scope _?=$directory"
    Assert (@(Get-InstallEntries).Count -eq 0) 'Uninstall entry remains.'
    foreach ($link in $links) { Assert (!(Test-Path $link)) 'Shortcut remains after uninstall.' }
    Assert ((Get-Content -LiteralPath $sentinel) -eq 'keep business data') 'Business data changed or removed.'
    Write-Output "NSIS inheritance passed: $scope"
  } finally {
    # Only uninstall the fixture if it exists. The preflight above guarantees
    # that no user installation or business data was present before this test.
    if (Test-Path "$directory\Uninstall NediaMatrix.exe") {
      Run-Setup "$directory\Uninstall NediaMatrix.exe" "/S /$scope _?=$directory"
    }
  }
}
Remove-Item -LiteralPath $data -Recurse -Force
