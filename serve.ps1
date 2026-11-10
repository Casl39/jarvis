#requires -Version 5.1
<#
    J.A.R.V.I.S. — локальный сервер интерфейса и прокси к OpenCode (Windows).

    Запуск:
        powershell -ExecutionPolicy Bypass -File serve.ps1 -OpenBrowser

    Зависимостей нет: только Windows PowerShell 5.1.
#>

[CmdletBinding()]
param(
    [int]$Port = 8000,
    [switch]$Lan,
    [string]$OpenCode = $(if ($env:OPENCODE_URL) { $env:OPENCODE_URL } else { "http://127.0.0.1:4096" }),
    [string]$Password = $env:OPENCODE_PASSWORD,
    [switch]$OpenBrowser,
    [switch]$InstallAgent
)

$ErrorActionPreference = "Stop"
[System.Net.ServicePointManager]::Expect100Continue = $false
try {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
} catch { }

$Root = $PSScriptRoot
if (-not $Root) { $Root = (Get-Location).Path }
$Root = [System.IO.Path]::GetFullPath($Root)

# ============================================================
#   Общие функции (используются и в рабочих потоках)
# ============================================================

$commonSource = @'
function Get-Mime([string]$Path) {
    switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        ".html" { "text/html; charset=utf-8" }
        ".htm"  { "text/html; charset=utf-8" }
        ".css"  { "text/css; charset=utf-8" }
        ".js"   { "text/javascript; charset=utf-8" }
        ".mjs"  { "text/javascript; charset=utf-8" }
        ".json" { "application/json; charset=utf-8" }
        ".webmanifest" { "application/manifest+json; charset=utf-8" }
        ".svg"  { "image/svg+xml; charset=utf-8" }
        ".png"  { "image/png" }
        ".jpg"  { "image/jpeg" }
        ".jpeg" { "image/jpeg" }
        ".gif"  { "image/gif" }
        ".ico"  { "image/x-icon" }
        ".woff" { "font/woff" }
        ".woff2" { "font/woff2" }
        ".txt"  { "text/plain; charset=utf-8" }
        ".md"   { "text/markdown; charset=utf-8" }
        default { "application/octet-stream" }
    }
}

function Write-Response {
    param(
        $Stream,
        [int]$Status,
        [string]$Reason,
        [System.Collections.IDictionary]$Headers,
        [byte[]]$Body,
        [switch]$Head
    )

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("HTTP/1.1 $Status $Reason`r`n")
    foreach ($key in $Headers.Keys) {
        [void]$sb.Append("$key`: $($Headers[$key])`r`n")
    }
    [void]$sb.Append("Connection: close`r`n`r`n")

    $headBytes = [System.Text.Encoding]::ASCII.GetBytes($sb.ToString())
    $Stream.Write($headBytes, 0, $headBytes.Length)
    if ($Body -and $Body.Length -gt 0 -and -not $Head) {
        $Stream.Write($Body, 0, $Body.Length)
    }
    $Stream.Flush()
}

function Write-Json {
    param($Stream, [int]$Status, [string]$Reason, $Payload)
    $json = $Payload | ConvertTo-Json -Depth 6 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Write-Response -Stream $Stream -Status $Status -Reason $Reason -Headers ([ordered]@{
        "Content-Type"   = "application/json; charset=utf-8"
        "Content-Length" = $bytes.Length
        "Cache-Control"  = "no-store"
    }) -Body $bytes
}

function Read-Request {
    param($Stream)

    $ms = New-Object System.IO.MemoryStream
    $one = New-Object byte[] 1
    $matched = 0

    while ($true) {
        $n = $Stream.Read($one, 0, 1)
        if ($n -le 0) { return $null }
        $ms.WriteByte($one[0])

        if ($one[0] -eq 13 -and ($matched -eq 0 -or $matched -eq 2)) { $matched++ }
        elseif ($one[0] -eq 10 -and ($matched -eq 1 -or $matched -eq 3)) { $matched++ }
        else { $matched = 0 }

        if ($matched -eq 4) { break }
        if ($ms.Length -gt 65536) { return $null }
    }

    $text = [System.Text.Encoding]::ASCII.GetString($ms.ToArray())
    $lines = $text -split "`r`n"
    if ($lines.Length -lt 1 -or [string]::IsNullOrWhiteSpace($lines[0])) { return $null }

    $parts = $lines[0] -split ' '
    if ($parts.Length -lt 2) { return $null }

    $method = $parts[0].ToUpperInvariant()
    $target = $parts[1]

    $path = $target
    $query = ""
    $qIndex = $target.IndexOf('?')
    if ($qIndex -ge 0) {
        $path = $target.Substring(0, $qIndex)
        $query = $target.Substring($qIndex)
    }

    $headers = @{}
    for ($i = 1; $i -lt $lines.Length; $i++) {
        $line = $lines[$i]
        $idx = $line.IndexOf(':')
        if ($idx -gt 0) {
            $name = $line.Substring(0, $idx).Trim().ToLowerInvariant()
            $headers[$name] = $line.Substring($idx + 1).Trim()
        }
    }

    $body = $null
    if ($headers.ContainsKey("content-length")) {
        $length = 0
        [void][int]::TryParse($headers["content-length"], [ref]$length)
        if ($length -gt 0) {
            $body = New-Object byte[] $length
            $read = 0
            while ($read -lt $length) {
                $n = $Stream.Read($body, $read, $length - $read)
                if ($n -le 0) { break }
                $read += $n
            }
        }
    }

    return @{
        Method  = $method
        Path    = $path
        Query   = $query
        Headers = $headers
        Body    = $body
    }
}

