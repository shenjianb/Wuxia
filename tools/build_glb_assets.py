from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public" / "assets"
MODEL_DIR = PUBLIC / "models"
ANIM_DIR = PUBLIC / "animations"


MODELS = [
    ("SK_BaseMale", ROOT / "SK_BaseMale.fbx"),
    ("SK_BaseFemale", ROOT / "SK_BaseFemale.fbx"),
]

ANIMATIONS = [
    ("Anim_Normal_Idle2", ROOT / "Anim_Normal_Idle2.fbx", "longest"),
    ("Anim_Normal_Walk_F", ROOT / "Anim_Normal_Walk_F.fbx", "shortest"),
]


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def ensure_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)


def import_fbx(path: Path):
    bpy.ops.import_scene.fbx(filepath=str(path))


def ensure_root_empty():
    root = bpy.data.objects.get("Root")
    if root and root.type != "EMPTY":
        root.name = "Root_Original"
        root = None
    if not root:
        root = bpy.data.objects.new("Root", None)
        root.empty_display_type = "PLAIN_AXES"
        bpy.context.collection.objects.link(root)
    root.location = (0.0, 0.0, 0.0)
    root.rotation_euler = (0.0, 0.0, 0.0)
    root.scale = (1.0, 1.0, 1.0)
    return root


def parent_keep_world(child, parent):
    world = child.matrix_world.copy()
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted()
    child.matrix_world = world


def object_world_bounds(obj):
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    mins = Vector((min(corner[i] for corner in corners) for i in range(3)))
    maxs = Vector((max(corner[i] for corner in corners) for i in range(3)))
    return mins, maxs


def character_foot_world_position(meshes, armature):
    if meshes:
        mins = []
        maxs = []
        for mesh in meshes:
            mesh_min, mesh_max = object_world_bounds(mesh)
            mins.append(mesh_min)
            maxs.append(mesh_max)
        min_x = min(value.x for value in mins)
        min_y = min(value.y for value in mins)
        min_z = min(value.z for value in mins)
        max_x = max(value.x for value in maxs)
        max_y = max(value.y for value in maxs)
        return Vector(((min_x + max_x) * 0.5, (min_y + max_y) * 0.5, min_z))

    root_bones = [bone for bone in armature.data.bones if bone.parent is None]
    if root_bones:
        pelvis_world = armature.matrix_world @ root_bones[0].head_local
        return Vector((pelvis_world.x, pelvis_world.y, 0.0))

    return Vector((0.0, 0.0, 0.0))


def ensure_ground_root_bone(armature, meshes):
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)

    foot_world = character_foot_world_position(meshes, armature)
    foot_local = armature.matrix_world.inverted() @ foot_world

    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = armature.data.edit_bones
    existing_root_bones = [bone for bone in edit_bones if bone.parent is None and bone.name != "Root"]
    pelvis = edit_bones.get("Bip001 Pelvis") or (existing_root_bones[0] if existing_root_bones else None)
    if pelvis is None:
        bpy.ops.object.mode_set(mode="OBJECT")
        raise RuntimeError("Could not find pelvis/root bone to parent under Root.")

    root_bone = edit_bones.get("Root")
    if root_bone is None:
        root_bone = edit_bones.new("Root")

    root_bone.head = foot_local
    root_bone.tail = pelvis.head.copy()
    if (root_bone.tail - root_bone.head).length < 0.001:
        root_bone.tail = root_bone.head + Vector((0.0, 0.0, 0.25))
    root_bone.roll = 0.0
    root_bone.parent = None
    root_bone.use_connect = False

    for bone in existing_root_bones:
        bone.parent = root_bone
        bone.use_connect = False

    bpy.ops.object.mode_set(mode="OBJECT")


def normalize_root_hierarchy():
    root = ensure_root_empty()
    for obj in list(bpy.context.scene.objects):
        if obj == root:
            continue
        if obj.type == "EMPTY" and obj.name.startswith("Root"):
            for child in list(obj.children):
                parent_keep_world(child, root)
            bpy.data.objects.remove(obj, do_unlink=True)

    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if not armatures:
        raise RuntimeError("No armature found.")
    armature = next((obj for obj in armatures if obj.name.startswith("Bip001")), armatures[0])
    armature.name = "Bip001"
    armature.data.name = "Bip001"
    parent_keep_world(armature, root)

    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    ensure_ground_root_bone(armature, meshes)

    for mesh in meshes:
        if mesh.parent is None:
            parent_keep_world(mesh, armature)
        for modifier in mesh.modifiers:
            if modifier.type == "ARMATURE":
                modifier.object = armature
    return root, armature


def clean_scene_extras():
    for obj in list(bpy.context.scene.objects):
        if obj.type in {"CAMERA", "LIGHT"}:
            bpy.data.objects.remove(obj, do_unlink=True)


def action_length(action):
    start, end = action.frame_range
    return end - start


def action_is_armature(action):
    return any(curve.data_path.startswith("pose.bones") or curve.data_path == "location" for curve in action.fcurves)


def choose_action(strategy):
    actions = [action for action in bpy.data.actions if action_is_armature(action)]
    if not actions:
        raise RuntimeError("No animation action found.")

    if strategy == "shortest":
        return min(actions, key=action_length)
    if strategy == "longest":
        return max(actions, key=action_length)
    raise RuntimeError(f"Unknown animation strategy: {strategy}")


def remove_other_actions(keep_action):
    for action in list(bpy.data.actions):
        if action != keep_action:
            bpy.data.actions.remove(action)


def keep_only_bone_tracks(action):
    for curve in list(action.fcurves):
        if not curve.data_path.startswith("pose.bones"):
            action.fcurves.remove(curve)


def clear_root_animation(root):
    if root.animation_data:
        root.animation_data_clear()


def export_gltf(path: Path, animations=True):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_animations=animations,
        export_nla_strips=False,
        export_force_sampling=True,
        export_frame_range=True,
        export_yup=True,
    )


def build_model(name, source):
    reset_scene()
    import_fbx(source)
    normalize_root_hierarchy()
    clean_scene_extras()
    output = MODEL_DIR / f"{name}.glb"
    export_gltf(output, animations=False)
    print(f"model: {output}")


def build_animation(name, source, strategy):
    reset_scene()
    import_fbx(source)
    root, armature = normalize_root_hierarchy()
    clean_scene_extras()
    action = choose_action(strategy)
    action.name = name
    keep_only_bone_tracks(action)
    remove_other_actions(action)
    armature.animation_data_create()
    armature.animation_data.action = action
    clear_root_animation(root)
    bpy.context.scene.frame_start = int(action.frame_range[0])
    bpy.context.scene.frame_end = int(action.frame_range[1])
    output = ANIM_DIR / f"{name}.glb"
    export_gltf(output, animations=True)
    print(f"animation: {output} frames={list(action.frame_range)}")


def main():
    ensure_dir(MODEL_DIR)
    ensure_dir(ANIM_DIR)
    for name, source in MODELS:
        build_model(name, source)
    for name, source, strategy in ANIMATIONS:
        build_animation(name, source, strategy)


if __name__ == "__main__":
    main()
