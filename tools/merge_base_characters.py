from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[1]
FBX_DIR = ROOT / "FBX"


PAIRS = [
    {
        "base": FBX_DIR / "SK_BaseMan.fbx",
        "body": FBX_DIR / "SK_BaseMan_body.fbx",
        "output": FBX_DIR / "SK_BaseMan_merged.fbx",
        "mesh_name": "SK_BaseMan_merged",
        "base_material": "SK_BaseMan",
        "body_material": "SK_BaseMan_body",
    },
    {
        "base": FBX_DIR / "SK_BaseFemale.fbx",
        "body": FBX_DIR / "SK_BaseFemale_body.fbx",
        "output": FBX_DIR / "SK_BaseFemale_merged.fbx",
        "mesh_name": "SK_BaseFemale_merged",
        "base_material": "SK_BaseFemale",
        "body_material": "SK_BaseFemale_body",
    },
]


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def import_fbx(path: Path):
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.fbx(filepath=str(path))
    return [obj for obj in bpy.context.scene.objects if obj not in before]


def first_of_type(objects, object_type):
    matches = [obj for obj in objects if obj.type == object_type]
    if not matches:
        raise RuntimeError(f"No {object_type} found")
    return matches[0]


def prepare_single_material(mesh_obj, material_name):
    if mesh_obj.material_slots:
        material = mesh_obj.material_slots[0].material
        if material is None:
            material = bpy.data.materials.new(material_name)
    else:
        material = bpy.data.materials.new(material_name)

    material.name = material_name
    mesh_obj.data.materials.clear()
    mesh_obj.data.materials.append(material)
    for polygon in mesh_obj.data.polygons:
        polygon.material_index = 0


def point_armature_modifiers_at(mesh_obj, armature_obj):
    for modifier in mesh_obj.modifiers:
        if modifier.type == "ARMATURE":
            modifier.object = armature_obj


def merge_pair(config):
    reset_scene()

    base_objects = import_fbx(config["base"])
    body_objects = import_fbx(config["body"])
    body_object_names = {obj.name for obj in body_objects}

    base_armature = first_of_type(base_objects, "ARMATURE")
    body_armature = first_of_type(body_objects, "ARMATURE")
    base_mesh = first_of_type(base_objects, "MESH")
    body_mesh = first_of_type(body_objects, "MESH")

    prepare_single_material(base_mesh, config["base_material"])
    prepare_single_material(body_mesh, config["body_material"])
    point_armature_modifiers_at(base_mesh, base_armature)
    point_armature_modifiers_at(body_mesh, base_armature)

    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = base_mesh
    base_mesh.select_set(True)
    body_mesh.select_set(True)
    bpy.ops.object.join()

    merged_mesh = bpy.context.view_layer.objects.active
    merged_mesh.name = config["mesh_name"]
    merged_mesh.data.name = f"{config['mesh_name']}_Mesh"
    merged_mesh.parent = base_armature

    for obj_name in body_object_names:
        obj = bpy.data.objects.get(obj_name)
        if obj and obj != merged_mesh:
            bpy.data.objects.remove(obj, do_unlink=True)

    export_objects = [base_armature, merged_mesh]
    for obj in base_objects:
        if obj.type == "EMPTY" and obj.name in bpy.context.scene.objects:
            export_objects.append(obj)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in export_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = merged_mesh

    bpy.ops.export_scene.fbx(
        filepath=str(config["output"]),
        use_selection=True,
        object_types={"ARMATURE", "MESH", "EMPTY"},
        add_leaf_bones=False,
        bake_anim=False,
    )

    return {
        "output": str(config["output"]),
        "mesh": merged_mesh.name,
        "materials": [slot.material.name for slot in merged_mesh.material_slots],
    }


def main():
    results = [merge_pair(config) for config in PAIRS]
    for result in results:
        print(result)


if __name__ == "__main__":
    main()