function Invoke-Static {
    param($Stream, $Request, $Config)

    $path = $Request.Path
    if ([string]::IsNullOrEmpty($path) -or $path -eq "/") { $path = "/index.html" }

    $rel = [System.Uri]::UnescapeDataString($path).TrimStart('/')
    $rel = $rel -replace '/', '\'

    $full = $null
    try {
        $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($Config.Root, $rel))
    } catch {
        Write-Response -Stream $Stream -Status 400 -Reason "Bad Request" -Headers ([ordered]@{
            "Content-Type" = "text/plain; charset=utf-8"; "Content-Length" = 9
        }) -Body ([System.Text.Encoding]::UTF8.GetBytes("Bad path!"))
        return
    }

    $rootPrefix = $Config.Root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [System.IO.File]::Exists($full)) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("Not found")
        Write-Response -Stream $Stream -Status 404 -Reason "Not Found" -Headers ([ordered]@{
            "Content-Type" = "text/plain; charset=utf-8"; "Content-Length" = $bytes.Length
        }) -Body $bytes -Head:($Request.Method -eq "HEAD")
        return
    }

    $bytes = [System.IO.File]::ReadAllBytes($full)
    Write-Response -Stream $Stream -Status 200 -Reason "OK" -Headers ([ordered]@{
        "Content-Type"   = (Get-Mime $full)
        "Content-Length" = $bytes.Length
        "Cache-Control"  = "no-store"
        "Service-Worker-Allowed" = "/"
    }) -Body $bytes -Head:($Request.Method -eq "HEAD")
}

function Invoke-Proxy {
    param($Stream, $Request, $Config)

    $upstreamPath = $Request.Path
    if ($upstreamPath -eq "/oc") { $upstreamPath = "/" }
    elseif ($upstreamPath.StartsWith("/oc/")) { $upstreamPath = $upstreamPath.Substring(3) }

    $url = $Config.OpenCode.TrimEnd('/') + $upstreamPath + $Request.Query

    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Method = $Request.Method
    $req.AllowAutoRedirect = $false
    $req.AllowReadStreamBuffering = $false
    $req.KeepAlive = $false
    $req.Proxy = $null
    $req.UserAgent = "JarvisUI/1.0"
    $req.Timeout = 30000
    $req.ReadWriteTimeout = 3600000

    if ($Request.Headers.ContainsKey("content-type")) {
        $req.ContentType = $Request.Headers["content-type"]
    }
    if ($Request.Headers.ContainsKey("accept")) {
        $req.Accept = $Request.Headers["accept"]
    }
    if ($Request.Headers.ContainsKey("range")) {
        $req.Headers["Range"] = $Request.Headers["range"]
    }

    if ($Config.Password) {
        $token = [Convert]::ToBase64String(
            [System.Text.Encoding]::UTF8.GetBytes("opencode:" + $Config.Password)
        )
        $req.Headers["Authorization"] = "Basic " + $token
    }

    if ($Request.Body -and $Request.Body.Length -gt 0) {
        $rs = $req.GetRequestStream()
        $rs.Write($Request.Body, 0, $Request.Body.Length)
        $rs.Close()
    }

    $resp = $null
    try {
        $resp = $req.GetResponse()
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            $resp = $_.Exception.Response
        }
    } catch {
        $resp = $null
    }

    if (-not $resp) {
        Write-Json -Stream $Stream -Status 502 -Reason "Bad Gateway" -Payload @{
            message = "OpenCode недоступен по адресу $($Config.OpenCode). Запустите: opencode serve"
        }
        return
    }

    try {
        $status = [int]$resp.StatusCode
        $reason = $resp.StatusDescription

        $headers = [ordered]@{}
        $contentType = $resp.ContentType
        if ($contentType) { $headers["Content-Type"] = $contentType }
        $headers["Cache-Control"] = "no-store"
        $headers["X-Accel-Buffering"] = "no"

        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append("HTTP/1.1 $status $reason`r`n")
        foreach ($key in $headers.Keys) {
            [void]$sb.Append("$key`: $($headers[$key])`r`n")
        }
        [void]$sb.Append("Connection: close`r`n`r`n")
        $headBytes = [System.Text.Encoding]::ASCII.GetBytes($sb.ToString())
        $Stream.Write($headBytes, 0, $headBytes.Length)
        $Stream.Flush()

        $rs = $resp.GetResponseStream()
        $buffer = New-Object byte[] 8192
        while ($true) {
            $n = $rs.Read($buffer, 0, $buffer.Length)
            if ($n -le 0) { break }
            $Stream.Write($buffer, 0, $n)
            $Stream.Flush()
        }
        $rs.Close()
    } catch {
        # клиент отключился — это нормально
    } finally {
        try { $resp.Close() } catch { }
    }
}

