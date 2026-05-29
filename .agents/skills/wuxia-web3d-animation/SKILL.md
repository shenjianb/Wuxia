---
name: wuxia-web3d-animation
description: Project-specific guide for D:\Wuxia_Web. Use when working on the three.js WebGPU demo's character animation framework, FBX-to-GLB asset pipeline, Mixamo animation clips, Root Motion versus In-Place movement, Root track filtering, foot/root debugging, or combat systems that need to plug into the current animation state machine.
---

# Wuxia Web3D Animation

## Quick Start

Use this skill to get oriented before changing animation, movement, combat, or asset import code in `D:\Wuxia_Web`.

First read:

- `src/main.js`
- `src/motion-editor.js`
- `tools/build_glb_assets.py`
- `public/assets/animations/motion_config.json`

For the current project-specific map, read [references/current-animation-framework.md](references/current-animation-framework.md).

## Current Architecture

The demo uses Vite + `three/webgpu` with `WebGPURenderer`. The main runtime is `src/main.js`.

Assets are loaded as GLB:

- Models: `public/assets/models/SK_BaseMale.glb`, `SK_BaseFemale.glb`
- Animations: separate GLBs under `public/assets/animations`
- Motion config: `public/assets/animations/motion_config.json`

The current model source should be the clean merged local FBX output, not Mixamo-exported skinned characters. Mixamo-exported skinned FBX was observed to corrupt skin/bind relationships for these models.

## Animation Rules

Preserve these conventions unless the user explicitly asks to experiment:

- Use clean merged character meshes plus separate Mixamo animation GLBs.
- Keep model GLBs animation-free.
- Use `Anim_Normal_Idle2`, `Anim_Normal_Walk_F`, `Anim_Normal_Idle_Turn_L`, and `Anim_Normal_Idle_Turn_R` as the current base locomotion set.
- Turn animations currently come from In-Place source FBX files: `Anim_Normal_Idle_Turn_L_In.fbx` and `Anim_Normal_Idle_Turn_R_In.fbx`.
- Do not reintroduce hard-coded `gltf.scene.rotation.x = Math.PI / 2`; the current merged GLBs are already upright.
- Keep cache busting through `ASSET_VERSION` when replacing GLB assets.

## Root Motion

The runtime supports both In-Place and Root Motion concepts:

- In-Place: code controls world movement/turning while animation may retain de-trended Root sway for weight shift.
- Root Motion: animation Root displacement/rotation can be extracted and applied to the outer character group.

Root filtering is driven by `motion_config.json` and `filterAnimationTracks()` in `src/main.js`, not by blindly deleting every Root track. For In-Place clips, the project uses a Unity-like "Bake Into Pose" approach: remove linear Root drift while preserving useful oscillation/sway.

The UI includes runtime controls for Root position/rotation pass/block and a motion mode toggle if present in the current code. The cyan cross marker follows the skeleton `Root` world position projected onto the ground so Root behavior can be inspected visually.

## Motion Editor Parity

Keep the motion editor and runtime animation-processing semantics identical. Runtime issues should be reproducible in `motion-editor` before they appear in gameplay.

- When changing Root filtering, Bake Into Pose, Root Motion extraction, Root pose anchoring, Root pose rotation, foot locking, visual yaw, action timing, or `motion_config.json` semantics in `src/main.js`, mirror the same behavior in `src/motion-editor.js` or move the shared logic into a common helper.
- Treat divergence as a bug: if gameplay shows a movement, facing, sliding, or grounding issue that the motion editor cannot show with the same clip/config, first compare editor/runtime action processing paths.
- Validate risky animation changes in both places. The motion editor should be the first diagnostic surface for runtime foot contact, Root offsets, Root rotation, and mesh-versus-arrow alignment.

## Build And Validate

When source FBX files change, run:

```powershell
cd D:\Wuxia_Web
npm run assets:glb
npm run build
```

If only JS/CSS changes, run:

```powershell
npm run build
```

