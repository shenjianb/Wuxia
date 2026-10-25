# Current Animation Framework

Last refreshed: 2026-06-23.

This reference captures the current `D:\Wuxia_Web` animation, combat, and asset workflow so a new thread can get oriented quickly.

## Project Entry Points

- `index.html` + `src/main.js`: runtime game demo.
- `motion-editor.html` + `src/motion-editor.js`: motion config and Root Motion preview/tuning.
- `model-editor.html` + `src/model-editor.js`: model collider configuration.
- `move-manager.html` + `src/move-manager.js`: combat move pool, weights, hit windows, and impact settings.
- `npc-editor.html` + `src/npc-editor.js`: NPC profile setup.
- `behavior-editor.html` + `src/behavior-editor.js`: behavior tree authoring.
- `scene-editor.html` + `src/scene-editor.js`: scene/object placement.

Dev server APIs in `vite.config.js` persist editor data under `public/assets`.

## Important Data Files

- `public/assets/animations/motion_config.json`: per-action motion behavior.
- `public/assets/combat/move_manager.json`: combat move definitions and hit windows.
- `public/assets/models/model_config.json`: base and part colliders for runtime hit/hurt tests.
- `public/assets/npcs/*.json`: NPC definitions.
- `public/assets/behavior-trees/*.json`: behavior graphs.
- `public/assets/ai-profiles/**.json`: brain/personality profiles.

## Asset Pipeline

FBX source files are centralized under:

```text
D:\Wuxia_Web\FBX
```

`tools/merge_base_characters.py` reads:

- `FBX/SK_BaseMan.fbx`
- `FBX/SK_BaseMan_body.fbx`
- `FBX/SK_BaseFemale.fbx`
- `FBX/SK_BaseFemale_body.fbx`

and writes:

- `FBX/SK_BaseMan_merged.fbx`
- `FBX/SK_BaseFemale_merged.fbx`

`tools/build_glb_assets.py` reads merged model FBX and animation FBX from `FBX`, then writes:

- `public/assets/models/SK_BaseMale.glb`
- `public/assets/models/SK_BaseFemale.glb`
- animation GLBs under `public/assets/animations`

Current build mappings include:

- `Anim_Normal_Idle2.fbx` -> `Anim_Normal_Idle2.glb`
- `Anim_Normal_Walk_F_0.fbx` -> `Anim_Normal_Walk_F.glb`
- `Anim_Normal_Idle_Turn_L_In.fbx` -> `Anim_Normal_Idle_Turn_L.glb`
- `Anim_Normal_Idle_Turn_R_In.fbx` -> `Anim_Normal_Idle_Turn_R.glb`
- `Anim_Combat_Idle_Hand.fbx` -> `Anim_Combat_Idle_Hand.glb`
- `Anim_Combat_Walk_Short_F_Hand.fbx` -> `Anim_Combat_Walk_Short_F_Hand.glb`
- `Anim_Combat_Idle_Turn_L_Hand_In.fbx` -> `Anim_Combat_Idle_Turn_L_Hand.glb`
- `Anim_Combat_Idle_Turn_R_Hand_In.fbx` -> `Anim_Combat_Idle_Turn_R_Hand.glb`
- `Anim_Combat_Att_F_Hand_0_In.fbx` -> `Anim_Combat_Att_F_Hand_0.glb`
- `Anim_Combat_Att_F_Hand_1_In.fbx` -> `Anim_Combat_Att_F_Hand_1.glb`
- `Anim_Combat_Att_F_Hand_1_Ro.fbx` -> `Anim_Combat_Att_F_Hand_1_Ro.glb`
- `Anim_Combat_Att_F_Hand_2_In.fbx` -> `Anim_Combat_Att_F_Hand_2.glb`
- `Anim_Combat_Att_RB_Hand_0_In.fbx` -> `Anim_Combat_Att_RB_Hand_0.glb`
- `Anim_Combat_Att_LB_Hand_0_In.fbx` -> `Anim_Combat_Att_LB_Hand_0.glb`

Run after FBX changes:

```powershell
npm run assets:glb
npm run build
```

## Runtime Animation Loading

`src/main.js` starts with built-in locomotion assets:

- `idle`
- `walk`
- `turnLeft`
- `turnRight`
- `combatIdle`
- `combatWalk`
- `combatTurnLeft`
- `combatTurnRight`

Combat attack assets are registered dynamically from `public/assets/combat/move_manager.json` via `registerCombatMoveAnimationAssets()`. Use the move manager data as the source of truth for attack action names and files.

`createCharacterActions()` creates an action for every loaded animation. `configureAnimationAction()` sets loop/clamp behavior from `motion_config.json` and attack status.

## Motion Config Snapshot

Current `motion_config.json` contains these action keys:

- Normal: `idle`, `walk`, `turnLeft`, `turnRight`
- Combat locomotion: `combatIdle`, `combatWalk`, `combatTurnLeft`, `combatTurnRight`
- Combat attacks: `combat_Att_F_Hand_0`, `combat_Att_F_Hand_1`, `combat_Att_LB_Hand_0`, `combat_Att_RB_Hand_0`, `combat_Att_F_Hand_2`, `combat_Att_F_Hand_1_Ro`

Current notable modes:

- `walk`: `InPlace`, code move speed configured.
- `combatWalk`: `RootMotion`, `applyRootRotation: false`, `rootPoseRotation: true`, `rootPoseRotationAnchor: "clipStart"`, `rootMotionMoveBasis: "clipRootDelta"`, `rootMotionForwardOnly: true`.
- `combat_Att_F_Hand_1`: `RootMotion`, `rootMotionMoveBasis: "characterForward"`, `rootPoseRotation: true`.
- `combat_Att_F_Hand_1_Ro`: `RootMotion`, `rootMotionMoveBasis: "characterForward"`, `rootMotionForwardOnly: true`.
- Most other attack clips are currently `InPlace`.

Always inspect the live JSON before changing behavior; this snapshot is a guide.

## Root Concepts

There are two important transforms:

- Outer character group: `character.root`. This owns world movement, facing, collision, the facing marker, and gameplay position.
- Skeleton Root: `character.scene.getObjectByName("Root")`. This receives animation tracks and drives Root marker/pose behavior.

Root Motion extraction:

- Samples clip Root position/quaternion.
- Converts local Root delta through normalized scene scale.
- Applies physical movement to `character.root`.
- Optionally applies yaw to `character.root` based on `applyRootRotation`.
- Maintains skeleton Root pose separately for visible weight shift.

In-Place processing:

- `filterAnimationTracks()` de-trends Root position according to bake settings.
- Root sway can be preserved and scaled with `rootSwayScale`.
- Rotation can be blocked with `bakeIntoPoseRotation`.

Do not collapse these two systems into one transform.

## Motion Editor Parity

`src/motion-editor.js` mirrors runtime Root and motion processing:

- `filterAnimationTracks`
- `sampleClipRootMotion`
- `getDetrendedRootPose`
- `getRootPoseQuaternion`
- `getRootMotionDeltaWorld`
- Root marker and root trail visualization

When changing `src/main.js` motion behavior, update `src/motion-editor.js` or extract shared logic. Treat runtime/editor divergence as a bug unless the user explicitly asks for a throwaway experiment.

## Combat System

Combat move data lives in `public/assets/combat/move_manager.json` and is normalized by `src/combat-move-manager.js`.

Directions:

- `forward`: `KeyW`
- `left`: `KeyA`
- `right`: `KeyD`

Each move can define:

- `actionFile`
- `actionName`
- `weight`
- `strength`
- `blockable`
- `hitWindows`
- `impact.knockback`
- `impact.hitstun`

Hit windows bind to model collider IDs, for example hand colliders in `model_config.json`.

Runtime combat uses:

- `beginCharacterCombatAttack`
- `evaluateCombatAttackHits`
- `finishCharacterCombatAttack`
- `updateNpcCombatAttack`
- `combat-collision-utils.js` for model/base/part collider math

When adding combat moves, prefer data changes in move manager/model config over hard-coded runtime branches.

## NPC Combat Behavior

Runtime NPC support is present:

- `src/npc-ai-runtime.js` evaluates brain scoring and behavior decisions.
- `src/main.js` loads runtime NPCs and behavior trees.
- `RUNTIME_NPC_NAME` is currently `"ONE"`.
- NPC attack selection can use behavior tree attack nodes and move manager move IDs.

NPC behavior files are under:

- `public/assets/npcs`
- `public/assets/behavior-trees`
- `public/assets/ai-profiles`

When changing combat behavior, consider both player and NPC paths.

## Debugging Surfaces

Use these before guessing:

- Cyan `RootMarker`: skeleton Root world X/Z projected to ground.
- Facing marker: outer character facing direction.
- Combat collider debug: shows hit boxes/recent hits.
- `window.__DEMO_READY` and `window.__DEMO_ERROR`.
- `window.__DEMO_STATE`: runtime debug state.
- Motion editor root trail/readout.
- Model editor collider visualization.
- Move manager hit window and collider binding UI.

Headless WebGPU screenshots can be black even when runtime state is valid. Prefer debug state and browser console errors.

## Known Pitfalls

- Mixamo-exported skinned FBX can corrupt skin/bind relationships for this project. Use clean merged local models plus separate animation GLBs.
- If the mesh jumps while facing marker stays stable, debug skeleton Root pose/action blending before world movement.
- If Root Motion and code movement both affect an action, expect drift or double movement.
- If a model lies sideways or becomes tiny, suspect axis conversion, normalization, or Root rest-pose reset.
- If motion editor and runtime disagree, fix parity first.
