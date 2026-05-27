import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createFacingMarker } from "./facing-marker.js";
import "./styles.css";

const ASSET_VERSION = "combat-interaction-20260527-01";
const assetUrl = (path) => `${path}?v=${ASSET_VERSION}`;

const ASSETS = {
  models: {
    male: assetUrl("./assets/models/SK_BaseMale.glb"),
    female: assetUrl("./assets/models/SK_BaseFemale.glb"),
  },
  animations: {
    idle: assetUrl("./assets/animations/Anim_Normal_Idle2.glb"),
    walk: assetUrl("./assets/animations/Anim_Normal_Walk_F.glb"),
    turnLeft: assetUrl("./assets/animations/Anim_Normal_Idle_Turn_L.glb"),
    turnRight: assetUrl("./assets/animations/Anim_Normal_Idle_Turn_R.glb"),
    combatIdle: assetUrl("./assets/animations/Anim_Combat_Idle_Hand.glb"),
    combatWalk: assetUrl("./assets/animations/Anim_Combat_Walk_Short_F_Hand.glb"),
    combatTurnLeft: assetUrl("./assets/animations/Anim_Combat_Idle_Turn_L_Hand.glb"),
    combatTurnRight: assetUrl("./assets/animations/Anim_Combat_Idle_Turn_R_Hand.glb"),
    combat_Att_F_Hand_1: assetUrl("./assets/animations/Anim_Combat_Att_F_Hand_1.glb"),
    combat_Att_LB_Hand_0: assetUrl("./assets/animations/Anim_Combat_Att_LB_Hand_0.glb"),
    combat_Att_RB_Hand_0: assetUrl("./assets/animations/Anim_Combat_Att_RB_Hand_0.glb"),
  },
};

const CHARACTER_HEIGHT = 2.2;
const PLAYER_SPEED = 2;
const TURN_SPEED = 2.35;
const CAMERA_LERP = 4.5;
const SELECT_TRANSITION_SPEED = 1.25;
const WORLD_SIZE = 18;
const TILE_SIZE = 1.35;
const FOOT_LOCK_BONES = ["Bip001_L_Toe0", "Bip001_R_Toe0", "Bip001_L_Foot", "Bip001_R_Foot"];
const FOOT_LOCK_CONTACT_Y = 0.09;
const FOOT_LOCK_RELEASE_Y = 0.17;
const ROOT_TRACK_NAME = "Root";
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const ACTION_FADE_DURATION = 0.22;
const ROOT_MOTION_BLEND_OUT_GRACE = ACTION_FADE_DURATION + 0.1;
const COMBAT_ATTACK_RECOVERY_DURATION = 0.3;
const COMBAT_ATTACK_INPUTS = {
  KeyW: { direction: "forward", actionName: "combat_Att_F_Hand_1" },
  KeyA: { direction: "leftBack", actionName: "combat_Att_LB_Hand_0" },
  KeyD: { direction: "rightBack", actionName: "combat_Att_RB_Hand_0" },
};
const COMBAT_ATTACK_DIRECTIONS = Object.values(COMBAT_ATTACK_INPUTS).map((input) => input.direction);
const COMBAT_ATTACK_ACTION_BY_DIRECTION = Object.fromEntries(
  Object.values(COMBAT_ATTACK_INPUTS).map((input) => [input.direction, input.actionName]),
);
const COMBAT_ATTACK_ACTION_NAMES = new Set(Object.values(COMBAT_ATTACK_ACTION_BY_DIRECTION));

const app = document.querySelector("#app");
const DEBUG_VIEW = new URLSearchParams(window.location.search).has("debug");
const DISABLE_ANIMATION = new URLSearchParams(window.location.search).has("noanim");
window.__DEMO_READY = false;
window.__DEMO_ERROR = null;
const overlay = document.createElement("div");
overlay.className = "overlay";
overlay.innerHTML = `
  <div class="topbar">
    <div class="brand">Wuxia Web3D</div>
    <div class="runtime-controls">
      <div class="badge" data-renderer>WebGPU</div>
      <div class="badge" data-combat-mode>Normal</div>
    </div>
  </div>
  <div class="panel" data-panel>
    <div class="title">选择主角</div>
    <div class="choices">
      <button data-choice="male">男主角</button>
      <button data-choice="female">女主角</button>
    </div>
  </div>
`;
app.appendChild(overlay);

const state = {
  mode: "select",
  selectedGender: null,
  transition: 0,
  keys: {
    forward: false,
    left: false,
    right: false,
  },
  rootFilters: {
    translation: false,
    rotation: true,
  },
  globalMotionMode: "InPlace",
  combatMode: false,
  combatAttack: {
    keys: {
      forward: false,
      leftBack: false,
      rightBack: false,
    },
    active: false,
    activeDirection: null,
    activeActionName: null,
    queuedDirection: null,
    recoveryTimer: 0,
  },
};

const loader = new GLTFLoader();
const clock = new THREE.Clock();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x090b0d);

const diagnosticMarker = new THREE.Mesh(
  new THREE.BoxGeometry(0.8, 0.8, 0.8),
  new THREE.MeshBasicMaterial({ color: 0xff3355 }),
);
diagnosticMarker.position.set(0, 0.8, 0);
if (DEBUG_VIEW) scene.add(diagnosticMarker);

const rootMarker = createRootMarker();
rootMarker.visible = false;
scene.add(rootMarker);

const facingMarker = createFacingMarker(THREE, { renderOrder: 2 });
facingMarker.visible = false;
scene.add(facingMarker);

const camera = new THREE.OrthographicCamera(-8, 8, 5, -5, 0.1, 80);
const cameraTarget = new THREE.Vector3();
const cameraOffset = new THREE.Vector3(7, 6.5, 7);

const ambientLight = new THREE.AmbientLight(0xffffff, 2.6);
scene.add(ambientLight);

const hemiLight = new THREE.HemisphereLight(0xd8ecff, 0x60442d, 3.4);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight(0xffe0aa, 5.5);
keyLight.position.set(-5, 9, 5);
keyLight.castShadow = true;
scene.add(keyLight);

const campfireLight = new THREE.PointLight(0xff8f2b, 9, 12, 1.8);
campfireLight.position.set(0, 1.15, 0);
scene.add(campfireLight);

let renderer;
let characters;
let animations;
let motionConfig = {};
let selectionSet;
let worldSet;
let player;
let obstacles = [];
const rootMarkerWorldPosition = new THREE.Vector3();
const facingMarkerWorldPosition = new THREE.Vector3();

boot();

async function boot() {
  try {
    if (!navigator.gpu) {
      throw new Error("当前浏览器没有暴露 navigator.gpu。请用支持 WebGPU 的 Chrome/Edge，并通过 localhost 或 HTTPS 访问。");
    }

    renderer = new THREE.WebGPURenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    await renderer.init();

    if (!renderer.backend?.isWebGPUBackend) {
      throw new Error("three.js 初始化时没有拿到 WebGPU backend。");
    }

    app.appendChild(renderer.domElement);
    setRendererBadge("WebGPU", true);

    try {
      const configResponse = await fetch(assetUrl("./assets/animations/motion_config.json"));
      motionConfig = await configResponse.json();
      console.log("动作配置加载成功:", motionConfig);
      if (motionConfig.walk && motionConfig.walk.motionMode) {
        state.globalMotionMode = motionConfig.walk.motionMode;
      }
    } catch (e) {
      console.warn("未能成功从网络加载 motion_config.json，使用默认原地配置:", e);
      motionConfig = {
        idle: { motionMode: "InPlace", loop: true, bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: true },
        walk: { motionMode: "InPlace", loop: true, bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: true },
        turnLeft: { motionMode: "InPlace", loop: true, bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: true },
        turnRight: { motionMode: "InPlace", loop: true, bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: true },
        combatIdle: { motionMode: "InPlace", loop: true, visualYawOffsetDegrees: -50, footLock: true, footLockContactY: 0.09, footLockReleaseY: 0.14, bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: false },
        combatWalk: { motionMode: "RootMotion", loop: true, visualYawOffsetDegrees: -50, applyRootRotation: false, rootPoseRotation: true, rootPoseRotationAnchor: "clipStart", rootPoseRotationScale: 1, rootMotionMoveBasis: "clipRootDelta", rootMotionForwardOnly: true, codeMoveBasis: "characterForward", codeMoveYawOffsetDegrees: 0, codeMoveSpeed: 1, bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: true },
        combatTurnLeft: { motionMode: "InPlace", loop: true, visualYawOffsetDegrees: -50, bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: true },
        combatTurnRight: { motionMode: "InPlace", loop: true, visualYawOffsetDegrees: -50, bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: true },
        combat_Att_F_Hand_1: { motionMode: "InPlace", loop: false, bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: false, rootSwayScale: 1.5 },
        combat_Att_LB_Hand_0: { motionMode: "InPlace", loop: false, bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: false, rootSwayScale: 1 },
        combat_Att_RB_Hand_0: { motionMode: "InPlace", loop: false, bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: false, rootSwayScale: 1 }
      };
    }

    animations = await loadAnimations();
    characters = {
      male: await createCharacter("male", ASSETS.models.male),
      female: await createCharacter("female", ASSETS.models.female),
    };

    setupSelectionScene();
    window.__DEMO_READY = true;
    window.__DEMO_STATE = getDebugState();
    document.body.dataset.ready = "true";
    bindInput();
    updateCombatModeUI();
    resize();
    renderer.render(scene, camera);
    await renderer.setAnimationLoop(update);
  } catch (error) {
    console.error(error);
    window.__DEMO_ERROR = error.message;
    setRendererBadge("WebGPU 不可用", false);
    document.querySelector("[data-panel]").innerHTML = `<div class="title">WebGPU 初始化失败</div><p>${error.message}</p>`;
  }
}

