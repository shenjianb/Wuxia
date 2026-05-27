from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector


ROOT = Path(__file__).resolve().parents[1]
FBX_DIR = ROOT / "FBX"
PUBLIC = ROOT / "public" / "assets"
MODEL_DIR = PUBLIC / "models"
ANIM_DIR = PUBLIC / "animations"


MODELS = [
    ("SK_BaseMale", FBX_DIR / "SK_BaseMan_merged.fbx"),
    ("SK_BaseFemale", FBX_DIR / "SK_BaseFemale_merged.fbx"),
]

ANIMATIONS = [
    ("Anim_Normal_Idle2", FBX_DIR / "Anim_Normal_Idle2.fbx", "longest", "none"),
    ("Anim_Normal_Walk_F", FBX_DIR / "Anim_Normal_Walk_F_0.fbx", "shortest", "none"),
    ("Anim_Normal_Idle_Turn_L", FBX_DIR / "Anim_Normal_Idle_Turn_L_In.fbx", "shortest", "none"),
    ("Anim_Normal_Idle_Turn_R", FBX_DIR / "Anim_Normal_Idle_Turn_R_In.fbx", "shortest", "none"),
    ("Anim_Combat_Idle_Hand", FBX_DIR / "Anim_Combat_Idle_Hand.fbx", "longest", "none"),
    ("Anim_Combat_Walk_Short_F_Hand", FBX_DIR / "Anim_Combat_Walk_Short_F_Hand.fbx", "shortest", "none"),
    ("Anim_Combat_Idle_Turn_L_Hand", FBX_DIR / "Anim_Combat_Idle_Turn_L_Hand_In.fbx", "shortest", "none"),
    ("Anim_Combat_Idle_Turn_R_Hand", FBX_DIR / "Anim_Combat_Idle_Turn_R_Hand_In.fbx", "shortest", "none"),
    ("Anim_Combat_Att_F_Hand_0", FBX_DIR / "Anim_Combat_Att_F_Hand_0_In.fbx", "shortest", "none"),
    ("Anim_Combat_Att_F_Hand_1", FBX_DIR / "Anim_Combat_Att_F_Hand_1_In.fbx", "shortest", "none"),
    ("Anim_Combat_Att_RB_Hand_0", FBX_DIR / "Anim_Combat_Att_RB_Hand_0_In.fbx", "shortest", "none"),
    ("Anim_Combat_Att_LB_Hand_0", FBX_DIR / "Anim_Combat_Att_LB_Hand_0_In.fbx", "shortest", "none"),
]

RETARGET_MODEL = FBX_DIR / "SK_BaseMan_merged.fbx"


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)


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


def normalize_root_hierarchy(add_ground_root=True):
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
    if add_ground_root:
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
    return any(curve.data_path.startswith("pose.bones") for curve in action.fcurves)


def action_is_object_transform(action):
    return any(curve.data_path in {"location", "rotation_euler", "rotation_quaternion", "scale"} for curve in action.fcurves)


def choose_action(strategy, actions=None):
    source_actions = actions if actions is not None else bpy.data.actions
    actions = [action for action in source_actions if action_is_armature(action)]
    if not actions:
        raise RuntimeError("No animation action found.")

    if strategy == "shortest":
        return min(actions, key=action_length)
    if strategy == "longest":
        return max(actions, key=action_length)
    raise RuntimeError(f"Unknown animation strategy: {strategy}")


def choose_root_action(strategy, actions=None):
    source_actions = actions if actions is not None else bpy.data.actions
    actions = [action for action in source_actions if action_is_object_transform(action) and not action_is_armature(action)]
    if not actions:
        return None

    if strategy == "shortest":
        return min(actions, key=action_length)
    if strategy == "longest":
        return max(actions, key=action_length)
    raise RuntimeError(f"Unknown animation strategy: {strategy}")


def remove_other_actions(*keep_actions):
    keep = set(action for action in keep_actions if action)
    for action in list(bpy.data.actions):
        if action not in keep:
            bpy.data.actions.remove(action)


def keep_only_bone_tracks(action):
    for curve in list(action.fcurves):
        if not curve.data_path.startswith("pose.bones"):
            action.fcurves.remove(curve)


def remove_bone_location_tracks(action, bone_name):
    data_path = f'pose.bones["{bone_name}"].location'
    for curve in list(action.fcurves):
        if curve.data_path == data_path:
            action.fcurves.remove(curve)


