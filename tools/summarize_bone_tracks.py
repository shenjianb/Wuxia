import json
import sys
from pathlib import Path

import bpy


TARGETS = {
    'pose.bones["Root"].location',
    'pose.bones["Bip001 Pelvis"].location',
    'pose.bones["Bip001 L Foot"].location',
    'pose.bones["Bip001 R Foot"].location',
}


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def inspect(path):
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(path))
    result = {"file": str(path), "tracks": []}
    for action in bpy.data.actions:
        for curve in action.fcurves:
            if curve.data_path in TARGETS:
                values = [point.co.y for point in curve.keyframe_points]
                result["tracks"].append(
                    {
                        "action": action.name,
                        "path": curve.data_path,
                        "axis": curve.array_index,
                        "min": min(values),
                        "max": max(values),
                        "delta": max(values) - min(values),
                        "first": values[0],
                        "last": values[-1],
                    }
                )
    return result


def main():
    files = [Path(arg) for arg in sys.argv[sys.argv.index("--") + 1 :]]
    print(json.dumps([inspect(path) for path in files], indent=2))


if __name__ == "__main__":
    main()