async function loadAnimations() {
  const [
    idleGltf,
    walkGltf,
    turnLeftGltf,
    turnRightGltf,
    combatIdleGltf,
    combatWalkGltf,
    combatTurnLeftGltf,
    combatTurnRightGltf,
    combatAttackForwardGltf,
    combatAttackLeftBackGltf,
    combatAttackRightBackGltf,
  ] = await Promise.all([
    loader.loadAsync(ASSETS.animations.idle),
    loader.loadAsync(ASSETS.animations.walk),
    loader.loadAsync(ASSETS.animations.turnLeft),
    loader.loadAsync(ASSETS.animations.turnRight),
    loader.loadAsync(ASSETS.animations.combatIdle),
    loader.loadAsync(ASSETS.animations.combatWalk),
    loader.loadAsync(ASSETS.animations.combatTurnLeft),
    loader.loadAsync(ASSETS.animations.combatTurnRight),
    loader.loadAsync(ASSETS.animations.combat_Att_F_Hand_1),
    loader.loadAsync(ASSETS.animations.combat_Att_LB_Hand_0),
    loader.loadAsync(ASSETS.animations.combat_Att_RB_Hand_0),
  ]);
  return {
    idle: mergeAnimationClips(idleGltf.animations, "idle"),
    walk: mergeAnimationClips(walkGltf.animations, "walk"),
    turnLeft: mergeAnimationClips(turnLeftGltf.animations, "turnLeft"),
    turnRight: mergeAnimationClips(turnRightGltf.animations, "turnRight"),
    combatIdle: mergeAnimationClips(combatIdleGltf.animations, "combatIdle"),
    combatWalk: mergeAnimationClips(combatWalkGltf.animations, "combatWalk"),
    combatTurnLeft: mergeAnimationClips(combatTurnLeftGltf.animations, "combatTurnLeft"),
    combatTurnRight: mergeAnimationClips(combatTurnRightGltf.animations, "combatTurnRight"),
    combat_Att_F_Hand_1: mergeAnimationClips(combatAttackForwardGltf.animations, "combat_Att_F_Hand_1"),
    combat_Att_LB_Hand_0: mergeAnimationClips(combatAttackLeftBackGltf.animations, "combat_Att_LB_Hand_0"),
    combat_Att_RB_Hand_0: mergeAnimationClips(combatAttackRightBackGltf.animations, "combat_Att_RB_Hand_0"),
  };
}

function mergeAnimationClips(clips, name) {
  const tracks = clips.flatMap((clip) => clip.tracks.map((track) => track.clone()));
  return new THREE.AnimationClip(name, -1, tracks);
}

// 辅助函数：计算动画轨道在特定时间点的值（用于首尾增量计算）
function getTrackValueAtTime(track, time) {
  if (!track || !track.times.length) return null;
  const times = track.times;
  const values = track.values;
  const stride = track.values.length / track.times.length;
  
  if (time <= times[0]) {
    return Array.from(values.slice(0, stride));
  }
  if (time >= times[times.length - 1]) {
    return Array.from(values.slice(values.length - stride));
  }
  
  let i = 0;
  while (i < times.length - 1 && time > times[i + 1]) {
    i++;
  }
  
  const t0 = times[i];
  const t1 = times[i + 1];
  const alpha = (time - t0) / (t1 - t0);
  
  const strideOffset0 = i * stride;
  const strideOffset1 = (i + 1) * stride;
  
  const result = [];
  for (let j = 0; j < stride; j++) {
    result.push(values[strideOffset0 + j] + alpha * (values[strideOffset1 + j] - values[strideOffset0 + j]));
  }
  return result;
}

// 辅助函数：计算动画剪辑中 Root 骨骼在单个循环周期内的总位移和旋转增量
function calculateClipRootCycle(clip) {
  if (clip._rootCycleData) return clip._rootCycleData;

  const posTrack = clip.tracks.find(t => t.name === "Root.position");
  const rotTrack = clip.tracks.find(t => t.name === "Root.quaternion" || t.name === "Root.rotation");
  
  const startPos = new THREE.Vector3();
  const endPos = new THREE.Vector3();
  const startRot = new THREE.Quaternion();
  const endRot = new THREE.Quaternion();
  
  if (posTrack) {
    const vStart = getTrackValueAtTime(posTrack, 0);
    const vEnd = getTrackValueAtTime(posTrack, clip.duration);
    if (vStart) startPos.fromArray(vStart);
    if (vEnd) endPos.fromArray(vEnd);
  }
  
  if (rotTrack) {
    const qStart = getTrackValueAtTime(rotTrack, 0);
    const qEnd = getTrackValueAtTime(rotTrack, clip.duration);
    if (qStart) {
      if (qStart.length === 4) startRot.fromArray(qStart);
      else if (qStart.length === 3) startRot.setFromEuler(new THREE.Euler().fromArray(qStart));
    }
    if (qEnd) {
      if (qEnd.length === 4) endRot.fromArray(qEnd);
      else if (qEnd.length === 3) endRot.setFromEuler(new THREE.Euler().fromArray(qEnd));
    }
  }
  
  clip._rootCycleData = {
    startPosition: startPos,
    endPosition: endPos,
    cyclePosition: new THREE.Vector3().subVectors(endPos, startPos),
    startRotation: startRot,
    endRotation: endRot,
    cycleRotation: new THREE.Quaternion().copy(startRot).invert().premultiply(endRot)
  };
  
  return clip._rootCycleData;
}

function sampleClipRootMotion(clip, time) {
  const posTrack = clip.tracks.find((track) => track.name === "Root.position");
  const rotTrack = clip.tracks.find((track) => track.name === "Root.quaternion" || track.name === "Root.rotation");
  const sampleTime = clip.duration > 0 ? THREE.MathUtils.clamp(time, 0, clip.duration) : 0;
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();

  if (posTrack) {
    const value = getTrackValueAtTime(posTrack, sampleTime);
    if (value) position.fromArray(value);
  }

  if (rotTrack) {
    const value = getTrackValueAtTime(rotTrack, sampleTime);
    if (value?.length === 4) {
      quaternion.fromArray(value).normalize();
    } else if (value?.length === 3) {
      quaternion.setFromEuler(new THREE.Euler().fromArray(value));
    }
  }

  return { position, quaternion };
}

function getDetrendedRootPose(clip, time, config = {}) {
  const sample = sampleClipRootMotion(clip, time).position;
  const cycleData = calculateClipRootCycle(clip);
  if (clip.duration <= 0) return sample;

  const alpha = THREE.MathUtils.clamp(time / clip.duration, 0, 1);
  if (config.bakeIntoPoseXZ !== false) {
    sample.x -= cycleData.cyclePosition.x * alpha;
    sample.z -= cycleData.cyclePosition.z * alpha;
  }
  if (config.bakeIntoPoseY) {
    sample.y -= cycleData.cyclePosition.y * alpha;
  }

  const swayScale = config.rootSwayScale ?? 1;
  if (swayScale < 1) {
    sample.x = cycleData.startPosition.x + (sample.x - cycleData.startPosition.x) * swayScale;
    sample.y = cycleData.startPosition.y + (sample.y - cycleData.startPosition.y) * swayScale;
    sample.z = cycleData.startPosition.z + (sample.z - cycleData.startPosition.z) * swayScale;
  }

  return sample;
}

function getRootPoseQuaternion(clip, time, config = {}, anchorQuaternion = new THREE.Quaternion()) {
  if (!config.rootPoseRotation) return anchorQuaternion.clone();

  const cycleData = calculateClipRootCycle(clip);
  const currRot = sampleClipRootMotion(clip, time).quaternion;
  const deltaRot = new THREE.Quaternion()
    .copy(cycleData.startRotation)
    .invert()
    .premultiply(currRot);
  const poseRot = deltaRot.multiply(anchorQuaternion).normalize();
  const scale = THREE.MathUtils.clamp(config.rootPoseRotationScale ?? 1, 0, 1);

  return anchorQuaternion.clone().slerp(poseRot, scale);
}

function getRootPoseRotationAnchorQuaternion(clip, config = {}, fallbackQuaternion = new THREE.Quaternion()) {
  if (config.rootPoseRotationAnchor === "clipStart") {
    return sampleClipRootMotion(clip, 0).quaternion;
  }
  return fallbackQuaternion.clone();
}

function getInPlaceRootPoseQuaternion(clip, time, config = {}, restQuaternion = new THREE.Quaternion()) {
  if (!clip || config.bakeIntoPoseRotation !== false) {
    return restQuaternion.clone();
  }

  const hasRootRotationTrack = clip.tracks.some((track) =>
    track.name === "Root.quaternion" || track.name === "Root.rotation",
  );
  if (!hasRootRotationTrack) return restQuaternion.clone();

  return sampleClipRootMotion(clip, time).quaternion;
}

