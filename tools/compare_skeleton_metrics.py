import json
import sys
from pathlib import Path

import bpy


TARGET_BONES = [
    "Bip001 Pelvis",
    "Bip001 Spine",
    "Bip001 Spine1",
    "Bip001 Spine2",
    "Bip001 Neck",
    "Bip001 L Clavicle",
    "Bip001 L UpperArm",
    "Bip001 L Forearm",
    "Bip001 L Hand",
    "Bip001 R Clavicle",
    "Bip001 R UpperArm",
    "Bip001 R Forearm",
    "Bip001 R Hand",
    "Bip001 L Thigh",
    "Bip001 L Calf",
    "Bip001 L Foot",
    "Bip001 R Thigh",
    "Bip001 R Calf",
    "Bip001 R Foot",
]


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)


def load_file(path):
    bpy.ops.import_scene.fbx(filepath=str(path))


def inspect(path):
    reset_scene()
    load_file(path)
    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    bones = {}
    for bone_name in TARGET_BONES:
        bone = armature.data.bones.get(bone_name)
        if not bone:
            continue
        head = armature.matrix_world @ bone.head_local
        tail = armature.matrix_world @ bone.tail_local
        bones[bone_name] = {
            "parent": bone.parent.name if bone.parent else None,
            "length": bone.length,
            "world_head": [head.x, head.y, head.z],
            "world_tail": [tail.x, tail.y, tail.z],
            "world_vector": [tail.x - head.x, tail.y - head.y, tail.z - head.z],
        }
    return {
        "file": str(path),
        "armature": armature.name,
        "bones": bones,
    }


def main():
    files = [Path(arg) for arg in sys.argv[sys.argv.index("--") + 1 :]]
    data = [inspect(path) for path in files]
    print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
