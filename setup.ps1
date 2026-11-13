# GamepadNav setup: builds Vencord with the GamepadNav userplugin.
#   .\setup.ps1          clone (if needed), copy plugin in, install deps, build
#   .\setup.ps1 -Inject  also patch Discord with this build (close Discord first)
#   .\setup.ps1 -Quick   just copy the plugin and rebuild (after editing it)
param([switch]$Inject, [switch]$Quick)
# "Continue": pnpm prints harmless warnings to stderr, which "Stop" would treat as fatal
$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$vc = Join-Path $root "vencord"

if (-not (Test-Path $vc)) {
    git clone --depth 1 https://github.com/Vendicated/Vencord.git $vc
}

# Copy (not link): esbuild resolves links to their real path, which breaks
# Vencord's @api/@webpack import aliases.
$dest = Join-Path $vc "src\userplugins\gamepadNav"
robocopy (Join-Path $root "plugin\gamepadNav") $dest /MIR /NJH /NJS /NFL /NDL | Out-Null
if ($LASTEXITCODE -ge 8) { throw "copy failed" }

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { npm i -g pnpm }

Push-Location $vc
try {
    if (-not $Quick) { pnpm install --frozen-lockfile }
    pnpm build
    if ($LASTEXITCODE) { throw "build failed" }
    if ($Inject) {
        Write-Host "Close Discord fully (tray icon > Quit) before continuing." -ForegroundColor Yellow
        pnpm inject
    }
} finally { Pop-Location }

# Steam host app: build and install to a stable path (point the Steam shortcut here)
if (-not $Quick -and (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Push-Location (Join-Path $root "host")
    try {
        cargo build --release
        $hostDir = Join-Path $env:LOCALAPPDATA "DiscordHost"
        New-Item -ItemType Directory -Force $hostDir | Out-Null
        Copy-Item "target\release\DiscordHost.exe" $hostDir -Force
        Write-Host "Host installed to $hostDir\DiscordHost.exe" -ForegroundColor Green
    } finally { Pop-Location }
}

Write-Host "Done. After editing the plugin: .\setup.ps1 -Quick, then Ctrl+R in Discord" -ForegroundColor Green