// 计算动画的固有世界行走速度（XZ 平面），用于 InPlace 模式的步速匹配
// 对标 Unity Animator 的 Speed 参数和 UE 的 Sync Group 机制
function computeAnimNaturalSpeed(clipName, character) {
  const clip = animations[clipName];
  if (!clip || clip.duration <= 0) return 0;
  const cycleData = calculateClipRootCycle(clip);
  const localDisp = cycleData.cyclePosition;
  if (!localDisp) return 0;

  // 通过父节点世界矩阵的 3×3 子矩阵将局部位移变换到世界空间
  character.root.updateMatrixWorld(true);
  const m3 = new THREE.Matrix3().setFromMatrix4(character.scene.matrixWorld);
  const worldDisp = localDisp.clone().applyMatrix3(m3);
  const xzDist = Math.sqrt(worldDisp.x * worldDisp.x + worldDisp.z * worldDisp.z);
  return xzDist / clip.duration;
}

function getConfiguredCodeMoveDirection(actionName, character) {
  const config = motionConfig[actionName] || {};
  const localDirection = new THREE.Vector3(0, 0, 1);

  if (config.codeMoveBasis === "clipRootDelta") {
    const clip = animations[actionName];
    if (clip) {
      const cycleDelta = calculateClipRootCycle(clip).cyclePosition.clone();
      cycleDelta.y = 0;
      if (cycleDelta.lengthSq() > 0.000001) {
        localDirection.copy(cycleDelta.normalize());
      }
    }
  }

  if (Array.isArray(config.codeMoveLocalDirection) && config.codeMoveLocalDirection.length >= 3) {
    localDirection.set(
      Number(config.codeMoveLocalDirection[0]) || 0,
      Number(config.codeMoveLocalDirection[1]) || 0,
      Number(config.codeMoveLocalDirection[2]) || 0,
    );
    localDirection.y = 0;
    if (localDirection.lengthSq() <= 0.000001) localDirection.set(0, 0, 1);
    localDirection.normalize();
  }

  const yawOffset = THREE.MathUtils.degToRad(config.codeMoveYawOffsetDegrees ?? 0);
  return localDirection
    .applyAxisAngle(WORLD_UP, yawOffset)
    .applyAxisAngle(WORLD_UP, character.root.rotation.y)
    .normalize();
}

function getConfiguredCodeMoveSpeed(actionName) {
  const config = motionConfig[actionName] || {};
  const speed = Number(config.codeMoveSpeed);
  return Number.isFinite(speed) && speed >= 0 ? speed : PLAYER_SPEED;
}

function hasConfiguredCodeMoveSpeed(actionName) {
  const config = motionConfig[actionName] || {};
  const speed = Number(config.codeMoveSpeed);
  return Number.isFinite(speed) && speed >= 0;
}

function getRootMotionDeltaWorld(actionName, character, deltaPos) {
  const config = motionConfig[actionName] || {};
  character.scene.updateMatrixWorld(true);
  const sceneScale = character.scene.getWorldScale(new THREE.Vector3());
  const scaledLocalDelta = new THREE.Vector3(
    deltaPos.x * sceneScale.x,
    0,
    deltaPos.z * sceneScale.z,
  );

  if (config.rootMotionMoveBasis === "characterForward") {
    const clip = animations[actionName];
    const cycleDelta = clip
      ? calculateClipRootCycle(clip).cyclePosition.clone()
      : new THREE.Vector3(0, 0, 1);
    cycleDelta.y = 0;
    if (cycleDelta.lengthSq() <= 0.000001) cycleDelta.set(0, 0, 1);
    cycleDelta.normalize();

    let signedDistance = scaledLocalDelta.dot(cycleDelta);
    if (config.rootMotionForwardOnly) signedDistance = Math.max(0, signedDistance);
    if (Math.abs(signedDistance) <= 0.000001) return new THREE.Vector3();
    return getConfiguredCodeMoveDirection(actionName, character).multiplyScalar(signedDistance);
  }

  const clip = animations[actionName];
  const localDelta = scaledLocalDelta.clone();
  if (config.rootMotionForwardOnly && clip) {
    const cycleDelta = calculateClipRootCycle(clip).cyclePosition.clone();
    cycleDelta.y = 0;
    if (cycleDelta.lengthSq() > 0.000001) {
      cycleDelta.normalize();
      const signedDistance = localDelta.dot(cycleDelta);
      if (signedDistance < 0) localDelta.addScaledVector(cycleDelta, -signedDistance);
    }
  }

  return localDelta
    .applyAxisAngle(WORLD_UP, character.sceneRestRotationY ?? 0)
    .applyQuaternion(character.root.quaternion);
}

function getConfiguredVisualYawOffset(actionName) {
  const config = motionConfig[actionName] || {};
  return THREE.MathUtils.degToRad(config.visualYawOffsetDegrees ?? 0);
}

function getMotionMode(actionName) {
  return motionConfig[actionName]?.motionMode ?? "InPlace";
}

function updateVisualYawOffset(character, delta) {
  const actionName = getActionName(character, character.desiredAction)
    ?? getActionName(character, character.currentAction)
    ?? "idle";
  const target = getConfiguredVisualYawOffset(actionName);
  character.visualYawOffset = THREE.MathUtils.damp(character.visualYawOffset, target, 12, delta);
  character.scene.rotation.y = character.sceneRestRotationY + character.visualYawOffset;
}