Use existing project scripts such as `tools/check_page.mjs` for browser sanity checks when appropriate. Headless WebGPU screenshots may appear black even when runtime state is healthy; rely on `window.__DEMO_READY`, `window.__DEMO_ERROR`, and debug state as the primary automated check.

## Combat Integration Guidance

For combat work, build on the current animation action map instead of replacing it wholesale:

- Add clips to `ASSETS.animations`, `loadAnimations()`, `createCharacterActions()`, and `motion_config.json`.
- Treat combat as a state layer over locomotion: idle, walk, turn, attack, hit, dodge, dead.
- Decide per action whether it is In-Place or Root Motion before implementing hit movement.
- Keep movement authority clear: either code moves the outer character group, or Root Motion extraction does. Avoid applying both for the same axis/action.
- Keep Root marker and motion toggles available while tuning attacks.

Current combat locomotion conventions:

- `Tab` toggles normal/combat. Combat locomotion maps to `combatIdle`, `combatWalk`, `combatTurnLeft`, and `combatTurnRight`.
- Current combat clips are `Anim_Combat_Idle_Hand`, `Anim_Combat_Walk_Short_F_Hand`, `Anim_Combat_Idle_Turn_L_Hand`, and `Anim_Combat_Idle_Turn_R_Hand`.
- `combatIdle` uses `visualYawOffsetDegrees: -50` to align the visible combat stance with the outer character facing arrow. Do not flip this sign based only on offline foot/toe sampling; verify against the in-app facing arrow.
- The yellow-green facing arrow represents the outer `player.root` direction. If the arrow does not jump but the mesh jumps, debug skeleton `Root` local pose/action blending, not world movement or collision.

Combat Root Motion rules:

- For combat walk, prefer `motionMode: "RootMotion"` with `rootMotionMoveBasis: "clipRootDelta"` so the animation's own small-step lateral Root delta is preserved. Use `rootMotionForwardOnly: true` only to clamp tiny negative forward rebound, not to project all movement onto a straight forward vector.
- Keep `applyRootRotation: false` for combat walk when the animation Root yaw should not rotate the outer character/arrow.
- Separate physical Root Motion from visible Root pose. Extract outer movement from the unblended source clip `Root.position`, not from the mixed runtime skeleton `Root`, because idle/walk fade blending contaminates the delta.
- On action switch into RootMotion, capture the current skeleton `Root.position` as a pose anchor. Display Root XZ as `poseAnchor + detrendedRootPose(t) - detrendedRootPose(0)` so walk/idle Root first-frame offset differences do not make the mesh jump while the arrow stays still. Do not anchor Root Y to idle/rest; preserve the action's own detrended Root Y or combat walk feet will float.
- Preserve Root pose rotation separately from physical rotation. `applyRootRotation: false` should block only outer-character rotation. If the clip needs weight-shift rotation, use config like `rootPoseRotation: true` and `rootPoseRotationScale: 1` and apply the clip Root quaternion delta to the skeleton pose. If removing the clip's first-frame Root quaternion breaks foot grounding, set `rootPoseRotationAnchor: "clipStart"` and make both runtime and `motion-editor` honor it.
- When leaving RootMotion for an In-Place combat idle, use a short blend-out/cooldown for skeleton Root pose and foot lock. Blend Root rotation toward the next action's configured Root pose, not blindly toward model rest; if the next In-Place action has `bakeIntoPoseRotation: false`, its Root quaternion track is the target. Do not let foot-lock anchors bind during the RootMotion-to-idle transition.

Combat tuning and diagnostics:

- `codeMoveSpeed` is an action-level movement/timing knob. For RootMotion actions it should influence action `timeScale`, not add code-driven position on top of RootMotion.
- Keep debug state fields for `combatMode`, `desiredAction/currentAction`, `motionMode`, `rootMotionMoveBasis`, `rootMotionForwardOnly`, `codeMoveSpeed`, foot-lock anchors/cooldown, visual yaw, and Root pose anchors when tuning.
- If pressing Space causes a tiny jump to one side and releasing Space jumps back while the facing arrow stays still, suspect skeleton `Root` pose anchoring or filtered Root tracks before changing world movement direction.