def lock_location_track(action, bone_name, axes=(0, 1, 2)):
    data_path = f'pose.bones["{bone_name}"].location'
    for curve in action.fcurves:
        if curve.data_path == data_path and curve.array_index in axes and curve.keyframe_points:
            first_value = curve.keyframe_points[0].co.y
            for point in curve.keyframe_points:
                point.co.y = first_value
                point.handle_left.y = first_value
                point.handle_right.y = first_value
            curve.update()


def remove_child_location_and_scale_tracks(action):
    keep_location_bones = {"Root", "Bip001 Pelvis"}
    for curve in list(action.fcurves):
        if ".scale" in curve.data_path:
            action.fcurves.remove(curve)
            continue
        if not curve.data_path.endswith(".location"):
            continue
        keep = any(curve.data_path == f'pose.bones["{bone_name}"].location' for bone_name in keep_location_bones)
        if not keep:
            action.fcurves.remove(curve)


def stabilize_action(action, mode):
    if mode == "lock_pelvis_xyz":
        lock_location_track(action, "Bip001 Pelvis", axes=(0, 1, 2))
        return
    if mode == "strip_pelvis_location":
        remove_bone_location_tracks(action, "Bip001 Pelvis")
        return
    if mode == "none":
        return
    raise RuntimeError(f"Unknown stabilization mode: {mode}")


def set_identity_pose(pose_bone):
    pose_bone.location = (0.0, 0.0, 0.0)
    pose_bone.rotation_mode = "QUATERNION"
    pose_bone.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
    pose_bone.scale = (1.0, 1.0, 1.0)


def bake_source_action_to_target(source_armature, source_action, target_armature, name):
    target_armature.animation_data_create()
    target_action = bpy.data.actions.new(name)
    target_armature.animation_data.action = target_action

    source_armature.animation_data_create()
    source_armature.animation_data.action = source_action

    start = int(source_action.frame_range[0])
    end = int(source_action.frame_range[1])

    for pose_bone in target_armature.pose.bones:
        pose_bone.rotation_mode = "QUATERNION"

    # Force Blender to evaluate the newly assigned FBX action before sampling frame_start.
    bpy.context.scene.frame_set(min(start + 1, end))
    bpy.context.view_layer.update()
    bpy.context.scene.frame_set(start)
    bpy.context.view_layer.update()

    for frame in range(start, end + 1):
        bpy.context.scene.frame_set(frame)
        bpy.context.view_layer.update()

        for target_bone in target_armature.pose.bones:
            target_bone.rotation_mode = "QUATERNION"

            if target_bone.name == "Root":
                set_identity_pose(target_bone)
            else:
                source_bone = source_armature.pose.bones.get(target_bone.name)
                if source_bone is None:
                    continue
                source_world = source_armature.matrix_world @ source_bone.matrix
                target_bone.matrix = target_armature.matrix_world.inverted() @ source_world

            target_bone.keyframe_insert(data_path="location", frame=frame)
            target_bone.keyframe_insert(data_path="rotation_quaternion", frame=frame)
            target_bone.keyframe_insert(data_path="scale", frame=frame)

    # FBX imports can occasionally evaluate the first frame dirty after action assignment.
    # For looping Mixamo clips, preserve loop closure by copying the last keyed value to start.
    for curve in target_action.fcurves:
        start_key = next((point for point in curve.keyframe_points if abs(point.co.x - start) < 0.001), None)
        end_key = next((point for point in curve.keyframe_points if abs(point.co.x - end) < 0.001), None)
        if start_key and end_key:
            start_key.co.y = end_key.co.y
            start_key.handle_left.y = end_key.co.y
            start_key.handle_right.y = end_key.co.y
            curve.update()

    bpy.context.scene.frame_start = start
    bpy.context.scene.frame_end = end
    return target_action


def clear_root_animation(root):
    if root.animation_data:
        root.animation_data_clear()


def matching_bone_name(source_bone, target_armature):
    if source_bone in target_armature.pose.bones:
        return source_bone
    if source_bone.endswith(".001") and source_bone[:-4] in target_armature.pose.bones:
        return source_bone[:-4]
    return None