async function createCharacter(gender, url) {
  const gltf = await loader.loadAsync(url);
  const root = new THREE.Group();
  root.name = `Character_${gender}`;
  root.add(gltf.scene);

  normalizeModel(gltf.scene);
  if (DEBUG_VIEW) tintCharacter(gltf.scene, gender);
  gltf.scene.traverse((obj) => {
    if (obj.isMesh || obj.isSkinnedMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  // 保存 Root 骨骼的静息姿态（Rest Pose），后续每帧重置时恢复到此值而非数学零值
  // GLB 模型中 Root 骨骼自带坐标系旋转（FBX Z-up → glTF Y-up），强行设为 identity 会导致人物躺倒
  const skeletonRootBone = gltf.scene.getObjectByName(ROOT_TRACK_NAME);
  const rootRestPosition = skeletonRootBone ? skeletonRootBone.position.clone() : new THREE.Vector3();
  const rootRestQuaternion = skeletonRootBone ? skeletonRootBone.quaternion.clone() : new THREE.Quaternion();

  const mixer = new THREE.AnimationMixer(gltf.scene);
  const actions = createCharacterActions(mixer, gltf.scene);
  if (!DISABLE_ANIMATION) actions.idle.play();

  return {
    gender,
    root,
    scene: gltf.scene,
    mixer,
    actions,
    currentAction: actions.idle,
    desiredAction: actions.idle,
    footLock: {
      boneName: null,
      anchor: new THREE.Vector3(),
      anchors: new Map(),
      cooldown: 0,
    },
    rootMotionBlendOut: 0,
    rootMotionState: {
      prevTime: 0,
      prevPosition: new THREE.Vector3(),
      prevQuaternion: new THREE.Quaternion(),
      poseAnchor: new THREE.Vector3(),
      poseAnchorQuaternion: new THREE.Quaternion(),
    },
    sceneRestRotationY: gltf.scene.rotation.y,
    visualYawOffset: 0,
    rootRestPosition,
    rootRestQuaternion,
    active: true,
  };
}

function createCharacterActions(mixer, model) {
  const actions = {
    idle: mixer.clipAction(filterAnimationTracks(animations.idle, model)),
    walk: mixer.clipAction(filterAnimationTracks(animations.walk, model)),
    turnLeft: mixer.clipAction(filterAnimationTracks(animations.turnLeft, model)),
    turnRight: mixer.clipAction(filterAnimationTracks(animations.turnRight, model)),
    combatIdle: mixer.clipAction(filterAnimationTracks(animations.combatIdle, model)),
    combatWalk: mixer.clipAction(filterAnimationTracks(animations.combatWalk, model)),
    combatTurnLeft: mixer.clipAction(filterAnimationTracks(animations.combatTurnLeft, model)),
    combatTurnRight: mixer.clipAction(filterAnimationTracks(animations.combatTurnRight, model)),
    combat_Att_F_Hand_1: mixer.clipAction(filterAnimationTracks(animations.combat_Att_F_Hand_1, model)),
    combat_Att_LB_Hand_0: mixer.clipAction(filterAnimationTracks(animations.combat_Att_LB_Hand_0, model)),
    combat_Att_RB_Hand_0: mixer.clipAction(filterAnimationTracks(animations.combat_Att_RB_Hand_0, model)),
  };
  Object.entries(actions).forEach(([actionName, action]) => configureAnimationAction(actionName, action));
  return actions;
}

function configureAnimationAction(actionName, action) {
  const config = motionConfig[actionName] || {};
  action.clampWhenFinished = config.loop === false;
  action.setLoop(config.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, config.loop === false ? 1 : Infinity);
  action.timeScale = 1;
  action.paused = false;
}

function rebuildCharacterActions(character) {
  const nextActionName = getActionName(character, character.desiredAction)
    ?? getActionName(character, character.currentAction)
    ?? "idle";
  character.mixer.stopAllAction();
  character.actions = createCharacterActions(character.mixer, character.scene);
  character.currentAction = character.actions[nextActionName] ?? character.actions.idle;
  character.desiredAction = character.currentAction;
  
  // 切换或重新构建动作后，立刻重置根骨骼跟踪状态，确保无抖动过渡
  const skeletonRoot = character.scene.getObjectByName(ROOT_TRACK_NAME);
  if (skeletonRoot) {
    character.rootMotionState.prevTime = character.currentAction.time;
    character.rootMotionState.prevPosition.copy(skeletonRoot.position);
    character.rootMotionState.prevQuaternion.copy(skeletonRoot.quaternion);
    character.rootMotionState.poseAnchor.copy(skeletonRoot.position);
    character.rootMotionState.poseAnchorQuaternion.copy(skeletonRoot.quaternion);
  }

  if (!DISABLE_ANIMATION) character.currentAction.reset().play();
  character.footLock.boneName = null;
  character.footLock.anchors.clear();
  character.footLock.cooldown = 0;
  character.rootMotionBlendOut = 0;
}

function rebuildAllCharacterActions() {
  Object.values(characters ?? {}).forEach((character) => rebuildCharacterActions(character));
}

function getActionName(character, action) {
  return Object.entries(character.actions).find(([, candidate]) => candidate === action)?.[0];
}

function retargetPositionTracks(clip, model) {
  return filterAnimationTracks(clip, model);
}

function filterAnimationTracks(clip, model) {
  const config = motionConfig[clip.name] || {
    motionMode: "InPlace",
    bakeIntoPoseXZ: true,
    bakeIntoPoseY: true,
    bakeIntoPoseRotation: true
  };

  const clone = clip.clone();
  clone.tracks = clone.tracks.map((track) => {
    const targetName = getTrackTargetName(track.name);
    if (track.name.endsWith(".scale")) return null;

    // 处理根骨骼 (Root) 轨道
    if (targetName === ROOT_TRACK_NAME) {
      if (isRotationTrack(track.name)) {
        if (config.motionMode === "InPlace" && config.bakeIntoPoseRotation) return null;
        if (config.motionMode === "RootMotion" && config.applyRootRotation === false) return null;
      }
      if (track.name.endsWith(".position") && config.motionMode === "InPlace") {
        // ═══ Unity 式 Bake Into Pose 算法 ═══
        // 不是粗暴删除 Root 轨道（会丧失重心摇摆），
        // 也不是原封保留（会产生前进漂移与代码移动打架），
        // 而是：减去线性漂移趋势，只保留振荡分量（重心左右偏移、上下起伏）。
        //
        // 原始轨道: rootPos(t) = linearDrift(t) + oscillation(t)
        // linearDrift(t) = startPos + (endPos - startPos) * t / duration   ← 前进趋势
        // 减趋势后: bakedPos(t) = rootPos(t) - linearDrift(t) + startPos   ← 只剩摆动
        //
        // 效果：Root 骨骼在每个循环内左右摇摆、上下起伏，但不向前漂移。
        //       循环首尾值相等，loop 无缝衔接。
        const numKeys = track.times.length;
        if (numKeys >= 2) {
          const stride = 3;
          const values = new track.values.constructor(track.values.length);
          const duration = track.times[numKeys - 1] - track.times[0];
          const t0 = track.times[0];
          
          // 首帧 & 末帧的位置
          const startX = track.values[0], startY = track.values[1], startZ = track.values[2];
          const endIdx = (numKeys - 1) * stride;
          const endX = track.values[endIdx], endY = track.values[endIdx + 1], endZ = track.values[endIdx + 2];
          
          // 每秒的线性漂移速率
          const driftRateX = duration > 0 ? (endX - startX) / duration : 0;
          const driftRateY = duration > 0 ? (endY - startY) / duration : 0;
          const driftRateZ = duration > 0 ? (endZ - startZ) / duration : 0;
          
          for (let i = 0; i < numKeys; i++) {
            const t = track.times[i] - t0;
            // bakeIntoPoseXZ: 消除 XZ 平面漂移（前进/侧移），保留摆动
            // bakeIntoPoseY:  消除 Y 轴漂移（垂直），保留起伏
            values[i * stride]     = track.values[i * stride]     - (config.bakeIntoPoseXZ ? driftRateX * t : 0);
            values[i * stride + 1] = track.values[i * stride + 1] - (config.bakeIntoPoseY  ? driftRateY * t : 0);
            values[i * stride + 2] = track.values[i * stride + 2] - (config.bakeIntoPoseXZ ? driftRateZ * t : 0);
          }
          
          // ═══ 振幅缩减（Sway Scale）═══
          // Root 骨骼去趋势后的残留振荡会与子骨骼 Pelvis 的自有摆动在父子层级中
          // 产生叠加放大（Double Oscillation），导致上半身晃动幅度超出美术原始设计。
          // 通过 rootSwayScale (0~1) 在轨道预处理阶段等比缩减振幅：
          //   1.0 = 保留全量摆动（脚步最贴地，但上半身晃动最大）
          //   0.0 = 完全锁定到首帧（等效于删除轨道，脚步会打滑）
          //   0.6 = 推荐折中（保留 60% 重心偏移用于脚步贴地，消减 40% 叠加晃动）
          const swayScale = config.rootSwayScale ?? 1.0;
          if (swayScale < 1.0) {
            const baseX = values[0], baseY = values[1], baseZ = values[2];
            for (let i = 1; i < numKeys; i++) {
              values[i * stride]     = baseX + (values[i * stride]     - baseX) * swayScale;
              values[i * stride + 1] = baseY + (values[i * stride + 1] - baseY) * swayScale;
              values[i * stride + 2] = baseZ + (values[i * stride + 2] - baseZ) * swayScale;
            }
          }
          
          return new THREE.VectorKeyframeTrack(track.name, track.times.slice(), values);
        }
      }
    }

    // 骨骼重定位与起伏恢复 (相对重定位 Pelvis 位移以维持原地重心稳定)
    if (targetName !== ROOT_TRACK_NAME && track.name.endsWith(".position")) {
      if (targetName === "Bip001_Pelvis" || targetName === "Bip001 Pelvis") {
        const target = model.getObjectByName(targetName);
        if (target && track.values.length >= 3) {
          const values = new track.values.constructor(track.values.length);
          const firstX = track.values[0];
          const firstY = track.values[1];
          const firstZ = track.values[2];
          
          for (let i = 0; i < track.values.length; i += 3) {
            // Pelvis 骨骼位置相对于其默认绑定姿态(target.position)做动画增量偏移
            values[i] = target.position.x + (track.values[i] - firstX);
            values[i + 1] = target.position.y + (track.values[i + 1] - firstY);
            values[i + 2] = target.position.z + (track.values[i + 2] - firstZ);
          }
          return new THREE.VectorKeyframeTrack(track.name, track.times.slice(), values);
        }
      }
      return null; // 其他骨骼直接屏蔽位移轨道，防止产生比例伸缩变形问题
    }
    return track;
  }).filter(Boolean);
  
  clone.resetDuration();
  return clone;
}

function getTrackTargetName(trackName) {
  const dotIndex = trackName.lastIndexOf(".");
  return dotIndex === -1 ? trackName : trackName.slice(0, dotIndex);
}

function isRotationTrack(trackName) {
  return trackName.endsWith(".rotation") || trackName.endsWith(".quaternion");
}

function normalizeModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = CHARACTER_HEIGHT / Math.max(size.y, 0.001);
  model.scale.multiplyScalar(scale);

  const scaledBox = new THREE.Box3().setFromObject(model);
  const center = scaledBox.getCenter(new THREE.Vector3());
  const minY = scaledBox.min.y;
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= minY;
}

function tintCharacter(model, gender) {
  const colors = gender === "male"
    ? [0x7fa5c9, 0xc7a48b]
    : [0xc78092, 0xcaa28b];
  let index = 0;
  model.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    const nextMaterials = materials.map((material) => {
      const color = new THREE.Color(colors[index % colors.length]);
      index += 1;
      return new THREE.MeshBasicMaterial({
        color,
        skinning: obj.isSkinnedMesh,
      });
    });
    obj.material = Array.isArray(obj.material) ? nextMaterials : nextMaterials[0];
  });
}

function setupSelectionScene() {
  selectionSet = new THREE.Group();
  selectionSet.name = "SelectionScene";
  scene.add(selectionSet);

  const ground = createVoxelGround(8, 8, 0x1b1c19, 0x25221b);
  ground.position.y = -0.04;
  selectionSet.add(ground);
  selectionSet.add(createCampfire());

  characters.male.root.position.set(-2.1, 0, -0.85);
  characters.female.root.position.set(2.1, 0, -0.85);
  characters.male.root.rotation.y = Math.PI * 0.36;
  characters.female.root.rotation.y = -Math.PI * 0.36;
  selectionSet.add(characters.male.root, characters.female.root);

  cameraTarget.set(0, 0.8, 0.4);
  updateCamera(1);
}