function Handle-Connection {
    param($Client, $Config)

    $stream = $null
    try {
        $Client.ReceiveTimeout = 30000
        $Client.SendTimeout = 0
        $stream = $Client.GetStream()

        $request = Read-Request -Stream $stream
        if (-not $request) { return }

        $path = $request.Path
        if ($path -eq "/oc" -or $path.StartsWith("/oc/")) {
            Invoke-Proxy -Stream $stream -Request $request -Config $Config
        } elseif ($request.Method -eq "GET" -or $request.Method -eq "HEAD") {
            Invoke-Static -Stream $stream -Request $request -Config $Config
        } elseif ($request.Method -eq "OPTIONS") {
            Write-Response -Stream $stream -Status 204 -Reason "No Content" -Headers ([ordered]@{
                "Allow" = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
            })
        } else {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes("Method not allowed")
            Write-Response -Stream $stream -Status 405 -Reason "Method Not Allowed" -Headers ([ordered]@{
                "Content-Type" = "text/plain; charset=utf-8"; "Content-Length" = $bytes.Length
            }) -Body $bytes
        }
    } catch {
        # тихо: обрыв соединения или таймаут
    } finally {
        try { if ($stream) { $stream.Close() } } catch { }
        try { $Client.Close() } catch { }
    }
}
'@

Invoke-Expression $commonSource

# ============================================================
#   Установка агента
# ============================================================

function Install-JarvisAgent {
    param([switch]$Quiet)

    $source = Join-Path $Root "agents\jarvis.md"
    if (-not (Test-Path -LiteralPath $source)) {
        if (-not $Quiet) { Write-Host "Не найден файл agents\jarvis.md" }
        return 1
    }

    $targetDir = Join-Path $HOME ".config\opencode\agents"
    $target = Join-Path $targetDir "jarvis.md"

    if ($Quiet -and (Test-Path -LiteralPath $target)) { return 0 }

    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

    if (Test-Path -LiteralPath $target) {
        $backup = Join-Path $targetDir "jarvis.md.bak"
        Copy-Item -LiteralPath $target -Destination $backup -Force
        Write-Host "Старый агент сохранён: $backup"
    }

    Copy-Item -LiteralPath $source -Destination $target -Force
    if (-not $Quiet) {
        Write-Host "Агент установлен: $target"
        Write-Host "OpenCode подхватит его автоматически."
    }
    return 0
}

function Test-JarvisAgent {
    return (Test-Path -LiteralPath (Join-Path $HOME ".config\opencode\agents\jarvis.md"))
}

# ============================================================
#   Проверка OpenCode
# ============================================================

function Test-OpenCode {
    param([string]$Url, [string]$Pass, [int]$TimeoutMs = 3000)

    $req = $null
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url.TrimEnd('/') + "/api/info")
        $req.Method = "GET"
        $req.Timeout = $TimeoutMs
        $req.Proxy = $null
        $req.Accept = "application/json"
        if ($Pass) {
            $token = [Convert]::ToBase64String(
                [System.Text.Encoding]::UTF8.GetBytes("opencode:" + $Pass)
            )
            $req.Headers["Authorization"] = "Basic " + $token
        }

        $resp = $req.GetResponse()
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $reader.ReadToEnd()
        $reader.Close()
        $resp.Close()

        $info = $body | ConvertFrom-Json
        return @{ Ok = $true; Detail = $info }
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            $code = [int]$_.Exception.Response.StatusCode
            if ($code -eq 401) { return @{ Ok = $false; Detail = "401 — неверный пароль" } }
            return @{ Ok = $false; Detail = "HTTP $code" }
        }
        return @{ Ok = $false; Detail = $_.Exception.Message }
    } catch {
        return @{ Ok = $false; Detail = $_.Exception.Message }
    }
}

# ============================================================
#   Сеть
# ============================================================

