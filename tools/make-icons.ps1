# 生成扩展图标（16/32/48/128）以及一张用于目视检查的预览图。
# 用法：pwsh -NoProfile -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root 'icons'
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = [single]($r * 2)
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
    $path.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
    $path.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-IconBitmap([int]$size) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $s = [single]($size / 128.0)

    $bgPath = New-RoundedPath 0 0 $size $size ([single]($size * 0.235))
    $bgRect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $bgRect,
        [System.Drawing.Color]::FromArgb(255, 88, 148, 250),
        [System.Drawing.Color]::FromArgb(255, 22, 106, 228),
        [single]90
    )
    $graphics.FillPath($bgBrush, $bgPath)

    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)

    $lid = New-RoundedPath ([single](26 * $s)) ([single](30 * $s)) ([single](76 * $s)) ([single](15 * $s)) ([single](4 * $s))
    $graphics.FillPath($white, $lid)

    $body = New-RoundedPath ([single](31 * $s)) ([single](49 * $s)) ([single](66 * $s)) ([single](52 * $s)) ([single](7 * $s))
    $graphics.FillPath($white, $body)

    $slotColor = [System.Drawing.Color]::FromArgb(255, 40, 122, 240)
    $slotBrush = New-Object System.Drawing.SolidBrush($slotColor)
    $slot = New-RoundedPath ([single](50 * $s)) ([single](67 * $s)) ([single](28 * $s)) ([single](8 * $s)) ([single](4 * $s))
    $graphics.FillPath($slotBrush, $slot)

    $graphics.Dispose()
    $bgPath.Dispose(); $lid.Dispose(); $body.Dispose(); $slot.Dispose()
    $bgBrush.Dispose(); $white.Dispose(); $slotBrush.Dispose()
    return $bitmap
}

foreach ($size in 16, 32, 48, 128) {
    $bitmap = New-IconBitmap $size
    $target = Join-Path $iconDir ("icon{0}.png" -f $size)
    $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "wrote $target"
    $bitmap.Dispose()
}

# 预览图：白底/深色底上分别放 16、32、48、128 的实际尺寸
$preview = New-Object System.Drawing.Bitmap(360, 200, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$pg = [System.Drawing.Graphics]::FromImage($preview)
$pg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$pg.Clear([System.Drawing.Color]::White)
$light = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 245, 246, 248))
$pg.FillRectangle($light, 0, 0, 180, 200)
$dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 32, 33, 36))
$pg.FillRectangle($dark, 180, 0, 180, 200)

$x = 16
foreach ($size in 16, 32, 48) {
    $icon = New-IconBitmap $size
    $pg.DrawImage($icon, $x, 20, $size, $size)
    $x += $size + 14
    $icon.Dispose()
}
$big = New-IconBitmap 128
$pg.DrawImage($big, 196, 36, 128, 128)
$big.Dispose()
$pg.Dispose()

$previewPath = Join-Path $root 'tools\icon-preview.png'
$preview.Save($previewPath, [System.Drawing.Imaging.ImageFormat]::Png)
$preview.Dispose()
Write-Host "wrote $previewPath"
