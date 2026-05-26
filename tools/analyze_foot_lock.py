import json
import sys
from pathlib import Path

import bpy


CONTACT_BONES = ["Bip001 L Toe0", "Bip001 R Toe0", "Bip001 L Foot", "Bip001 R Foot"]


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
    return max(bpy.data.actions, key=lambda action: action.frame_range[1] - action.frame_range[0])


def analyze(path):
    reset_scene()
    load_file(path)
    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    action = choose_action()
    armature.animation_data_create()
    armature.animation_data.action = action

    start, end = int(action.frame_range[0]), int(action.frame_range[1])
    result = {"file": str(path), "action": action.name, "frame_range": [start, end], "bones": {}}
    for bone_name in CONTACT_BONES:
        positions = []
        for frame in range(start, end + 1):
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            bone = armature.pose.bones.get(bone_name)
            if not bone:
                continue
            pos = (armature.matrix_world @ bone.matrix).translation
            positions.append((frame, pos.x, pos.y, pos.z))
        if not positions:
            continue
        min_z = min(p[3] for p in positions)
        threshold = min_z + 0.015
        contacts = [p for p in positions if p[3] <= threshold]
        if contacts:
            result["bones"][bone_name] = {
                "min_z": min_z,
                "contact_count": len(contacts),
                "contact_x_span": max(p[1] for p in contacts) - min(p[1] for p in contacts),
                "contact_y_span": max(p[2] for p in contacts) - min(p[2] for p in contacts),
                "contact_z_span": max(p[3] for p in contacts) - min(p[3] for p in contacts),
                "all_x_span": max(p[1] for p in positions) - min(p[1] for p in positions),
                "all_y_span": max(p[2] for p in positions) - min(p[2] for p in positions),
                "all_z_span": max(p[3] for p in positions) - min(p[3] for p in positions),
            }
    return result


def main():
    files = [Path(arg) for arg in sys.argv[sys.argv.index("--") + 1 :]]
    print(json.dumps([analyze(path) for path in files], indent=2))


if __name__ == "__main__":
    main()
