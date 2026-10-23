param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ProcessId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[1-9][0-9]{0,18}$')][string]$CreationFileTime,
  [Parameter(Mandatory = $true)][string]$Executable
)
$ErrorActionPreference = 'Stop'
$process = [Diagnostics.Process]::GetProcessById($ProcessId)
try {
  # This is a diagnostic normal-window close, never installer or startup authority.
  $handle = $process.SafeHandle
  $created = $process.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
  if ($process.HasExited -or $created -cne $CreationFileTime -or -not [StringComparer]::OrdinalIgnoreCase.Equals($process.MainModule.FileName, [IO.Path]::GetFullPath($Executable))) {
    throw 'The recorded restarted Main is not the expected live installed application.'
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  $requested = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    $process.Refresh()
    if ($process.MainWindowHandle -ne [IntPtr]::Zero -and $process.CloseMainWindow()) {
      $requested = $true
    }
    if ($process.WaitForExit(500)) {
      if (-not $requested -or $process.ExitCode -ne 0) {
        throw 'The restarted Main exited without a successful normal-window close.'
      }
      [ordered]@{ version = 1; closed = $true } | ConvertTo-Json -Compress
      return
    }
  }
  throw 'The restarted Main did not exit after normal-window close; it was not terminated.'
} finally {
  $process.Dispose()
}
