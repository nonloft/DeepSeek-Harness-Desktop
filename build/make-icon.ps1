# Composes build/icon.png: the DeepSeek Harness whale (build/whale-blue.png,
# recoloured to #6272FD, transparent background) centred on a transparent
# canvas, with a large grey plate in the bottom-right carrying the white
# caption "harness" (big enough to stay legible at 32–48 px).
#
# Run: powershell -ExecutionPolicy Bypass -File build\make-icon.ps1
Add-Type -AssemblyName System.Drawing

$size = 1024
$whale = [System.Drawing.Image]::FromFile((Join-Path $PSScriptRoot 'whale-blue.png'))
$bw = $whale.Width
$bh = $whale.Height

$bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# whale, centred both ways
$maxW = 700
$maxH = 500
$scale = [Math]::Min($maxW / $bw, $maxH / $bh)
$dw = [int]($bw * $scale)
$dh = [int]($bh * $scale)
$dx = [int](($size - $dw) / 2)
$dy = [int](($size - $dh) / 2)
$g.DrawImage($whale, (New-Object System.Drawing.Rectangle $dx, $dy, $dw, $dh))

# big grey plate behind the caption, anchored bottom-right
$pw = 720
$ph = 215
$rad = 107
$bx = $size - $pw - 24
$by = $size - $ph - 22
$dd = $rad * 2
$plate = New-Object System.Drawing.Drawing2D.GraphicsPath
$plate.AddArc($bx, $by, $dd, $dd, 180, 90)
$plate.AddArc(($bx + $pw - $dd), $by, $dd, $dd, 270, 90)
$plate.AddArc(($bx + $pw - $dd), ($by + $ph - $dd), $dd, $dd, 0, 90)
$plate.AddArc($bx, ($by + $ph - $dd), $dd, $dd, 90, 90)
$plate.CloseFigure()
$plateBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.RectangleF $bx, $by, $pw, $ph),
  [System.Drawing.Color]::FromArgb(255, 86, 96, 110),
  [System.Drawing.Color]::FromArgb(255, 54, 62, 73),
  90.0
)
$g.FillPath($plateBrush, $plate)

# caption, as large as the plate allows
$fs = 170
while ($fs -gt 60) {
  $font = New-Object System.Drawing.Font("Segoe UI", $fs, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  if ($g.MeasureString('harness', $font).Width -le ($pw - 70)) { break }
  $font.Dispose()
  $fs -= 4
}
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$txtRect = New-Object System.Drawing.RectangleF($bx, $by, $pw, $ph)
$g.DrawString('harness', $font, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), $txtRect, $sf)

$out = Join-Path $PSScriptRoot 'icon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$whale.Dispose()
Write-Output "wrote $out"
