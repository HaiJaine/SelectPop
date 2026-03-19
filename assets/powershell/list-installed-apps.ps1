$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)

$items = foreach ($root in $roots) {
  try {
    Get-ItemProperty -Path $root -ErrorAction Stop |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_.DisplayName) } |
      Select-Object DisplayName, DisplayIcon, InstallLocation
  } catch {
  }
}

@($items) | ConvertTo-Json -Compress