function createVoxelGround(width, depth, colorA, colorB) {
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(TILE_SIZE, 0.12, TILE_SIZE);
  const materials = [
    new THREE.MeshBasicMaterial({ color: colorA }),
    new THREE.MeshBasicMaterial({ color: colorB }),
  ];
  for (let x = -width; x <= width; x++) {
    for (let z = -depth; z <= depth; z++) {
      const material = materials[Math.abs(x + z) % 2];
      const tile = new THREE.Mesh(geometry, material);
      tile.position.set(x * TILE_SIZE, -0.08, z * TILE_SIZE);
      tile.receiveShadow = true;
      group.add(tile);
    }
  }
  return group;
}

function createCampfire() {
  const group = new THREE.Group();
  const logMaterial = new THREE.MeshStandardMaterial({ color: 0x49301f, roughness: 0.92 });
  const emberMaterial = new THREE.MeshStandardMaterial({
    color: 0xff6b25,
    emissive: 0xff3d00,
    emissiveIntensity: 2.5,
    roughness: 0.5,
  });
  const logGeometry = new THREE.BoxGeometry(0.22, 0.22, 1.3);
  for (let i = 0; i < 4; i++) {
    const log = new THREE.Mesh(logGeometry, logMaterial);
    log.position.y = 0.1;
    log.rotation.y = (Math.PI / 4) * i;
    log.castShadow = true;
    group.add(log);
  }
  const flameGeometry = new THREE.BoxGeometry(0.38, 0.52, 0.38);
  for (let i = 0; i < 3; i++) {
    const flame = new THREE.Mesh(flameGeometry, emberMaterial);
    flame.name = "VoxelFlame";
    flame.position.set((i - 1) * 0.12, 0.38 + i * 0.12, (i % 2) * 0.12);
    flame.rotation.y = i * 0.65;
    group.add(flame);
  }
  return group;
}

function createRootMarker() {
  const group = new THREE.Group();
  group.name = "RootMarker";
  const material = new THREE.MeshBasicMaterial({
    color: 0x75f4ff,
    depthTest: false,
    transparent: true,
    opacity: 0.7,
  });
  // 缩小至 50%，降低层级不遮挡角色
  const barX = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.025, 0.035), material);
  const barZ = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.025, 0.43), material);
  const center = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.035, 0.08), material);
  group.add(barX, barZ, center);
  group.renderOrder = 1;
  group.traverse((obj) => {
    obj.renderOrder = 1;
  });
  return group;
}

function createWorldScene() {
  worldSet = new THREE.Group();
  worldSet.name = "GameWorld";
  scene.add(worldSet);

  worldSet.add(createVoxelGround(WORLD_SIZE, WORLD_SIZE, 0x20231f, 0x252923));
  obstacles = [];
  const materialChoices = [0x56624f, 0x665d4c, 0x4c626b];
  const boxGeometry = new THREE.BoxGeometry(TILE_SIZE, TILE_SIZE, TILE_SIZE);

  for (let x = -WORLD_SIZE + 2; x < WORLD_SIZE - 2; x += 2) {
    for (let z = -WORLD_SIZE + 2; z < WORLD_SIZE - 2; z += 2) {
      const distance = Math.hypot(x, z);
      const noise = seededNoise(x * 13.37, z * 9.71);
      if (distance < 4 || noise < 0.72) continue;

      const height = noise > 0.91 ? 2 : 1;
      const material = new THREE.MeshBasicMaterial({
        color: materialChoices[Math.floor(noise * materialChoices.length) % materialChoices.length],
      });
      for (let y = 0; y < height; y++) {
        const block = new THREE.Mesh(boxGeometry, material);
        block.position.set(x * TILE_SIZE, y * TILE_SIZE + TILE_SIZE / 2 - 0.02, z * TILE_SIZE);
        block.castShadow = true;
        block.receiveShadow = true;
        worldSet.add(block);
      }
      obstacles.push(new THREE.Box2(
        new THREE.Vector2(x * TILE_SIZE - TILE_SIZE * 0.55, z * TILE_SIZE - TILE_SIZE * 0.55),
        new THREE.Vector2(x * TILE_SIZE + TILE_SIZE * 0.55, z * TILE_SIZE + TILE_SIZE * 0.55),
      ));
    }
  }
}

function seededNoise(x, z) {
  const value = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function chooseGender(gender) {
  if (state.mode !== "select") return;
  state.mode = "transition";
  state.selectedGender = gender;
  player = characters[gender];
  const other = characters[gender === "male" ? "female" : "male"];
  other.active = false;
  document.querySelector("[data-panel]").classList.add("hidden");
}

function enterWorld() {
  state.mode = "game";
  selectionSet.visible = false;
  createWorldScene();
  scene.add(player.root);
  player.root.position.set(0, 0, 0);
  player.root.rotation.y = Math.PI;
  cameraTarget.set(0, 1, 0);
}

function toggleGlobalMotionMode() {
  state.globalMotionMode = state.globalMotionMode === "InPlace" ? "RootMotion" : "InPlace";
  
  const targetMode = state.globalMotionMode;
  if (motionConfig.walk) motionConfig.walk.motionMode = targetMode;
  if (motionConfig.turnLeft) motionConfig.turnLeft.motionMode = targetMode;
  if (motionConfig.turnRight) motionConfig.turnRight.motionMode = targetMode;
  
  // 原地模式下 translation/rotation 阻断开启；RootMotion 模式下阻断关闭（Pass）
  state.rootFilters.translation = (targetMode === "InPlace");
  state.rootFilters.rotation = (targetMode === "InPlace");
  
  // 重置所有角色的 Pitch 和 Roll 旋转，确保其立刻笔直站立
  Object.values(characters ?? {}).forEach((character) => {
    const euler = new THREE.Euler().setFromQuaternion(character.root.quaternion, "YXZ");
    character.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), euler.y);
  });
  
  updateGlobalMotionModeUI();
  updateRootFilterButtons();
  rebuildAllCharacterActions();
}

function updateGlobalMotionModeUI() {
  const button = document.querySelector("[data-motion-toggle]");
  if (button) {
    const isRM = state.globalMotionMode === "RootMotion";
    button.classList.toggle("active", isRM);
    button.textContent = `Mode: ${isRM ? "Root Motion" : "In-Place"}`;
  }
}

function toggleCombatMode() {
  if (state.mode !== "game") return;
  state.combatMode = !state.combatMode;
  if (!state.combatMode) {
    cancelCombatAttack({ clearKeys: true });
  }
  updateCombatModeUI();
}

function updateCombatModeUI() {
  const badge = document.querySelector("[data-combat-mode]");
  if (!badge) return;
  badge.classList.toggle("active", state.combatMode);
  badge.textContent = state.combatMode ? "Combat" : "Normal";
}

function getCombatAttackInput(code) {
  return COMBAT_ATTACK_INPUTS[code] ?? null;
}

function resolveCombatAttackActionName(direction) {
  // Placeholder for character attack specialty selection. Future character stats,
  // martial arts, and enemy-type logic can choose a different action here.
  return COMBAT_ATTACK_ACTION_BY_DIRECTION[direction] ?? null;
}

function requestCombatAttack(direction) {
  if (state.mode !== "game" || !state.combatMode) return;
  state.combatAttack.queuedDirection = direction;
  if (!state.combatAttack.active) {
    beginCombatAttack(direction);
  }
}

function beginCombatAttack(direction) {
  const actionName = resolveCombatAttackActionName(direction);
  const action = player?.actions[actionName];
  if (!action) return false;

  state.combatAttack.active = true;
  state.combatAttack.activeDirection = direction;
  state.combatAttack.activeActionName = actionName;
  state.combatAttack.queuedDirection = null;
  state.combatAttack.recoveryTimer = 0;

  configureAnimationAction(actionName, action);
  if (player.currentAction === action) {
    restartCharacterAction(player, actionName);
  } else {
    action.reset();
    player.desiredAction = action;
  }
  return true;
}

function restartCharacterAction(character, actionName) {
  const action = character.actions[actionName];
  if (!action) return;
  configureAnimationAction(actionName, action);
  action.enabled = true;
  action.paused = false;
  action.reset().play();
  character.desiredAction = action;
  character.currentAction = action;
}

function finishCombatAttack() {
  if (!state.combatAttack.active) return;
  state.combatAttack.active = false;
  state.combatAttack.activeDirection = null;
  state.combatAttack.activeActionName = null;
  state.combatAttack.queuedDirection = null;
  state.combatAttack.recoveryTimer = COMBAT_ATTACK_RECOVERY_DURATION;
}

function cancelCombatAttack({ clearKeys = false } = {}) {
  state.combatAttack.active = false;
  state.combatAttack.activeDirection = null;
  state.combatAttack.activeActionName = null;
  state.combatAttack.queuedDirection = null;
  state.combatAttack.recoveryTimer = 0;
  if (clearKeys) {
    COMBAT_ATTACK_DIRECTIONS.forEach((direction) => {
      state.combatAttack.keys[direction] = false;
    });
  }
}

