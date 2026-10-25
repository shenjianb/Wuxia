---
name: wuxia-web3d-animation
description: Project-specific guide for D:\Wuxia_Web. Use when working on the three.js WebGPU wuxia demo's animation framework, FBX-to-GLB pipeline, Root Motion versus In-Place movement, motion editor parity, combat move system, hit collision, model colliders, NPC combat behavior, or any feature that touches character movement/action state.
---

# Wuxia Web3D Animation

## Purpose

Use this skill before changing animation, movement, combat, collision, NPC combat behavior, or FBX/GLB assets in `D:\Wuxia_Web`.

Read the current project map first:

- [references/current-animation-framework.md](references/current-animation-framework.md)

Then inspect the relevant source files directly. This skill is an onboarding map, not a substitute for reading the current code.

## Invocation Guidance

Use this skill once at the start of a new conversation when the task touches animation, combat, Root Motion, FBX assets, model colliders, NPC behavior, or editor tooling.

Do not invoke it for every message in the same conversation. After it has been loaded, continue normally unless the thread was compacted, the task switched to a different subsystem, or the user asks to refresh project context.

For critical new threads, explicitly ask:

```text
Use $wuxia-web3d-animation and read the project-level skill before working on D:\Wuxia_Web.
```

Do not assume automatic loading is enough when the request is vague, such as "continue" or "fix this". Trigger-based loading may miss ambiguous prompts.

## Core Files

Start with these files depending on the task:

- Runtime gameplay: `src/main.js`
- Motion tuning: `src/motion-editor.js`
- Combat move definitions: `src/combat-move-manager.js`, `public/assets/combat/move_manager.json`
- Hit and hurt colliders: `src/combat-collision-utils.js`, `public/assets/models/model_config.json`
- NPC runtime behavior: `src/npc-ai-runtime.js`, `src/npc-editor.js`, `public/assets/npcs`, `public/assets/behavior-trees`
- Asset conversion: `tools/build_glb_assets.py`, `tools/merge_base_characters.py`
- Dev APIs and editor persistence: `vite.config.js`
- Motion config: `public/assets/animations/motion_config.json`

## Asset Pipeline Rules

FBX source files live under:

```text
D:\Wuxia_Web\FBX
```

Model GLBs are exported to:

```text
public/assets/models
```

Animation GLBs are exported to:

```text
public/assets/animations
```

Run this after FBX changes:

```powershell
cd D:\Wuxia_Web
npm run assets:glb
npm run build
```

Use clean local merged character meshes as model sources. Do not use Mixamo-exported skinned character FBX as the final model source; this project previously observed skin/bind corruption after Mixamo export.

## Runtime Rules

The project separates three concepts:

- Outer character group: `character.root`, used for world position, collision, facing marker, and gameplay movement.
- Skeleton Root: `scene.getObjectByName("Root")`, used by animation tracks and Root pose visualization.
- Clip config: `motion_config.json`, used to decide In-Place, Root Motion, bake settings, Root pose rotation, code movement, and foot lock behavior.

Preserve these rules:

- Keep model GLBs animation-free.
- Keep animation GLBs separate.
- Keep `src/main.js` and `src/motion-editor.js` behavior aligned for Root filtering, Bake Into Pose, Root Motion extraction, Root pose anchoring, Root pose rotation, and foot lock.
- Do not reintroduce hard-coded model axis fixes like `gltf.scene.rotation.x = Math.PI / 2`; current merged GLBs are expected to be upright.
- Bump `ASSET_VERSION` when browser cache might hide changed GLBs/config.

## Motion Config Rules

Each action name used by runtime should have a matching `motion_config.json` entry.

Important config fields include:

- `motionMode`: `InPlace` or `RootMotion`.
- `loop`: false for one-shot attacks and hit reactions.
- `bakeIntoPoseXZ`, `bakeIntoPoseY`, `bakeIntoPoseRotation`: de-trend Root tracks for In-Place clips.
- `rootSwayScale`: scales preserved Root sway after drift removal.
- `codeMoveSpeed`, `codeMoveBasis`, `codeMoveYawOffsetDegrees`: code-driven movement controls.
- `applyRootRotation`: whether Root Motion rotates the outer character.
- `rootPoseRotation`, `rootPoseRotationAnchor`, `rootPoseRotationScale`: visible skeleton Root pose rotation controls.
- `rootMotionMoveBasis`, `rootMotionForwardOnly`: physical Root Motion projection controls.
- `footLock`, `footLockContactY`, `footLockReleaseY`: foot stabilization controls.
- `visualYawOffsetDegrees`: mesh-facing correction relative to the outer character/facing marker.

Avoid applying code movement and physical Root Motion to the same axis/action unless that is the explicit experiment.

## Combat Integration Rules

Combat actions are data-driven through the combat move manager.

When adding an attack:

1. Add/convert the FBX in `tools/build_glb_assets.py`.
2. Ensure the GLB appears in `public/assets/animations`.
3. Add or edit the action config in `motion_config.json`.
4. Add or edit move data in `public/assets/combat/move_manager.json`.
5. Configure hit windows and collider bindings through the move manager/model collider data.
6. Verify in the runtime and in `motion-editor` for Root/motion behavior.

Current attack routing uses direction intents from `COMBAT_MOVE_DIRECTIONS`:

- Forward: `KeyW`
- Left: `KeyA`
- Right: `KeyD`

Do not hard-code a new attack only in `src/main.js` if it belongs in move manager data.

## Debugging Rules

Use the project debug surfaces:

- Cyan Root marker: skeleton `Root` world X/Z projected to the ground.
- Facing marker: outer `character.root` direction.
- `window.__DEMO_STATE`: runtime state, Root/motion/debug data.
- Motion editor root trail/readout: compare with runtime when tuning clips.
- Combat collider debug UI: inspect hit boxes and recent hits.

If the mesh jumps but the facing marker does not, suspect skeleton Root pose anchoring, filtered Root tracks, or action blend state before changing world movement.

If a character lies sideways or becomes tiny, suspect axis conversion, model normalization, or Root rest-pose reset.

If Blender shows stretched arms after importing a Mixamo-exported skinned FBX, do not repair the runtime first; verify the source skin/bind relationship.

## Validation

For JS/CSS/config-only changes:

```powershell
npm run build
```

For asset pipeline changes:

```powershell
npm run assets:glb
npm run build
```

Headless WebGPU screenshots may be black even when the app works. Prefer runtime debug state, browser console errors, and direct in-app inspection.
