import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def world_bounds(obj):
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    mins = [min(corner[i] for corner in corners) for i in range(3)]
    maxs = [max(corner[i] for corner in corners) for i in range(3)]
    return {"min": mins, "max": maxs}


def inspect(path):
    reset_scene()
    if path.suffix.lower() in {".glb", ".gltf"}:
        bpy.ops.import_scene.gltf(filepath=str(path))
    else:
        bpy.ops.import_scene.fbx(filepath=str(path))

    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    mesh_bounds = [world_bounds(mesh) for mesh in meshes]

    bones = []
    for bone in armature.data.bones:
        if bone.parent is None or bone.name in {"Root", "Bip001 Pelvis"}:
            bones.append(
                {
                    "name": bone.name,
                    "parent": bone.parent.name if bone.parent else None,
                    "head_local": list(bone.head_local),
                    "tail_local": list(bone.tail_local),
                    "head_world": list(armature.matrix_world @ bone.head_local),
                    "tail_world": list(armature.matrix_world @ bone.tail_local),
                }
            )

    return {
        "file": str(path),
        "armature": armature.name,
        "armature_world": [list(row) for row in armature.matrix_world],
        "mesh_bounds": mesh_bounds,
        "root_bones": [bone.name for bone in armature.data.bones if bone.parent is None],
        "bones": bones,
    }


def main():
    files = [Path(arg) for arg in sys.argv[sys.argv.index("--") + 1 :]]
    print(json.dumps([inspect(path) for path in files], indent=2))


if __name__ == "__main__":
    main()
