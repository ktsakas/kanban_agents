$ErrorActionPreference = 'Stop'
$ffmpeg = 'C:\Users\kosta\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.1-full_build\bin\ffmpeg.exe'
$frames = Join-Path $PSScriptRoot 'frames'
$output = Join-Path $PSScriptRoot 'kanban-agents-demo.mp4'

$inputs = @()
1..8 | ForEach-Object {
  $name = ('{0:D2}-' -f $_)
  $file = Get-ChildItem $frames -Filter "$name*.png" | Select-Object -First 1
  if (-not $file) { throw "Missing frame $name" }
  $inputs += @('-i', $file.FullName)
}

$filter = @"
[0:v]scale=1920:1080,zoompan=z='min(zoom+0.00035,1.035)':d=100:s=1920x1080:fps=25,setsar=1[v0];
[1:v]scale=1920:1080,zoompan=z='min(zoom+0.00035,1.035)':d=100:s=1920x1080:fps=25,setsar=1[v1];
[2:v]scale=1920:1080,zoompan=z='min(zoom+0.00035,1.035)':d=100:s=1920x1080:fps=25,setsar=1[v2];
[3:v]scale=1920:1080,zoompan=z='min(zoom+0.00035,1.035)':d=100:s=1920x1080:fps=25,setsar=1[v3];
[4:v]scale=1920:1080,zoompan=z='min(zoom+0.00035,1.035)':d=100:s=1920x1080:fps=25,setsar=1[v4];
[5:v]scale=1920:1080,zoompan=z='min(zoom+0.00035,1.035)':d=100:s=1920x1080:fps=25,setsar=1[v5];
[6:v]scale=1920:1080,zoompan=z='min(zoom+0.00035,1.035)':d=100:s=1920x1080:fps=25,setsar=1[v6];
[7:v]scale=1920:1080,zoompan=z='min(zoom+0.00035,1.035)':d=100:s=1920x1080:fps=25,setsar=1[v7];
[v0][v1]xfade=transition=fade:duration=0.55:offset=3.45[x1];
[x1][v2]xfade=transition=fade:duration=0.55:offset=6.90[x2];
[x2][v3]xfade=transition=fade:duration=0.55:offset=10.35[x3];
[x3][v4]xfade=transition=fade:duration=0.55:offset=13.80[x4];
[x4][v5]xfade=transition=fade:duration=0.55:offset=17.25[x5];
[x5][v6]xfade=transition=fade:duration=0.55:offset=20.70[x6];
[x6][v7]xfade=transition=fade:duration=0.55:offset=24.15,fade=t=out:st=27.2:d=0.8,format=yuv420p[outv]
"@ -replace "`r?`n", ''

& $ffmpeg @inputs -filter_complex $filter -map '[outv]' -t 28 -an -c:v libx264 -preset medium -crf 18 -movflags +faststart -y $output
if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed with exit code $LASTEXITCODE" }
Get-Item $output | Select-Object FullName, Length
