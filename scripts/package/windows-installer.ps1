param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('CheckRunning', 'VerifyBootstrapper', 'EnsureWebView2')]
  [string] $Mode,
  [string] $InstallDirectory,
  [string] $Bootstrapper,
  [int] $InstallerProcessId
)
# A pwsh -> Node -> powershell.exe launch can inherit incompatible PS7 modules.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$ErrorActionPreference = 'Stop'

function Assert-MicrosoftBootstrapper {
  $signature = Get-AuthenticodeSignature -LiteralPath $Bootstrapper
  if ($signature.Status -ne 'Valid' -or
      $signature.SignerCertificate.Subject -notmatch '(^|,\s*)CN=Microsoft Corporation(,|$)') {
    throw 'WebView2 bootstrapper must have a valid Microsoft Corporation signature.'
  }
}

function Test-WebView2 {
  $key = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
      $client = $null
      try {
        $client = $base.OpenSubKey($key)
        $version = if ($null -ne $client) { $client.GetValue('pv') } else { $null }
        if ($version -and [version]$version -gt [version]'0.0.0.0') { return $true }
      } finally {
        if ($null -ne $client) { $client.Dispose() }
        $base.Dispose()
      }
    }
  }
  return $false
}

try {
  switch ($Mode) {
    'CheckRunning' {
      if (!$InstallDirectory) { throw 'Missing installation directory.' }
      $prefix = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\') + '\'
      # Include a surviving sidecar, not just the visible window. Never terminate it.
      foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
        if ($process.ProcessId -eq $InstallerProcessId -or $process.ProcessId -eq $PID) { continue }
        if ($process.Name -in @('NediaMatrix.exe', 'nedia-matrix-tauri.exe') -or
            ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase))) {
          Write-Output 'Exit NediaMatrix and wait for its background runtime to stop before installing.'
          exit 10
        }
        if ($process.Name -eq 'node.exe' -and !$process.ExecutablePath) {
          throw 'Cannot inspect a Node process. Close elevated runtimes before installing.'
        }
      }
    }
    'VerifyBootstrapper' { Assert-MicrosoftBootstrapper }
    'EnsureWebView2' {
      if (Test-WebView2) { exit 0 }
      Assert-MicrosoftBootstrapper
      $setup = Start-Process -FilePath $Bootstrapper -ArgumentList '/silent', '/install' -Wait -PassThru
      if ($setup.ExitCode -notin @(0, 3010, 1641) -or !(Test-WebView2)) {
        throw "WebView2 installation failed ($($setup.ExitCode)). Check the network and retry."
      }
    }
  }
  exit 0
} catch {
  Write-Output $_.Exception.Message
  exit 20
}
