# Current Animation Framework

This reference captures the latest known state of `D:\Wuxia_Web` for fast onboarding.

## Key Files

- `src/main.js`: WebGPU renderer, scene setup, character loading, animation actions, Root filtering, movement, Root marker, debug state.
- `src/styles.css`: overlay, runtime buttons, visual controls.
- `tools/build_glb_assets.py`: converts FBX models/animations to public GLB assets.
- `tools/merge_base_characters.py`: merges clean local body parts from `Unused`.
- `public/assets/animations/motion_config.json`: per-action motion behavior.

## Asset Pipeline

Model source:

- `Unused/SK_BaseMan.fbx` + `Unused/SK_BaseMan_body.fbx` -> `SK_BaseMan_merged.fbx`
- `Unused/SK_BaseFemale.fbx` + `Unused/SK_BaseFemale_body.fbx` -> `SK_BaseFemale_merged.fbx`

Model GLB output:

- `public/assets/models/SK_BaseMale.glb`
- `public/assets/models/SK_BaseFemale.glb`

Animation source mapping in `tools/build_glb_assets.py`:

- `Anim_Normal_Idle2.fbx` -> `Anim_Normal_Idle2.glb`
- `Anim_Normal_Walk_F_0.fbx` -> `Anim_Normal_Walk_F.glb`
- `Anim_Normal_Idle_Turn_L_In.fbx` -> `Anim_Normal_Idle_Turn_L.glb`
- `Anim_Normal_Idle_Turn_R_In.fbx` -> `Anim_Normal_Idle_Turn_R.glb`

Run:

```powershell
npm run assets:glb
```

## Runtime Animation Map

`src/main.js` loads:

- `idle`
- `walk`
- `turnLeft`
- `turnRight`

Actions are created by `createCharacterActions()`. New actions should follow the same pattern:

1. Add GLB path to `ASSETS.animations`.
2. Load it in `loadAnimations()`.
3. Add it in `createCharacterActions()`.
4. Add config in `motion_config.json`.
5. Route to it from movement/combat state logic.

## Motion Config

Current `motion_config.json` uses keys matching merged clip names:

```json
{
  "idle": { "motionMode": "InPlace" },
  "walk": { "motionMode": "InPlace", "rootSwayScale": 0.6 },
  "turnLeft": { "motionMode": "InPlace" },
  "turnRight": { "motionMode": "InPlace" }
}
```

Important fields:

- `motionMode`: `"InPlace"` or `"RootMotion"`.
- `bakeIntoPoseXZ`: remove linear X/Z drift while preserving sway.
- `bakeIntoPoseY`: remove linear Y drift while preserving bounce.
- `bakeIntoPoseRotation`: block/de-trend Root rotation for In-Place clips.
- `rootSwayScale`: reduce preserved Root sway amplitude when body motion doubles visually.

## Root And Movement

There are two Root concepts:

- Outer character group: `character.root`; code/world movement applies here.
- Skeleton Root bone/object: `player.scene.getObjectByName("Root")`; animation tracks target this.

In-Place mode:

- Code moves/turns `character.root`.
- `filterAnimationTracks()` removes drift but may preserve Root sway.
- Root marker shows skeleton Root projected to ground.

Root Motion mode:

- Runtime extracts per-frame Root delta from the skeleton Root.
- Delta is transformed through `character.scene.matrixWorld` to account for model normalization scale.
- Y is locked to ground for now.
- Yaw is applied to the outer character group.
- After extraction, skeleton Root is restored to its loaded rest pose, not mathematical identity, to avoid lying/tilting issues.

## Debugging Notes

- The cyan cross named `RootMarker` follows the skeleton Root world X/Z projected to ground.
- `window.__DEMO_STATE` exposes root marker position, root filters, bounds, renderer size, and other diagnostics.
- Headless Edge/Chrome WebGPU screenshots can be black even when the app is running. Check debug state first.
- If a character lies sideways or becomes tiny, suspect axis conversion, model normalization, or Root rest-pose reset.
- If arms stretch after importing a Mixamo-exported skinned FBX into Blender, do not use that skinned FBX as the final model source.

## Known Preferences

- Keep WebGPU enabled.
- Preserve GitHub Pages compatibility.
- Prefer standard skeleton/model workflows over voxel prototyping for final replacement ease.
- Keep changes scoped; do not rewrite the rendering stack while tuning animation.
