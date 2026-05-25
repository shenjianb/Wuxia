import json
import sys
from pathlib import Path

import bpy


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def inspect(path: Path):
    reset_scene()
    bpy.ops.import_scene.fbx(filepath=str(path))
    objects = []
    for obj in bpy.context.scene.objects:
        objects.append(
            {
                "name": obj.name,
                "type": obj.type,
                "materials": [slot.material.name if slot.material else None for slot in obj.material_slots],
                "modifiers": [mod.type for mod in obj.modifiers],
            }
        )
    return {"file": str(path), "objects": objects}


def main():
    files = [Path(arg) for arg in sys.argv[sys.argv.index("--") + 1 :]]
    print(json.dumps([inspect(path) for path in files], indent=2))


if __name__ == "__main__":
    main()
