import json
import sys
from pathlib import Path

import bpy


FOOT_BONES = [
    "Bip001 L Foot",
    "Bip001 R Foot",
    "Bip001 L Toe0",
    "Bip001 R Toe0",
]


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)


def load_file(path):
    if path.suffix.lower() in {".glb", ".gltf"}:
        bpy.ops.import_scene.gltf(filepath=str(path))
    else:
        bpy.ops.import_scene.fbx(filepath=str(path))


def choose_action():
    if not bpy.data.actions:
        return None
    return max(bpy.data.actions, key=lambda action: action.frame_range[1] - action.frame_range[0])


def sample(path):
    reset_scene()
    load_file(path)
    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    action = choose_action()
    if action:
        armature.animation_data_create()
        armature.animation_data.action = action

    start, end = action.frame_range if action else (1, 1)
    frames = [int(start), int((start + end) * 0.25), int((start + end) * 0.5), int((start + end) * 0.75), int(end)]
    samples = {bone_name: [] for bone_name in FOOT_BONES}

    for frame in frames:
        bpy.context.scene.frame_set(frame)
        bpy.context.view_layer.update()
        for bone_name in FOOT_BONES:
            pose_bone = armature.pose.bones.get(bone_name)
            if not pose_bone:
                continue
            matrix = armature.matrix_world @ pose_bone.matrix
            head = matrix.translation
            samples[bone_name].append({"frame": frame, "world": list(head)})

    spans = {}
    for bone_name, values in samples.items():
        if not values:
            continue
        coords = [value["world"] for value in values]
        spans[bone_name] = {
            "x": max(coord[0] for coord in coords) - min(coord[0] for coord in coords),
            "y": max(coord[1] for coord in coords) - min(coord[1] for coord in coords),
            "z": max(coord[2] for coord in coords) - min(coord[2] for coord in coords),
        }

    return {
        "file": str(path),
        "action": action.name if action else None,
        "frame_range": list(action.frame_range) if action else None,
        "root_bones": [bone.name for bone in armature.data.bones if bone.parent is None],
        "parents": {
            bone.name: bone.parent.name if bone.parent else None
            for bone in armature.data.bones
            if bone.name in {"Root", "Bip001 Pelvis"}
        },
        "samples": samples,
        "spans": spans,
    }


def main():
    files = [Path(arg) for arg in sys.argv[sys.argv.index("--") + 1 :]]
    print(json.dumps([sample(path) for path in files], indent=2))


if __name__ == "__main__":
    main()
