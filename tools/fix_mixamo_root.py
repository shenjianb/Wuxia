import sys
from pathlib import Path

import bpy


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def ensure_root_empty(name="Root"):
    root = bpy.data.objects.get(name)
    if root and root.type != "EMPTY":
        root.name = f"{name}_Original"
        root = None

    if not root:
        root = bpy.data.objects.new(name, None)
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


def clean_duplicate_roots(root):
    for obj in list(bpy.context.scene.objects):
        if obj == root:
            continue
        if obj.type == "EMPTY" and obj.name.startswith("Root"):
            for child in list(obj.children):
                parent_keep_world(child, root)
            bpy.data.objects.remove(obj, do_unlink=True)


def normalize_hierarchy(root):
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if not armatures:
        raise RuntimeError("No armature found in imported FBX.")

    # Prefer the armature named by the source character.
    armature = next((obj for obj in armatures if obj.name.startswith("Bip001")), armatures[0])
    armature.name = "Bip001"
    armature.data.name = "Bip001"
    parent_keep_world(armature, root)

    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            if obj.parent is None:
                parent_keep_world(obj, armature)
            for modifier in obj.modifiers:
                if modifier.type == "ARMATURE":
                    modifier.object = armature

    return armature


def rename_mixamo_actions(input_stem):
    main_action = None
    root_action = None
    for action in bpy.data.actions:
        if "|mixamo.com|Layer0" in action.name:
            if action.name.startswith("Bip001|"):
                action.name = input_stem
                main_action = action
            elif action.name.startswith("Root|"):
                action.name = f"{input_stem}_Root"
                root_action = action
    return main_action, root_action


def set_scene_frame_range(*actions):
    ranges = [action.frame_range for action in actions if action]
    if not ranges:
        return
    start = min(frame_range[0] for frame_range in ranges)
    end = max(frame_range[1] for frame_range in ranges)
    bpy.context.scene.frame_start = int(start)
    bpy.context.scene.frame_end = int(end)


def export_fbx(output_path):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.fbx(
        filepath=str(output_path),
        use_selection=True,
        object_types={"ARMATURE", "MESH", "EMPTY"},
        add_leaf_bones=False,
        bake_anim=True,
        bake_anim_use_all_bones=True,
        bake_anim_use_nla_strips=False,
        bake_anim_use_all_actions=False,
    )


def main():
    args = sys.argv[sys.argv.index("--") + 1 :]
    if len(args) != 2:
        raise SystemExit("Usage: blender --background --python fix_mixamo_root.py -- input.fbx output.fbx")

    input_path = Path(args[0]).resolve()
    output_path = Path(args[1]).resolve()

    reset_scene()
    bpy.ops.import_scene.fbx(filepath=str(input_path))

    root = ensure_root_empty()
    clean_duplicate_roots(root)
    armature = normalize_hierarchy(root)
    main_action, root_action = rename_mixamo_actions(input_path.stem)
    if main_action:
        armature.animation_data_create()
        armature.animation_data.action = main_action
    if root_action:
        root.animation_data_create()
        root.animation_data.action = root_action
    set_scene_frame_range(main_action, root_action)

    export_fbx(output_path)
    print(f"Exported fixed FBX: {output_path}")


if __name__ == "__main__":
    main()
