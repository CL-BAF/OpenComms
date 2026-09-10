/**
 * Windows install wizard (spec: Windows-first cross-platform installers).
 *
 * Double-clicking the standalone exe must DO something visible: the CLI's
 * no-args path on a Windows TTY launches this PowerShell/WinForms wizard,
 * which installs the exe into the user's programs directory, optionally adds
 * it to the user PATH, and creates Start Menu / desktop shortcuts. The same
 * script exposes headless core functions (-TestCore) so the install logic is
 * testable without a UI, and an uninstall core shared with `uninstall-self`.
 *
 * The script is EMBEDDED in the exe bundle (String.raw template) and passed
 * to powershell.exe via -EncodedCommand (UTF-16LE base64), which bypasses
 * execution policy without touching any global setting. No external
 * dependencies: WinForms + WScript.Shell + registry only.
 *
 * NOTE: the script deliberately avoids `backtick` escapes and ${ sequences
 * so it survives being a TypeScript template literal verbatim.
 */

export const WIZARD_PS1 = String.raw`param(
  # Defaults come from env so the launcher can pass paths alongside
  # -EncodedCommand (which cannot carry parameters on the command line).
  [string]$SourceExe = $env:OPENCOMMS_WIZARD_EXE,
  [string]$IconSource = $env:OPENCOMMS_WIZARD_ICON,
  [string]$InstallDir = $env:OPENCOMMS_WIZARD_DIR,
  [string]$ShortcutOverride = "",
  [switch]$NoPath,
  [switch]$NoStartMenu,
  [switch]$NoDesktop,
  [switch]$TestCore,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"

function Get-DefaultInstallDir {
  Join-Path $env:LOCALAPPDATA "Programs\OpenComms"
}

function Get-StartMenuDir {
  Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\OpenComms"
}

function Get-DesktopDir {
  [Environment]::GetFolderPath("Desktop")
}

function Get-UserPathRaw {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $false)
  try { return [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  finally { $key.Close() }
}

function Set-UserPath([string]$newValue) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
  try {
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    try { $kind = $key.GetValueKind("Path") } catch { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
    $key.SetValue("Path", $newValue, $kind)
  } finally { $key.Close() }
  Add-Type -Namespace OpenCommsNative -Name Win32 -MemberDefinition '[DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);' -ErrorAction SilentlyContinue
  $result = [UIntPtr]::Zero
  [OpenCommsNative.Win32]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result) | Out-Null
}

function Add-ToUserPath([string]$dir) {
  $current = Get-UserPathRaw
  $parts = @($current -split ";" | Where-Object { $_ -ne "" })
  $match = $parts | Where-Object { $_.TrimEnd("\").ToLowerInvariant() -eq $dir.TrimEnd("\").ToLowerInvariant() }
  if ($match) { return "PATH already contains $dir" }
  $parts += $dir
  Set-UserPath (($parts -join ";"))
  return "Added to user PATH: $dir"
}

function Remove-FromUserPath([string]$dir) {
  $current = Get-UserPathRaw
  $parts = @($current -split ";" | Where-Object { $_ -ne "" })
  $kept = @($parts | Where-Object { $_.TrimEnd("\").ToLowerInvariant() -ne $dir.TrimEnd("\").ToLowerInvariant() })
  if ($kept.Count -eq $parts.Count) { return "PATH did not contain $dir" }
  Set-UserPath (($kept -join ";"))
  return "Removed from user PATH: $dir"
}

function New-Shortcut([string]$linkPath, [string]$targetPath, [string]$arguments, [string]$description, [string]$iconPath) {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($linkPath)
  $link.TargetPath = $targetPath
  if ($arguments -ne "") { $link.Arguments = $arguments }
  $link.Description = $description
  $link.WorkingDirectory = Split-Path -Parent $targetPath
  if ($iconPath -ne "") { $link.IconLocation = "$iconPath, 0" }
  $link.Save()
}

function Invoke-InstallCore([string]$srcExe, [string]$iconSrc, [string]$dir, [bool]$path, [bool]$menu, [bool]$desktop, [string]$shortcutOverride) {
  $log = @()
  if (-not (Test-Path -LiteralPath $srcExe)) { throw "source exe not found: $srcExe" }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $target = Join-Path $dir "opencomms.exe"
  Copy-Item -LiteralPath $srcExe -Destination $target -Force
  $log += "Installed: $target"
  $iconPath = ""
  if ($iconSrc -ne "" -and (Test-Path -LiteralPath $iconSrc)) {
    $iconPath = Join-Path $dir "icon.ico"
    Copy-Item -LiteralPath $iconSrc -Destination $iconPath -Force
    $log += "Icon installed: $iconPath"
  }
  if ($menu) {
    $menuDir = Get-StartMenuDir
    New-Item -ItemType Directory -Force -Path $menuDir | Out-Null
    New-Shortcut (Join-Path $menuDir "OpenComms.lnk") $target "gui" "OpenComms console" $iconPath
    New-Shortcut (Join-Path $menuDir "OpenComms Uninstall.lnk") $target "uninstall-self" "Uninstall OpenComms" $iconPath
    $log += "Start Menu shortcuts: $menuDir"
  }
  if ($desktop) {
    $deskDir = if ($shortcutOverride -ne "") { $shortcutOverride } else { Get-DesktopDir }
    New-Shortcut (Join-Path $deskDir "OpenComms.lnk") $target "gui" "OpenComms console" $iconPath
    $log += "Desktop shortcut: $(Join-Path $deskDir 'OpenComms.lnk')"
  }
  if ($path) { $log += (Add-ToUserPath $dir) }
  return $log
}

function Invoke-UninstallCore([string]$dir, [bool]$path, [bool]$menu, [bool]$desktop) {
  $log = @()
  if ($path) { $log += (Remove-FromUserPath $dir) }
  $menuDir = Get-StartMenuDir
  if (Test-Path -LiteralPath $menuDir) {
    Remove-Item -LiteralPath $menuDir -Recurse -Force
    $log += "Removed Start Menu folder: $menuDir"
  }
  if ($desktop) {
    $deskLnk = Join-Path (Get-DesktopDir) "OpenComms.lnk"
    if (Test-Path -LiteralPath $deskLnk) { Remove-Item -LiteralPath $deskLnk -Force; $log += "Removed desktop shortcut" }
  }
  return $log
}

if ($TestCore) {
  $log = Invoke-InstallCore $SourceExe $IconSource $InstallDir (-not $NoPath) (-not $NoStartMenu) (-not $NoDesktop) $ShortcutOverride
  $log | ForEach-Object { Write-Output "LOG: $_" }
  if (Test-Path -LiteralPath (Join-Path $InstallDir "opencomms.exe")) { Write-Output "VERIFY: exe present" } else { throw "install failed: exe missing" }
  return
}

if ($Uninstall) {
  $dir = if ($InstallDir -ne "") { $InstallDir } else { Get-DefaultInstallDir }
  $log = Invoke-UninstallCore $dir $true $true $true
  $log | ForEach-Object { Write-Output "LOG: $_" }
  return
}

# ---------------- WinForms wizard UI (dark, per spec) ----------------
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

$script:page   = [System.Drawing.ColorTranslator]::FromHtml("#111111")
$script:card   = [System.Drawing.ColorTranslator]::FromHtml("#1c1c1c")
$script:nested = [System.Drawing.ColorTranslator]::FromHtml("#272727")
$script:border = [System.Drawing.ColorTranslator]::FromHtml("#333333")
$script:text   = [System.Drawing.ColorTranslator]::FromHtml("#e8e8e8")
$script:muted  = [System.Drawing.ColorTranslator]::FromHtml("#9a9a9a")
$script:good   = [System.Drawing.ColorTranslator]::FromHtml("#7fa878")
$script:bad    = [System.Drawing.ColorTranslator]::FromHtml("#a86b6b")

$state = @{ step = 0; dir = Get-DefaultInstallDir; addPath = $true; addMenu = $true; addDesktop = $true; log = @() }

$form = New-Object System.Windows.Forms.Form
$form.Text = "OpenComms Setup"
$form.Size = New-Object System.Drawing.Size(660, 480)
$form.StartPosition = "CenterScreen"
$form.BackColor = $script:page
$form.ForeColor = $script:text
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9.5)

function New-Card([System.Windows.Forms.Control]$parent, [int]$x, [int]$y, [int]$w, [int]$h) {
  $p = New-Object System.Windows.Forms.Panel
  $p.Location = New-Object System.Drawing.Point($x, $y)
  $p.Size = New-Object System.Drawing.Size($w, $h)
  $p.BackColor = $script:card
  $p.BorderStyle = "FixedSingle"
  $form.Controls.Add($p)
  return $p
}

function New-Label([System.Windows.Forms.Control]$parent, [string]$text, [int]$x, [int]$y, [int]$w, [System.Drawing.Color]$color, [bool]$bold) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text
  $l.Location = New-Object System.Drawing.Point($x, $y)
  $l.Size = New-Object System.Drawing.Size($w, 22)
  $l.ForeColor = $color
  $l.BackColor = [System.Drawing.Color]::Transparent
  if ($bold) { $l.Font = New-Object System.Drawing.Font($form.Font, [System.Drawing.FontStyle]::Bold) }
  $form.Controls.Add($l)
  return $l
}

$title = New-Label "OpenComms" 24 14 200 $script:text $true
$titleSub = New-Label "Multi-agent communication for coding agents" 128 17 400 $script:muted $false

$card = New-Card 24 46 600 330
$body = New-Label "" 40 70 560 300 $script:text $false
$body.AutoSize = $false
$body.Height = 290

$pathCheck = New-Object System.Windows.Forms.CheckBox
$pathCheck.Text = "Add opencomms.exe to the user PATH (recommended)"
$pathCheck.Checked = $true
$pathCheck.ForeColor = $script:text
$pathCheck.BackColor = [System.Drawing.Color]::Transparent
$pathCheck.Location = New-Object System.Drawing.Point(40, 178)
$form.Controls.Add($pathCheck)

$menuCheck = New-Object System.Windows.Forms.CheckBox
$menuCheck.Text = "Create Start Menu shortcuts (console + uninstall)"
$menuCheck.Checked = $true
$menuCheck.ForeColor = $script:text
$menuCheck.BackColor = [System.Drawing.Color]::Transparent
$menuCheck.Location = New-Object System.Drawing.Point(40, 203)
$form.Controls.Add($menuCheck)

$deskCheck = New-Object System.Windows.Forms.CheckBox
$deskCheck.Text = "Create a desktop shortcut (with the OpenComms icon)"
$deskCheck.Checked = $true
$deskCheck.ForeColor = $script:text
$deskCheck.BackColor = [System.Drawing.Color]::Transparent
$deskCheck.Location = New-Object System.Drawing.Point(40, 228)
$form.Controls.Add($deskCheck)

$dirLabel = New-Label "Install location:" 40 120 120 $script:muted $false
$dirBox = New-Object System.Windows.Forms.TextBox
$dirBox.Location = New-Object System.Drawing.Point(40, 140)
$dirBox.Size = New-Object System.Drawing.Size(460, 24)
$dirBox.BackColor = $script:nested
$dirBox.ForeColor = $script:text
$dirBox.BorderStyle = "FixedSingle"
$dirBox.Text = $state.dir
$form.Controls.Add($dirBox)

$browse = New-Object System.Windows.Forms.Button
$browse.Text = "Browse..."
$browse.Location = New-Object System.Drawing.Point(510, 139)
$browse.Size = New-Object System.Drawing.Size(90, 26)
$browse.BackColor = $script:nested
$browse.ForeColor = $script:text
$browse.FlatAppearance.BorderColor = $script:border
$browse.FlatStyle = "Flat"
$form.Controls.Add($browse)

$back = New-Object System.Windows.Forms.Button
$back.Text = "Back"
$back.Location = New-Object System.Drawing.Point(348, 400)
$back.Size = New-Object System.Drawing.Size(80, 30)
$back.BackColor = $script:nested
$back.ForeColor = $script:text
$back.FlatAppearance.BorderColor = $script:border
$back.FlatStyle = "Flat"
$back.Enabled = $false
$form.Controls.Add($back)

$next = New-Object System.Windows.Forms.Button
$next.Text = "Next"
$next.Location = New-Object System.Drawing.Point(436, 400)
$next.Size = New-Object System.Drawing.Size(80, 30)
$next.BackColor = $script:nested
$next.ForeColor = $script:text
$next.FlatAppearance.BorderColor = $script:border
$next.FlatStyle = "Flat"
$form.Controls.Add($next)

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = "Cancel"
$cancel.Location = New-Object System.Drawing.Point(524, 400)
$cancel.Size = New-Object System.Drawing.Size(80, 30)
$cancel.BackColor = $script:nested
$cancel.ForeColor = $script:text
$cancel.FlatAppearance.BorderColor = $script:border
$cancel.FlatStyle = "Flat"
$form.Controls.Add($cancel)

function Show-Welcome {
  $dirBox.Visible = $false; $dirLabel.Visible = $false; $browse.Visible = $false
  $pathCheck.Visible = $false; $menuCheck.Visible = $false; $deskCheck.Visible = $false
  $back.Enabled = $false; $next.Text = "Next"
  $body.Text = "OpenComms links the agent sessions you already have open - OpenCode, Claude Code, Claude Desktop, Codex - into shared multi-agent channels. Provider sessions stay yours; OpenComms only coordinates them." + [Environment]::NewLine + [Environment]::NewLine + "This wizard will:" + [Environment]::NewLine + "  1. Install opencomms.exe (the CLI + local console server)" + [Environment]::NewLine + "  2. Optionally add it to your user PATH" + [Environment]::NewLine + "  3. Create Start Menu / desktop shortcuts" + [Environment]::NewLine + [Environment]::NewLine + "Nothing is installed outside your user profile. An uninstall shortcut is included."
}

function Show-Location {
  $dirBox.Visible = $true; $dirLabel.Visible = $true; $browse.Visible = $true
  $pathCheck.Visible = $true; $menuCheck.Visible = $true; $deskCheck.Visible = $true
  $back.Enabled = $true; $next.Text = "Install"
  $body.Text = "Choose where to install opencomms.exe, then pick the integration options."
}

function Show-Installing {
  $dirBox.Visible = $false; $dirLabel.Visible = $false; $browse.Visible = $false
  $pathCheck.Visible = $false; $menuCheck.Visible = $false; $deskCheck.Visible = $false
  $back.Enabled = $false; $next.Enabled = $false; $next.Text = "Installing..."
  $form.Refresh()
  try {
    $state.log = Invoke-InstallCore $SourceExe $IconSource $dirBox.Text $pathCheck.Checked $menuCheck.Checked $deskCheck.Checked $ShortcutOverride
    Show-Done
  } catch {
    $next.Enabled = $true; $next.Text = "Retry"
    $back.Enabled = $true
    $body.ForeColor = $script:bad
    $body.Text = "Installation failed:" + [Environment]::NewLine + $_.Exception.Message + [Environment]::NewLine + [Environment]::NewLine + "Close this wizard and re-run the installer to retry."
  }
}

function Show-Done {
  $next.Text = "Finish"
  $next.Enabled = $true
  $next.Visible = $true
  $body.ForeColor = $script:text
  $summary = ($state.log | ForEach-Object { "  " + $_ }) -join [Environment]::NewLine
  $body.Text = "OpenComms is installed." + [Environment]::NewLine + $summary + [Environment]::NewLine + [Environment]::NewLine + "Run 'opencomms gui' (or use the shortcut) for the local console. 'opencomms doctor' checks any project."
}

$browse.Add_Click({
  $fbd = New-Object System.Windows.Forms.FolderBrowserDialog
  $fbd.SelectedPath = $dirBox.Text
  if ($fbd.ShowDialog($form) -eq "OK") { $dirBox.Text = $fbd.SelectedPath }
})

$back.Add_Click({
  $script:state.step = 0
  Show-Welcome
})

$cancel.Add_Click({ $form.Close() })

$next.Add_Click({
  switch ($script:state.step) {
    0 {
      $script:state.step = 1
      Show-Location
    }
    1 {
      if ([string]::IsNullOrWhiteSpace($dirBox.Text)) {
        [System.Windows.Forms.MessageBox]::Show($form, "Choose an install folder.", "OpenComms Setup") | Out-Null
        return
      }
      $script:state.step = 2
      Show-Installing
    }
    2 {
      $form.Close()
    }
  }
})

Show-Welcome
[void]$form.ShowDialog()
`