def bake_action_to_target_rest(source_armature, source_action, target_armature, name):
    source_armature.animation_data_create()
    source_armature.animation_data.action = source_action

    target_armature.animation_data_create()
    target_action = bpy.data.actions.new(name)
    target_armature.animation_data.action = target_action

    start = int(source_action.frame_range[0])
    end = int(source_action.frame_range[1])

    for pose_bone in target_armature.pose.bones:
        pose_bone.rotation_mode = "QUATERNION"

    for frame in range(start, end + 1):
        bpy.context.scene.frame_set(frame)
        bpy.context.view_layer.update()

        for source_pose_bone in source_armature.pose.bones:
            target_name = matching_bone_name(source_pose_bone.name, target_armature)
            if not target_name:
                continue

            target_pose_bone = target_armature.pose.bones[target_name]
            source_rest = source_armature.data.bones[source_pose_bone.name].matrix_local
            target_rest = target_armature.data.bones[target_name].matrix_local
            pose_delta = source_rest.inverted() @ source_pose_bone.matrix

            target_pose_bone.matrix = target_rest @ pose_delta
            target_pose_bone.location = (0.0, 0.0, 0.0)
            target_pose_bone.scale = (1.0, 1.0, 1.0)
            target_pose_bone.rotation_mode = "QUATERNION"
            target_pose_bone.keyframe_insert(data_path="rotation_quaternion", frame=frame)

    bpy.context.scene.frame_start = start
    bpy.context.scene.frame_end = end
    return target_action


def export_gltf(path: Path, animations=True, nla_strips=False):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_animations=animations,
        export_nla_strips=nla_strips,
        export_force_sampling=True,
        export_frame_range=True,
        export_yup=True,
    )


def add_nla_action(obj, action, track_name):
    if not action:
        return
    obj.animation_data_create()
    track = obj.animation_data.nla_tracks.new()
    track.name = track_name
    start = int(action.frame_range[0])
    strip = track.strips.new(track_name, start, action)
    strip.name = track_name
    obj.animation_data.action = None


def embed_animation(root, armature, name, source, strategy, stabilization):
    imported_actions = set(bpy.data.actions)
    imported_objects = set(bpy.context.scene.objects)
    import_fbx(source)
    source_objects = [obj for obj in bpy.context.scene.objects if obj not in imported_objects]
    source_actions = [action for action in bpy.data.actions if action not in imported_actions]

    action = choose_action(strategy, source_actions).copy()
    action.name = name
    keep_only_bone_tracks(action)
    stabilize_action(action, stabilization)

    root_action = choose_root_action(strategy, source_actions)
    if root_action:
        root_action = root_action.copy()
        root_action.name = f"{name}_Root"

    add_nla_action(armature, action, name)
    add_nla_action(root, root_action, name)

    for obj in source_objects:
        if obj.name in bpy.context.scene.objects:
            bpy.data.objects.remove(obj, do_unlink=True)


def build_model(name, source):
    reset_scene()
    import_fbx(source)
    root, armature = normalize_root_hierarchy(add_ground_root=False)
    clean_scene_extras()
    output = MODEL_DIR / f"{name}.glb"
    export_gltf(output, animations=False)
    print(f"model: {output}")


def build_animation(name, source, strategy, stabilization):
    reset_scene()
    import_fbx(source)
    root, armature = normalize_root_hierarchy(add_ground_root=False)
    clean_scene_extras()
    action = choose_action(strategy).copy()
    action.name = name
    root_action = choose_root_action(strategy)
    if root_action:
        root_action = root_action.copy()
        root_action.name = f"{name}_Root"
    keep_only_bone_tracks(action)
    stabilize_action(action, stabilization)
    remove_other_actions(action, root_action)

    armature.animation_data_create()
    armature.animation_data.action = action
    if root_action:
        root.animation_data_create()
        root.animation_data.action = root_action
    else:
        clear_root_animation(root)
    bpy.context.scene.frame_start = int(action.frame_range[0])
    bpy.context.scene.frame_end = int(action.frame_range[1])
    output = ANIM_DIR / f"{name}.glb"
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_animations=True,
        export_nla_strips=False,
        export_force_sampling=False,
        export_frame_range=True,
        export_yup=True,
    )
    print(f"animation: {output} frames={list(action.frame_range)}")


def main():
    ensure_dir(MODEL_DIR)
    ensure_dir(ANIM_DIR)
    for name, source in MODELS:
        build_model(name, source)
    for name, source, strategy, stabilization in ANIMATIONS:
        build_animation(name, source, strategy, stabilization)


if __name__ == "__main__":
    main()