function getHeldCombatAttackDirection(preferredDirection = null) {
  const keys = state.combatAttack.keys;
  if (preferredDirection && keys[preferredDirection]) return preferredDirection;
  const queuedDirection = state.combatAttack.queuedDirection;
  if (queuedDirection && keys[queuedDirection]) return queuedDirection;
  return COMBAT_ATTACK_DIRECTIONS.find((direction) => keys[direction]) ?? null;
}

function isCombatAttackAction(actionName) {
  return COMBAT_ATTACK_ACTION_NAMES.has(actionName);
}

function isCombatAttackComplete(actionName, action) {
  const clip = animations[actionName];
  if (!clip || !action) return true;
  return action.paused || action.time >= Math.max(0, clip.duration - 0.035);
}

function updateCombatAttackState() {
  if (state.mode !== "game" || !state.combatMode) {
    cancelCombatAttack();
    return null;
  }

  const attack = state.combatAttack;
  if (!attack.active) {
    const heldDirection = getHeldCombatAttackDirection();
    if (heldDirection) beginCombatAttack(heldDirection);
    return attack.activeActionName;
  }

  const actionName = attack.activeActionName;
  const action = player?.actions[actionName];
  if (!action) {
    finishCombatAttack();
    return null;
  }

  player.desiredAction = action;
  if (player.currentAction !== action || !isCombatAttackComplete(actionName, action)) {
    return actionName;
  }

  const nextDirection = getHeldCombatAttackDirection(attack.activeDirection);
  if (nextDirection) {
    beginCombatAttack(nextDirection);
    return state.combatAttack.activeActionName;
  }

  finishCombatAttack();
  return null;
}

function consumeCombatRecoveryControlScale(delta) {
  const attack = state.combatAttack;
  if (attack.recoveryTimer <= 0) return 1;
  const scale = 1 - attack.recoveryTimer / COMBAT_ATTACK_RECOVERY_DURATION;
  attack.recoveryTimer = Math.max(0, attack.recoveryTimer - delta);
  return THREE.MathUtils.clamp(scale, 0, 1);
}

function bindInput() {
  document.querySelectorAll("[data-choice]").forEach((button) => {
    button.addEventListener("click", () => chooseGender(button.dataset.choice));
  });

  window.addEventListener("keydown", (event) => {
    if (event.code === "Tab" && !event.repeat) {
      event.preventDefault();
      toggleCombatMode();
    }
    const attackInput = getCombatAttackInput(event.code);
    if (attackInput) {
      if (state.mode === "game" && state.combatMode) {
        event.preventDefault();
        state.combatAttack.keys[attackInput.direction] = true;
        if (!event.repeat) requestCombatAttack(attackInput.direction);
      }
      return;
    }
    if (event.code === "Space") state.keys.forward = true;
    if (event.code === "ArrowLeft") state.keys.left = true;
    if (event.code === "ArrowRight") state.keys.right = true;
    if (event.code === "Digit1") chooseGender("male");
    if (event.code === "Digit2") chooseGender("female");
  });

  window.addEventListener("keyup", (event) => {
    const attackInput = getCombatAttackInput(event.code);
    if (attackInput) {
      state.combatAttack.keys[attackInput.direction] = false;
      if (state.combatAttack.queuedDirection === attackInput.direction) {
        state.combatAttack.queuedDirection = getHeldCombatAttackDirection();
      }
      if (state.mode === "game" && state.combatMode) event.preventDefault();
      return;
    }
    if (event.code === "Space") state.keys.forward = false;
    if (event.code === "ArrowLeft") state.keys.left = false;
    if (event.code === "ArrowRight") state.keys.right = false;
  });

  window.addEventListener("resize", resize);
}

function updateRootFilterButtons() {
  document.querySelectorAll("[data-root-filter]").forEach((button) => {
    const key = button.dataset.rootFilter;
    const filtered = state.rootFilters[key];
    button.classList.toggle("active", !filtered);
    button.textContent = key === "translation"
      ? `Root Pos ${filtered ? "Block" : "Pass"}`
      : `Root Rot ${filtered ? "Block" : "Pass"}`;
  });
}

function update(time) {
  const delta = Math.min(clock.getDelta(), 0.05);

  campfireLight.intensity = 7.8 + Math.sin(time * 0.01) * 1.2 + seededNoise(Math.floor(time * 0.04), 2) * 0.8;
  scene.traverse((obj) => {
    if (obj.name === "VoxelFlame") {
      obj.scale.y = 0.85 + Math.sin(time * 0.006 + obj.position.x * 7) * 0.12;
    }
  });

  Object.values(characters ?? {}).forEach((character) => {
    if (!character.active || !character.root.visible) return;

    // 1. 先更新 Mixer 产生关键帧动画数据
    character.mixer.update(delta);
    if (character.rootMotionBlendOut > 0) {
      character.rootMotionBlendOut = Math.max(0, character.rootMotionBlendOut - delta);
    }

    // 2. 根骨骼位移/自转提取（Root Motion Extraction）
    const skeletonRoot = character.scene.getObjectByName(ROOT_TRACK_NAME);
    const activeAction = character.currentAction;
    const actionName = getActionName(character, activeAction);
    const clip = animations[actionName];
    const config = motionConfig[actionName] || { motionMode: "InPlace" };
    const applyRootRotation = config.applyRootRotation !== false;

    if (skeletonRoot && config.motionMode === "RootMotion" && clip) {
      const currTime = activeAction.time;
      const prevTime = character.rootMotionState.prevTime;
      const rootMotionSample = sampleClipRootMotion(clip, currTime);
      const currPos = rootMotionSample.position;
      const currRot = rootMotionSample.quaternion;
      
      const deltaPos = new THREE.Vector3();
      const deltaRot = new THREE.Quaternion();
      
      const cycleData = calculateClipRootCycle(clip);
      
      if (currTime >= prevTime) {
        // 普通正常连续帧：计算当前与上帧之间的差值
        deltaPos.subVectors(currPos, character.rootMotionState.prevPosition);
        deltaRot.copy(character.rootMotionState.prevQuaternion).invert().premultiply(currRot);
      } else {
        // 循环重置跨边界：位移增量 = (末帧 - 上帧) + (当前帧 - 首帧)
        const toEndPos = new THREE.Vector3().subVectors(cycleData.endPosition, character.rootMotionState.prevPosition);
        const fromStartPos = new THREE.Vector3().subVectors(currPos, cycleData.startPosition);
        deltaPos.addVectors(toEndPos, fromStartPos);
        
        // 循环重置跨边界：旋转增量 = (上帧^-1 * 末帧) * (首帧^-1 * 当前帧)
        const toEndRot = new THREE.Quaternion().copy(character.rootMotionState.prevQuaternion).invert().premultiply(cycleData.endRotation);
        const fromStartRot = new THREE.Quaternion().copy(cycleData.startRotation).invert().premultiply(currRot);
        deltaRot.copy(toEndRot).premultiply(fromStartRot);
      }
      if (!applyRootRotation) {
        deltaRot.identity();
      }
      
      // 物理应用旋转与位移（在角色父级组级别）
      // 先将旋转增量从 Root 骨骼局部空间共轭变换到世界空间，然后提取 Yaw
      if (applyRootRotation) {
        character.root.updateMatrixWorld(true);
        const parentWorldQuat = new THREE.Quaternion().setFromRotationMatrix(character.scene.matrixWorld);
        const worldDeltaRot = new THREE.Quaternion()
          .copy(parentWorldQuat)
          .multiply(deltaRot)
          .multiply(parentWorldQuat.clone().invert());
        const euler = new THREE.Euler().setFromQuaternion(worldDeltaRot, "YXZ");
        const yawDeltaRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), euler.y);
        character.root.quaternion.multiply(yawDeltaRot);
      }
      
      // 锁定垂直方向位移，防止人物在平坦地面上因数值精度走着走着飘起或下沉
      deltaPos.y = 0;
      
      // RootMotion 位移仍使用动画步幅，但世界方向可由配置切到角色前向。
      // 这样 visualYawOffset 只修正外观姿态，不会把物理移动方向带歪。
      const deltaPosWorld = getRootMotionDeltaWorld(actionName, character, deltaPos);
      const nextPos = character.root.position.clone().add(deltaPosWorld);
      
      // 碰撞判定检测
      if (canMoveTo(nextPos)) {
        character.root.position.copy(nextPos);
      }
      
      // 保存本次状态作为下一帧的基准
      character.rootMotionState.prevTime = currTime;
      character.rootMotionState.prevPosition.copy(currPos);
      character.rootMotionState.prevQuaternion.copy(currRot);
      
      // RootMotion 只抽取线性前进量；骨架 Root 以切入动作前的姿态为锚点，避免 walk/idle 的 Root 首帧偏移造成网格瞬移。
      const rootPose = getDetrendedRootPose(clip, currTime, config);
      const rootPoseStart = getDetrendedRootPose(clip, 0, config);
      const rootPosePosition = character.rootMotionState.poseAnchor
        .clone()
        .add(rootPose)
        .sub(rootPoseStart);
      rootPosePosition.y = rootPose.y;
      skeletonRoot.position.copy(rootPosePosition);
      const rootPoseAnchorQuaternion = getRootPoseRotationAnchorQuaternion(
        clip,
        config,
        character.rootMotionState.poseAnchorQuaternion,
      );
      skeletonRoot.quaternion.copy(
        getRootPoseQuaternion(clip, currTime, config, rootPoseAnchorQuaternion),
      );
    } else if (skeletonRoot) {
      // In-Place 原地模式：保留 Root 骨骼的去趋势后摆动数据，不在运行时覆盖
      // Root 摆动驱动角色重心左右偏移与上下起伏，是脚步贴地的核心依据
      // 叠加晃动的消减已在 filterAnimationTracks 中通过 rootSwayScale 轨道预处理完成
      if (character.rootMotionBlendOut > 0) {
        const targetPose = clip
          ? getDetrendedRootPose(clip, activeAction.time, config)
          : character.rootRestPosition;
        const targetQuaternion = getInPlaceRootPoseQuaternion(
          clip,
          activeAction.time,
          config,
          character.rootRestQuaternion,
        );
        const blendProgress = 1 - (character.rootMotionBlendOut / ROOT_MOTION_BLEND_OUT_GRACE);
        skeletonRoot.position
          .copy(character.rootMotionState.poseAnchor)
          .lerp(targetPose, smoothstep(THREE.MathUtils.clamp(blendProgress, 0, 1)));
        skeletonRoot.quaternion
          .copy(character.rootMotionState.poseAnchorQuaternion)
          .slerp(targetQuaternion, smoothstep(THREE.MathUtils.clamp(blendProgress, 0, 1)));
      } else if (config.motionMode === "InPlace" && config.bakeIntoPoseRotation !== false) {
        skeletonRoot.quaternion.copy(character.rootRestQuaternion);
      }
    }

    // 3. 更新过渡混合
    updateAction(character, character.desiredAction, delta);
    updateVisualYawOffset(character, delta);
    updateConfiguredFootLock(character, delta);
  });

  if (state.mode === "transition") {
    state.transition += delta * SELECT_TRANSITION_SPEED;
    const t = smoothstep(Math.min(state.transition, 1));
    const other = characters[state.selectedGender === "male" ? "female" : "male"];
    other.root.visible = t < 0.97;
    other.root.scale.setScalar(1 - t * 0.75);
    campfireLight.intensity *= 1 - t * 0.35;
    cameraTarget.lerp(new THREE.Vector3(player.root.position.x, 1, player.root.position.z), t * 0.08);
    if (state.transition >= 1) enterWorld();
  }

  if (state.mode === "game") {
    updatePlayer(delta);
    cameraTarget.lerp(new THREE.Vector3(player.root.position.x, 1.05, player.root.position.z), 1 - Math.exp(-CAMERA_LERP * delta));
  }

  // Bake Into Pose 去趋势后，动画自身的脚步放置已经正确（动画师设计的重心摆动与脚步是配合的），
  // 不再需要 applyFootLock 额外补偿（Foot Lock 与去趋势振荡互相拉锯会产生抖动）。
  // applyFootLock 仅保留用于未来可能的 IK 脚底贴地修正。

  updateRootMarker();
  updateFacingMarker();
  updateCamera(delta);
  window.__DEMO_STATE = getDebugState();
  renderer.render(scene, camera);
}