function Get-LanAddresses {
    $addresses = @()
    try {
        $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object {
                $_.IPAddress -notlike "127.*" -and
                $_.IPAddress -notlike "169.254.*" -and
                $_.PrefixOrigin -ne "WellKnown"
            } |
            Select-Object -ExpandProperty IPAddress
    } catch {
        try {
            $addresses = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
                Where-Object { $_.AddressFamily -eq "InterNetwork" } |
                ForEach-Object { $_.ToString() } |
                Where-Object { $_ -notlike "127.*" }
        } catch { }
    }
    return @($addresses | Sort-Object -Unique)
}

# ============================================================
#   Старт
# ============================================================

if ($InstallAgent) {
    exit (Install-JarvisAgent)
}

$bindIp = if ($Lan) { [System.Net.IPAddress]::Any } else { [System.Net.IPAddress]::Loopback }

$listener = $null
$actualPort = $Port
for ($offset = 0; $offset -lt 12; $offset++) {
    try {
        $candidate = New-Object System.Net.Sockets.TcpListener($bindIp, ($Port + $offset))
        $candidate.Start()
        $listener = $candidate
        $actualPort = $Port + $offset
        break
    } catch {
        if ($offset -eq 11) {
            Write-Host "Не удалось занять порт $Port : $($_.Exception.Message)"
            exit 1
        }
    }
}

$config = @{
    Root     = $Root
    OpenCode = $OpenCode.TrimEnd('/')
    Password = $Password
}

$agentWasPresent = Test-JarvisAgent
$agentInstalled = $false
if (-not $agentWasPresent) {
    $agentInstalled = ((Install-JarvisAgent -Quiet) -eq 0) -and (Test-JarvisAgent)
}

$handlerSource = $commonSource + "`n" + 'Handle-Connection -Client $args[0] -Config $args[1]'

$pool = [runspacefactory]::CreateRunspacePool(1, 32)
$pool.Open()

$running = New-Object System.Collections.ArrayList
$localUrl = "http://localhost:$actualPort"
$check = Test-OpenCode -Url $OpenCode -Pass $Password

$line = "=" * 66
Write-Host ""
Write-Host $line
Write-Host "   J.A.R.V.I.S.  ·  интерфейс запущен"
Write-Host $line
Write-Host "   Открыть:      $localUrl"
Write-Host "   OpenCode:     $($OpenCode.TrimEnd('/'))"
if ($Password) {
    Write-Host "   Пароль:       задан"
}
if ($agentInstalled) {
    Write-Host "   Агент:        установлен jarvis.md (короткие ответы)"
} elseif (-not $agentWasPresent) {
    Write-Host "   Агент:        не удалось установить jarvis.md"
}

if ($check.Ok) {
    $version = "?"
    try { $version = $check.Detail.version } catch { }
    Write-Host "   Статус:       сервер OpenCode доступен (версия $version)"
} else {
    Write-Host "   Статус:       OpenCode недоступен — $($check.Detail)"
    Write-Host ""
    Write-Host "   Запустите сервер в другом окне:"
    Write-Host "     opencode serve --port 4096"
    Write-Host "   (в настольном приложении Jarvis.exe сервер запускается сам)"
}
Write-Host ""

if ($Lan) {
    $ips = Get-LanAddresses
    if ($ips.Count -gt 0) {
        Write-Host "   Для телефона (та же Wi-Fi сеть):"
        foreach ($ip in $ips) { Write-Host "     http://${ip}:$actualPort" }
    } else {
        Write-Host "   Локальные IP не найдены."
    }
    Write-Host ""
    Write-Host "   Внимание: интерфейс доступен другим устройствам в сети"
    Write-Host "   и даёт им доступ к вашему OpenCode."
    Write-Host ""
}

Write-Host "   Ctrl+C — остановить."
Write-Host $line
Write-Host ""

if ($OpenBrowser) {
    Start-Process $localUrl | Out-Null
}

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try { $client.Client.NoDelay = $true } catch { }

        $ps = [powershell]::Create()
        $ps.RunspacePool = $pool
        [void]$ps.AddScript($handlerSource).AddArgument($client).AddArgument($config)

        try {
            $handle = $ps.BeginInvoke()
            [void]$running.Add(@{ PS = $ps; Handle = $handle })
        } catch {
            $ps.Dispose()
            try { $client.Close() } catch { }
        }

        for ($i = $running.Count - 1; $i -ge 0; $i--) {
            if ($running[$i].Handle.IsCompleted) {
                try { [void]$running[$i].PS.EndInvoke($running[$i].Handle) } catch { }
                $running[$i].PS.Dispose()
                $running.RemoveAt($i)
            }
        }
    }
} finally {
    try { $listener.Stop() } catch { }
    foreach ($job in $running) {
        try { [void]$job.PS.EndInvoke($job.Handle) } catch { }
        try { $job.PS.Dispose() } catch { }
    }
    try { $pool.Close(); $pool.Dispose() } catch { }
    Write-Host ""
    Write-Host "Остановлено."
}
