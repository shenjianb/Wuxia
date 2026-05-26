import json
import sys
from pathlib import Path

import bpy


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def object_path(obj):
    names = []
    current = obj
    while current:
        names.append(current.name)
        current = current.parent
    return list(reversed(names))


def inspect(path: Path):
    reset_scene()
    if path.suffix.lower() in {".glb", ".gltf"}:
        bpy.ops.import_scene.gltf(filepath=str(path))
    else:
        bpy.ops.import_scene.fbx(filepath=str(path))
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    actions = []
    for action in bpy.data.actions:
        paths = sorted({curve.data_path for curve in action.fcurves})
        actions.append({"name": action.name, "frame_range": list(action.frame_range), "channels": paths[:20]})

    return {
        "file": str(path),
        "objects": [
            {
                "name": obj.name,
                "type": obj.type,
                "parent": obj.parent.name if obj.parent else None,
                "path": object_path(obj),
            }
            for obj in bpy.context.scene.objects
        ],
        "armatures": [
            {
                "name": arm.name,
                "root_bones": [bone.name for bone in arm.data.bones if bone.parent is None],
                "bones": [
                    {"name": bone.name, "parent": bone.parent.name if bone.parent else None}
                    for bone in arm.data.bones
                ][:40],
            }
            for arm in armatures
        ],
        "actions": actions,
    }


def main():
    files = [Path(arg) for arg in sys.argv[sys.argv.index("--") + 1 :]]
    print(json.dumps([inspect(path) for path in files], indent=2))


if __name__ == "__main__":
    main()