function updateRootMarker() {
  rootMarker.visible = !!player && player.root.visible;
  if (!rootMarker.visible) return;

  const skeletonRoot = player.scene.getObjectByName(ROOT_TRACK_NAME);
  const position = skeletonRoot
    ? skeletonRoot.getWorldPosition(rootMarkerWorldPosition)
    : player.root.getWorldPosition(rootMarkerWorldPosition);
  rootMarker.position.set(position.x, 0.01, position.z);
}

function updateFacingMarker() {
  facingMarker.visible = !!player && player.root.visible;
  if (!facingMarker.visible) return;

  player.root.getWorldPosition(facingMarkerWorldPosition);
  facingMarker.position.set(facingMarkerWorldPosition.x, 0.035, facingMarkerWorldPosition.z);
  facingMarker.rotation.set(0, player.root.rotation.y, 0);
}

function updateConfiguredFootLock(character, delta) {
  const actionName = getActionName(character, character.currentAction);
  const config = motionConfig[actionName] || {};
  if (character.footLock.cooldown > 0 || character.rootMotionBlendOut > 0) {
    character.footLock.cooldown = Math.max(0, character.footLock.cooldown - delta);
    character.footLock.boneName = null;
    character.footLock.anchors.clear();
    return;
  }
  if (!config.footLock) {
    character.footLock.boneName = null;
    character.footLock.anchors.clear();
    return;
  }
  applyFootLock(character, config);
}

