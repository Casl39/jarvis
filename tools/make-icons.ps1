# J.A.R.V.I.S. — PNG icon generator (Windows PowerShell 5.1, System.Drawing).
# Usage: powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
# Produces icons/icon-192.png, icons/icon-512.png, icons/icon-maskable-512.png

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "icons"
New-Item -ItemType Directory -Force -Path $out | Out-Null

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function New-Ring([single]$cx, [single]$cy, [single]$r, [single]$width, $color, $dash) {
    $pen = New-Object System.Drawing.Pen($color, $width)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    if ($dash) {
        $pen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Custom
        $pen.DashPattern = $dash
    }
    return $pen
}

function New-RadialBrush([single]$cx, [single]$cy, [single]$r, [System.Drawing.Color[]]$colors, [single[]]$positions) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse($cx - $r, $cy - $r, $r * 2, $r * 2)
    $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush($path)
    $brush.CenterPoint = New-Object System.Drawing.PointF($cx, $cy)
    $blend = New-Object System.Drawing.Drawing2D.ColorBlend($colors.Length)
    $blend.Colors = $colors
    $blend.Positions = $positions
    $brush.InterpolationColors = $blend
    return @{ Brush = $brush; Path = $path }
}

function Render-Icon([int]$size, [bool]$maskable, [string]$file) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = $size / 512.0
    $cx = $size / 2.0
    $cy = $size / 2.0

    # Background
    if ($maskable) {
        $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
        $bgPath.AddRectangle((New-Object System.Drawing.RectangleF(0, 0, $size, $size)))
    } else {
        $bgPath = New-RoundedPath 0 0 $size $size (112 * $s)
    }
    $bgBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($bgPath)
    $bgBrush.CenterPoint = New-Object System.Drawing.PointF($cx, ($size * 0.40))
    $bgBlend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
    $bgBlend.Colors = @(
        [System.Drawing.Color]::FromArgb(255, 11, 38, 52),
        [System.Drawing.Color]::FromArgb(255, 6, 17, 25),
        [System.Drawing.Color]::FromArgb(255, 3, 6, 11)
    )
    $bgBlend.Positions = @(0.0, 0.55, 1.0)
    $bgBrush.InterpolationColors = $bgBlend
    $g.FillPath($bgBrush, $bgPath)

    # Outer thin ring
    $pen = New-Ring $cx $cy (150 * $s) (3 * $s) ([System.Drawing.Color]::FromArgb(71, 53, 230, 255)) $null
    $g.DrawEllipse($pen, ($cx - 150 * $s), ($cy - 150 * $s), (300 * $s), (300 * $s))
    $pen.Dispose()

    # Dashed cyan ring
    $pen = New-Ring $cx $cy (120 * $s) (11 * $s) ([System.Drawing.Color]::FromArgb(128, 53, 230, 255)) @(0.32, 0.68)
    $g.DrawEllipse($pen, ($cx - 120 * $s), ($cy - 120 * $s), (240 * $s), (240 * $s))
    $pen.Dispose()

    # Gold ticks
    $pen = New-Ring $cx $cy (98 * $s) (2 * $s) ([System.Drawing.Color]::FromArgb(90, 255, 181, 69)) @(0.08, 0.92)
    $g.DrawEllipse($pen, ($cx - 98 * $s), ($cy - 98 * $s), (196 * $s), (196 * $s))
    $pen.Dispose()

    # Glow
    $glow = New-RadialBrush $cx $cy (150 * $s) @(
        [System.Drawing.Color]::FromArgb(92, 53, 230, 255),
        [System.Drawing.Color]::FromArgb(0, 53, 230, 255)
    ) @(0.0, 1.0)
    $g.FillPath($glow.Brush, $glow.Path)

    # Orb
    $orb = New-RadialBrush $cx ($cy - (6 * $s)) (78 * $s) @(
        [System.Drawing.Color]::FromArgb(255, 244, 254, 255),
        [System.Drawing.Color]::FromArgb(255, 169, 246, 255),
        [System.Drawing.Color]::FromArgb(255, 69, 216, 242),
        [System.Drawing.Color]::FromArgb(255, 20, 135, 166),
        [System.Drawing.Color]::FromArgb(255, 8, 54, 69),
        [System.Drawing.Color]::FromArgb(255, 6, 34, 45)
    ) @(0.0, 0.22, 0.48, 0.72, 0.90, 1.0)
    $g.FillPath($orb.Brush, $orb.Path)

    # Core
    $soft = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(217, 234, 255, 255))
    $g.FillEllipse($soft, ($cx - 42 * $s), ($cy - 42 * $s), (84 * $s), (84 * $s))
    $soft.Dispose()
    $hot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(242, 255, 255, 255))
    $g.FillEllipse($hot, ($cx - 22 * $s), ($cy - 22 * $s), (44 * $s), (44 * $s))
    $hot.Dispose()

    # Cardinal ticks
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(153, 53, 230, 255), (3 * $s))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($pen, $cx, (34 * $s), $cx, (60 * $s))
    $g.DrawLine($pen, $cx, ($size - 60 * $s), $cx, ($size - 34 * $s))
    $g.DrawLine($pen, (34 * $s), $cy, (60 * $s), $cy)
    $g.DrawLine($pen, ($size - 60 * $s), $cy, ($size - 34 * $s), $cy)
    $pen.Dispose()

    $g.Dispose()
    $target = Join-Path $out $file
    $bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    $info = Get-Item $target
    Write-Host ("  {0,-24} {1}x{1}  {2:N1} KB" -f $info.Name, $size, ($info.Length / 1KB))
}

Write-Host "Rendering J.A.R.V.I.S. icons..."
Render-Icon 512 $false "icon-512.png"
Render-Icon 192 $false "icon-192.png"
Render-Icon 512 $true  "icon-maskable-512.png"
Write-Host "Done."
