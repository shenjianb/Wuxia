$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$blender = "D:\Program Files\Blender Foundation\Blender 4.1\blender.exe"
$script = Join-Path $root "tools\build_glb_assets.py"

& $blender --background --python $script
