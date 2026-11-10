# ============================================================
#  J.A.R.V.I.S. — сборка настольного приложения для Windows
# ============================================================
#  Требуется .NET Framework 4.x (csc.exe) и уже подготовленные
#  папки desktop\lib и desktop\tts\py (WebView2 SDK + Python).
#  Результат: desktop\dist\Jarvis.exe
# ============================================================

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root "dist"
$ui = Join-Path $dist "ui"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path $csc)) {
    throw "Не найден csc.exe (.NET Framework 4.x): $csc"
}

$lib = Join-Path $root "lib"
$tts = Join-Path $root "tts"
$icon = Join-Path (Split-Path -Parent $root) "icons\icon.ico"

foreach ($required in @(
    (Join-Path $lib "Microsoft.Web.WebView2.Core.dll"),
    (Join-Path $lib "Microsoft.Web.WebView2.WinForms.dll"),
    (Join-Path $lib "WebView2Loader.dll"),
    (Join-Path $tts "worker.py"),
    (Join-Path $tts "py\python.exe")
)) {
    if (-not (Test-Path $required)) {
        throw "Не найден обязательный файл: $required"
    }
}

Write-Host "Очистка dist..." -ForegroundColor Cyan
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $ui | Out-Null

Write-Host "Компиляция Jarvis.exe..." -ForegroundColor Cyan
$cscArgs = @(
    "/nologo",
    "/target:winexe",
    "/platform:x64",
    "/optimize+",
    "/out:$dist\Jarvis.exe",
    "/reference:$lib\Microsoft.Web.WebView2.Core.dll",
    "/reference:$lib\Microsoft.Web.WebView2.WinForms.dll",
    "/reference:System.Web.Extensions.dll",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.dll",
    "/reference:System.Core.dll",
    (Join-Path $root "Jarvis.cs")
)
if (Test-Path $icon) {
    $cscArgs = @("/win32icon:$icon") + $cscArgs
}

& $csc $cscArgs
if ($LASTEXITCODE -ne 0) {
    throw "Компиляция завершилась с ошибкой (код $LASTEXITCODE)"
}

Write-Host "Копирование WebView2..." -ForegroundColor Cyan
Copy-Item (Join-Path $lib "Microsoft.Web.WebView2.Core.dll") $dist -Force
Copy-Item (Join-Path $lib "Microsoft.Web.WebView2.WinForms.dll") $dist -Force
Copy-Item (Join-Path $lib "WebView2Loader.dll") $dist -Force

Write-Host "Копирование интерфейса..." -ForegroundColor Cyan
$webRoot = Split-Path -Parent $root
foreach ($item in @("index.html", "style.css", "manifest.webmanifest", "sw.js")) {
    Copy-Item (Join-Path $webRoot $item) $ui -Force
}
Copy-Item (Join-Path $webRoot "js") (Join-Path $ui "js") -Recurse -Force
Copy-Item (Join-Path $webRoot "icons") (Join-Path $ui "icons") -Recurse -Force
Copy-Item (Join-Path $webRoot "agents") (Join-Path $dist "agents") -Recurse -Force

Write-Host "Копирование голосового движка (это может занять минуту)..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $dist "tts") | Out-Null
Copy-Item (Join-Path $tts "worker.py") (Join-Path $dist "tts") -Force
robocopy (Join-Path $tts "py") (Join-Path $dist "tts\py") /E /NFL /NDL /NJH /NJS /NP | Out-Null

$configExample = @{
    opencodeUrl = "http://127.0.0.1:4096"
    autoStartServer = $true
    opencodeBin = ""
    port = 8737
    devTools = $false
} | ConvertTo-Json
$configExample | Set-Content -Path (Join-Path $dist "jarvis.config.example.json") -Encoding UTF8

$size = (Get-ChildItem $dist -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ""
Write-Host ("Готово: {0}" -f (Join-Path $dist "Jarvis.exe")) -ForegroundColor Green
Write-Host ("Размер сборки: {0:N1} МБ" -f $size) -ForegroundColor Green
