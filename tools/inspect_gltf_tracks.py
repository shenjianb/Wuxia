import json
import sys
from pathlib import Path

import bpy


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def inspect(path):
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(path))
    actions = []
    for action in bpy.data.actions:
        tracks = []
        for curve in action.fcurves:
            tracks.append(
                {
                    "data_path": curve.data_path,
                    "array_index": curve.array_index,
                    "frames": [point.co.x for point in curve.keyframe_points[:5]],
                    "values": [point.co.y for point in curve.keyframe_points[:5]],
                    "range": list(curve.range()),
                }
            )
        actions.append({"name": action.name, "frame_range": list(action.frame_range), "tracks": tracks})
    return {"file": str(path), "actions": actions}


def main():
    files = [Path(arg) for arg in sys.argv[sys.argv.index("--") + 1 :]]
    print(json.dumps([inspect(path) for path in files], indent=2))


if __name__ == "__main__":
    main()