function applyFootLock(character, config = {}) {
  if (!character.active || !character.root.visible) return;

  character.root.updateMatrixWorld(true);
  const contactY = config.footLockContactY ?? FOOT_LOCK_CONTACT_Y;
  const releaseY = config.footLockReleaseY ?? FOOT_LOCK_RELEASE_Y;
  const strength = config.footLockStrength ?? 1;
  const contacts = FOOT_LOCK_BONES
    .map((boneName) => {
      const bone = character.scene.getObjectByName(boneName);
      if (!bone) return null;
      return {
        boneName,
        position: bone.getWorldPosition(new THREE.Vector3()),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.position.y - b.position.y);

  if (!contacts.length) return;

  const contactByBone = new Map(contacts.map((contact) => [contact.boneName, contact]));
  for (const [boneName] of character.footLock.anchors) {
    const contact = contactByBone.get(boneName);
    if (!contact || contact.position.y > releaseY) {
      character.footLock.anchors.delete(boneName);
    }
  }

  contacts.forEach((contact) => {
    if (contact.position.y <= contactY && !character.footLock.anchors.has(contact.boneName)) {
      character.footLock.anchors.set(contact.boneName, contact.position.clone());
    }
  });

  const correction = new THREE.Vector3();
  let lockedCount = 0;
  for (const [boneName, anchor] of character.footLock.anchors) {
    const contact = contactByBone.get(boneName);
    if (!contact || contact.position.y > releaseY) continue;
    correction.x += anchor.x - contact.position.x;
    correction.z += anchor.z - contact.position.z;
    lockedCount += 1;
  }
  if (!lockedCount) return;

  correction.multiplyScalar(strength / lockedCount);
  if (correction.lengthSq() <= 0.0000001) return;

  const nextPosition = character.root.position.clone().add(correction);
  if (state.mode !== "game" || canMoveTo(nextPosition)) {
    character.root.position.copy(nextPosition);
  }
  character.root.updateMatrixWorld(true);
}

function getDebugState() {
  const debugActionName = player
    ? (getActionName(player, player.desiredAction) ?? getActionName(player, player.currentAction))
    : null;
  return {
    objectCount: scene.children.length,
    cameraPosition: camera.position.toArray(),
    cameraTarget: cameraTarget.toArray(),
    markerPosition: diagnosticMarker.position.toArray(),
    markerVisible: diagnosticMarker.visible && diagnosticMarker.parent !== null,
    rootMarkerPosition: rootMarker.position.toArray(),
    rootMarkerVisible: rootMarker.visible,
    facingMarkerPosition: facingMarker.position.toArray(),
    facingMarkerRotationY: facingMarker.rotation.y,
    facingMarkerVisible: facingMarker.visible,
    combatMode: state.combatMode,
    combatAttackActive: state.combatAttack.active,
    combatAttackDirection: state.combatAttack.activeDirection,
    combatAttackAction: state.combatAttack.activeActionName,
    combatAttackQueuedDirection: state.combatAttack.queuedDirection,
    combatAttackKeys: { ...state.combatAttack.keys },
    combatAttackRecoveryTimer: state.combatAttack.recoveryTimer,
    currentAction: player ? getActionName(player, player.currentAction) : null,
    desiredAction: debugActionName,
    visualYawOffsetDegrees: player
      ? THREE.MathUtils.radToDeg(player.visualYawOffset)
      : 0,
    targetVisualYawOffsetDegrees: debugActionName
      ? (motionConfig[debugActionName]?.visualYawOffsetDegrees ?? 0)
      : 0,
    codeMoveDirection: player && debugActionName
      ? getConfiguredCodeMoveDirection(debugActionName, player).toArray()
      : null,
    motionMode: debugActionName ? (motionConfig[debugActionName]?.motionMode ?? "InPlace") : null,
    rootMotionMoveBasis: debugActionName ? (motionConfig[debugActionName]?.rootMotionMoveBasis ?? null) : null,
    rootMotionForwardOnly: !!(debugActionName && motionConfig[debugActionName]?.rootMotionForwardOnly),
    codeMoveSpeed: debugActionName ? getConfiguredCodeMoveSpeed(debugActionName) : PLAYER_SPEED,
    footLockEnabled: !!(debugActionName && motionConfig[debugActionName]?.footLock),
    footLockAnchors: player ? Array.from(player.footLock.anchors.keys()) : [],
    footLockCooldown: player ? player.footLock.cooldown : 0,
    rootMotionBlendOut: player ? player.rootMotionBlendOut : 0,
    rootMotionPoseAnchor: player ? player.rootMotionState.poseAnchor.toArray() : null,
    rootPoseRotation: !!(debugActionName && motionConfig[debugActionName]?.rootPoseRotation),
    rootPoseRotationAnchor: debugActionName ? (motionConfig[debugActionName]?.rootPoseRotationAnchor ?? "entryPose") : null,
    rootFilters: { ...state.rootFilters },
    characterBounds: characters
      ? Object.fromEntries(Object.entries(characters).map(([key, character]) => {
        const box = new THREE.Box3().setFromObject(character.root);
        return [key, { min: box.min.toArray(), max: box.max.toArray() }];
      }))
      : null,
    selectionChildren: selectionSet?.children.length ?? 0,
    rendererSize: renderer ? renderer.getDrawingBufferSize(new THREE.Vector2()).toArray() : null,
  };
}

function updatePlayer(delta) {
  const attackActionName = updateCombatAttackState();
  if (attackActionName) {
    if (player.actions.walk) player.actions.walk.timeScale = 1.0;
    if (player.actions.combatWalk) player.actions.combatWalk.timeScale = 1.0;
    return;
  }

  const controlScale = consumeCombatRecoveryControlScale(delta);
  const moving = state.keys.forward;
  const turningLeft = state.keys.left && !state.keys.right;
  const turningRight = state.keys.right && !state.keys.left;
  const locomotion = state.combatMode
    ? {
        idle: player.actions.combatIdle,
        walk: player.actions.combatWalk,
        turnLeft: player.actions.combatTurnLeft,
        turnRight: player.actions.combatTurnRight,
      }
    : {
        idle: player.actions.idle,
        walk: player.actions.walk,
        turnLeft: player.actions.turnLeft,
        turnRight: player.actions.turnRight,
      };
  const nextAction = moving
    ? locomotion.walk
    : turningLeft
      ? locomotion.turnLeft
      : turningRight
        ? locomotion.turnRight
        : locomotion.idle;
  const nextActionName = getActionName(player, nextAction) || "idle";
  const config = motionConfig[nextActionName] || { motionMode: "InPlace" };
  const moveSpeed = getConfiguredCodeMoveSpeed(nextActionName);
  const isTurningAction = nextActionName === "turnLeft"
    || nextActionName === "turnRight"
    || nextActionName === "combatTurnLeft"
    || nextActionName === "combatTurnRight";
  const useRootRotation = isTurningAction && config.motionMode === "RootMotion";

  if (!useRootRotation) {
    const turn = (state.keys.left ? 1 : 0) - (state.keys.right ? 1 : 0);
    player.root.rotation.y += turn * TURN_SPEED * controlScale * delta;
  }

  player.desiredAction = nextAction;

  if (player.actions.walk && nextAction !== player.actions.walk) player.actions.walk.timeScale = 1.0;
  if (player.actions.combatWalk && nextAction !== player.actions.combatWalk) player.actions.combatWalk.timeScale = 1.0;
  if (isTurningAction) nextAction.timeScale = controlScale < 1 ? controlScale : 1.0;

  if (!moving) return;
  const effectiveMoveSpeed = moveSpeed * controlScale;

  // 位移判定：若动作是 Root Motion 模式，则位移完全由 Root Motion 动画位移增量驱动世界坐标，屏蔽代码位移
  if (config.motionMode === "RootMotion") {
    if (hasConfiguredCodeMoveSpeed(nextActionName)) {
      const naturalSpeed = computeAnimNaturalSpeed(nextActionName, player);
      if (naturalSpeed > 0.1) {
        const targetScale = moveSpeed / naturalSpeed;
        nextAction.timeScale = THREE.MathUtils.clamp(targetScale * controlScale, 0, 3.0);
      } else {
        nextAction.timeScale = controlScale < 1 ? controlScale : 1.0;
      }
    }
    return;
  }

  // InPlace 模式：代码驱动世界坐标位移
  // 通过 timeScale 步速匹配，使动画播放速率与代码移动速度同步，消除脚底打滑
  const naturalSpeed = computeAnimNaturalSpeed(nextActionName, player);
  if (naturalSpeed > 0.1) {
    const targetScale = effectiveMoveSpeed / naturalSpeed;
    nextAction.timeScale = THREE.MathUtils.clamp(targetScale, 0, 3.0);
    console.log(`[SpeedMatch] ${nextActionName} naturalSpeed: ${naturalSpeed.toFixed(4)}, clamped timeScale: ${nextAction.timeScale.toFixed(4)}`);
  } else {
    // 针对极低水平位移的动画（如原地醉酒摆动），不进行大幅度步速匹配，恢复 1.0 倍速，防止除以近零值产生时值狂闪
    nextAction.timeScale = controlScale < 1 ? controlScale : 1.0;
    console.log(`[SpeedMatch] ${nextActionName} low naturalSpeed (${naturalSpeed.toFixed(4)}), default to timeScale 1.0`);
  }

  const forward = getConfiguredCodeMoveDirection(nextActionName, player);
  const next = player.root.position.clone().addScaledVector(forward, effectiveMoveSpeed * delta);
  if (canMoveTo(next)) {
    player.root.position.copy(next);
  }
}

function canMoveTo(position) {
  const bounds = new THREE.Box2(
    new THREE.Vector2(position.x - 0.45, position.z - 0.45),
    new THREE.Vector2(position.x + 0.45, position.z + 0.45),
  );
  if (Math.abs(position.x) > WORLD_SIZE * TILE_SIZE || Math.abs(position.z) > WORLD_SIZE * TILE_SIZE) return false;
  return !obstacles.some((obstacle) => obstacle.intersectsBox(bounds));
}

function getActionTransitionDuration(currentActionName, nextActionName) {
  if (isCombatAttackAction(currentActionName) && !isCombatAttackAction(nextActionName)) {
    return COMBAT_ATTACK_RECOVERY_DURATION;
  }
  return ACTION_FADE_DURATION;
}

function updateAction(character, nextAction) {
  if (!nextAction || character.currentAction === nextAction) return;
  const currentActionName = getActionName(character, character.currentAction);
  const nextActionName = getActionName(character, nextAction);
  const transitionDuration = getActionTransitionDuration(currentActionName, nextActionName);
  const currentMotionMode = getMotionMode(currentActionName);
  const nextMotionMode = getMotionMode(nextActionName);
  const skeletonRoot = character.scene.getObjectByName(ROOT_TRACK_NAME);
  const poseAnchor = skeletonRoot ? skeletonRoot.position.clone() : character.rootRestPosition.clone();
  const poseAnchorQuaternion = skeletonRoot
    ? skeletonRoot.quaternion.clone()
    : character.rootRestQuaternion.clone();

  if (currentMotionMode === "RootMotion" && nextMotionMode !== "RootMotion") {
    character.rootMotionBlendOut = Math.max(character.rootMotionBlendOut, ROOT_MOTION_BLEND_OUT_GRACE);
  }

  nextAction.enabled = true;
  nextAction.reset().fadeIn(transitionDuration).play();
  character.currentAction.fadeOut(transitionDuration);
  character.currentAction = nextAction;

  // 在动作发生切换时，立刻重置根骨骼跟踪状态，确保提取 Root Motion 增量时不产生错误的跨边界巨大跳跃（杜绝人物闪现狂闪）
  if (skeletonRoot) {
    character.rootMotionState.prevTime = nextAction.time;
    const nextClip = animations[nextActionName];
    if (nextMotionMode === "RootMotion" && nextClip) {
      const sample = sampleClipRootMotion(nextClip, nextAction.time);
      character.rootMotionState.prevPosition.copy(sample.position);
      character.rootMotionState.prevQuaternion.copy(sample.quaternion);
      character.rootMotionState.poseAnchor.copy(poseAnchor);
      character.rootMotionState.poseAnchorQuaternion.copy(poseAnchorQuaternion);
    } else {
      character.rootMotionState.prevPosition.copy(skeletonRoot.position);
      character.rootMotionState.prevQuaternion.copy(skeletonRoot.quaternion);
      character.rootMotionState.poseAnchor.copy(skeletonRoot.position);
      character.rootMotionState.poseAnchorQuaternion.copy(skeletonRoot.quaternion);
    }
  }
  character.footLock.boneName = null;
  character.footLock.anchors.clear();
  character.footLock.cooldown = Math.max(character.footLock.cooldown, ROOT_MOTION_BLEND_OUT_GRACE);
}

function updateCamera(delta) {
  const aspect = window.innerWidth / window.innerHeight;
  const frustumHeight = state.mode === "select" ? 10.5 : 12.5;
  camera.left = (frustumHeight * aspect) / -2;
  camera.right = (frustumHeight * aspect) / 2;
  camera.top = frustumHeight / 2;
  camera.bottom = frustumHeight / -2;
  camera.updateProjectionMatrix();

  const desiredPosition = cameraTarget.clone().add(cameraOffset);
  const factor = delta >= 1 ? 1 : 1 - Math.exp(-CAMERA_LERP * delta);
  camera.position.lerp(desiredPosition, factor);
  camera.lookAt(cameraTarget);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function resize() {
  renderer?.setSize(window.innerWidth, window.innerHeight);
  updateCamera(1);
}

function setRendererBadge(text, ok) {
  const badge = document.querySelector("[data-renderer]");
  badge.textContent = text;
  badge.classList.toggle("bad", !ok);
}
