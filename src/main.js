import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createFacingMarker } from "./facing-marker.js";
import { createSafeRenderer, getRendererBackendLabel } from "./renderer-utils.js";
import * as combatCollision from "./combat-collision-utils.js";
import { evaluateNpcBrain } from "./npc-ai-runtime.js";
import {
  COMBAT_MOVE_DIRECTIONS,
  DEFAULT_COMBAT_MOVE_MANAGER,
  chooseWeightedCombatMove,
  getAllCombatMoves,
  getCombatMoveActionNames,
  getCombatMovesForDirection,
  inferAnimationFileForActionName,
  normalizeCombatMoveManager,
} from "./combat-move-manager.js";
import "./styles.css";

const ASSET_VERSION = "move-manager-20260603-01";
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
const COMBAT_COLLIDER_DEBUG_HIT_TTL = 0.9;
const COMBAT_COLLIDER_DEBUG_MAX_HITS = 12;
const COMBAT_ATTACK_INPUTS = Object.fromEntries(
  COMBAT_MOVE_DIRECTIONS.map((direction) => [direction.inputCode, { direction: direction.id }]),
);
const COMBAT_ATTACK_DIRECTIONS = COMBAT_MOVE_DIRECTIONS.map((direction) => direction.id);
const DEFAULT_MODEL_CONFIG = { version: 1, models: {} };
const RUNTIME_NPC_NAME = "ONE";
const PLAYER_DEFAULT_FACTION = 0;
const PLAYER_DEFAULT_ATTRIBUTES = {
  name: "Player",
  willpower: 10,
  health: 100,
  stamina: 100,
  strength: 10,
  agility: 10,
  reaction: 10,
};
const NPC_SPAWN_OFFSET = new THREE.Vector3(2.4, 0, 1.2);
const NPC_RANDOM_REACH_DISTANCE = 0.35;
const NPC_ATTACK_RANGE = 1.45;
const NPC_ATTACK_COOLDOWN = 1.2;
const DEFAULT_LOCK_TURN_SPEED = TURN_SPEED;
const DEFAULT_ATTACK_ARC_DEGREES = 20;
const DEFAULT_ATTACK_DISTANCE = NPC_ATTACK_RANGE;
const COLLIDER_LOCAL_CORNERS = [
  [-0.5, -0.5, -0.5],
  [-0.5, -0.5, 0.5],
  [-0.5, 0.5, -0.5],
  [-0.5, 0.5, 0.5],
  [0.5, -0.5, -0.5],
  [0.5, -0.5, 0.5],
  [0.5, 0.5, -0.5],
  [0.5, 0.5, 0.5],
].map((point) => new THREE.Vector3(...point));
const DEFAULT_MODE_SWITCH_CONFIGS = {
  default: { minDurationMs: 0, stableDurationMs: 0, lostTargetGraceMs: 0, interruptibleBy: ["alert", "attack", "flee"] },
  alert: { minDurationMs: 1200, stableDurationMs: 700, lostTargetGraceMs: 1200, interruptibleBy: ["attack", "flee"] },
  attack: { minDurationMs: 1600, stableDurationMs: 900, lostTargetGraceMs: 1500, interruptibleBy: ["flee"] },
  flee: { minDurationMs: 2500, stableDurationMs: 1000, lostTargetGraceMs: 1200, interruptibleBy: [] },
  custom: { minDurationMs: 1200, stableDurationMs: 800, lostTargetGraceMs: 1200, interruptibleBy: ["attack", "flee"] },
};

function createCombatAttackState() {
  return {
    keys: {
      forward: false,
      left: false,
      right: false,
    },
    active: false,
    activeDirection: null,
    activeActionName: null,
    activeActionFile: null,
    activeMoveId: null,
    activeMoveName: null,
    activeStrength: 1,
    queuedDirection: null,
    recoveryTimer: 0,
    aiCooldown: 0,
    hitKeys: new Set(),
  };
}

function createHitReactionState() {
  return {
    active: false,
    timer: 0,
    actionName: null,
    sourceId: null,
  };
}

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
      <div class="badge" data-combat-collider-debug>HitBox H: Off</div>
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
  debugCombatColliders: false,
  combatAttack: createCombatAttackState(),
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

const combatColliderDebug = createCombatColliderDebugState();
scene.add(combatColliderDebug.group);

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
let modelConfig = DEFAULT_MODEL_CONFIG;
let combatMoveManager = normalizeCombatMoveManager(DEFAULT_COMBAT_MOVE_MANAGER);
let combatAttackActionNames = new Set(getCombatMoveActionNames(combatMoveManager));
let selectionSet;
let worldSet;
let player;
let runtimeNpcs = [];
let runtimeNpcLoadPromise = null;
let obstacles = [];
const rootMarkerWorldPosition = new THREE.Vector3();
const facingMarkerWorldPosition = new THREE.Vector3();

boot();

async function boot() {
  try {
    renderer = await createSafeRenderer(THREE, { antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;

    app.appendChild(renderer.domElement);
    setRendererBadge(getRendererBackendLabel(renderer), true);

    try {
      const configResponse = await fetch(assetUrl("./assets/animations/motion_config.json"));
      motionConfig = await configResponse.json();
      console.log("motion_config loaded:", motionConfig);
      if (motionConfig.walk && motionConfig.walk.motionMode) {
        state.globalMotionMode = motionConfig.walk.motionMode;
      }
    } catch (e) {
      console.warn("Failed to load motion_config.json; using fallback config.", e);
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
        combat_Att_F_Hand_1_Ro: { motionMode: "RootMotion", loop: false, bakeIntoPoseXZ: false, bakeIntoPoseY: true, bakeIntoPoseRotation: true, rootSwayScale: 1.5, applyRootRotation: false, rootPoseRotation: true, rootPoseRotationAnchor: "clipStart", rootMotionMoveBasis: "characterForward" },
        combat_Att_F_Hand_2: { motionMode: "InPlace", loop: false, bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: false, rootSwayScale: 1.5 },
        combat_Att_LB_Hand_0: { motionMode: "InPlace", loop: false, bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: false, rootSwayScale: 1 },
        combat_Att_RB_Hand_0: { motionMode: "InPlace", loop: false, bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: false, rootSwayScale: 1 },
      };
    }

    combatMoveManager = await loadCombatMoveManager();
    modelConfig = await loadModelConfig();
    registerCombatMoveAnimationAssets();
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
    updateCombatColliderDebugUI();
    resize();
    renderer.render(scene, camera);
    await renderer.setAnimationLoop(update);
  } catch (error) {
    console.error(error);
    window.__DEMO_ERROR = error.message;
    setRendererBadge("Renderer unavailable", false);
    document.querySelector("[data-panel]").innerHTML = `<div class="title">Renderer init failed</div><p>${error.message}</p>`;
  }
}

async function loadAnimations() {
  const entries = await Promise.all(
    Object.entries(ASSETS.animations).map(async ([name, url]) => {
      const gltf = await loader.loadAsync(url);
      return [name, mergeAnimationClips(gltf.animations, name)];
    }),
  );
  return Object.fromEntries(entries);
}

function mergeAnimationClips(clips, name) {
  const tracks = clips.flatMap((clip) => clip.tracks.map((track) => track.clone()));
  return new THREE.AnimationClip(name, -1, tracks);
}
async function loadCombatMoveManager() {
  try {
    const response = await fetch(assetUrl("./assets/combat/move_manager.json"), { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return normalizeCombatMoveManager(await response.json());
  } catch (error) {
    console.warn("Failed to load combat move manager; using default move pool.", error);
    return normalizeCombatMoveManager(DEFAULT_COMBAT_MOVE_MANAGER);
  }
}

async function loadModelConfig() {
  try {
    const response = await fetch(assetUrl("./assets/models/model_config.json"), { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return normalizeRuntimeModelConfig(await response.json());
  } catch (error) {
    console.warn("Failed to load model collider config; combat hit tests may be skipped.", error);
    return normalizeRuntimeModelConfig(DEFAULT_MODEL_CONFIG);
  }
}

function registerCombatMoveAnimationAssets() {
  combatMoveManager = normalizeCombatMoveManager(combatMoveManager);
  combatAttackActionNames = new Set(getCombatMoveActionNames(combatMoveManager));
  getAllCombatMoves(combatMoveManager).forEach((move) => {
    registerAnimationAssetForActionName(move.actionName, move.actionFile);
    const hitActionName = move.impact?.hitstun?.hitActionName;
    if (hitActionName) registerAnimationAssetForActionName(hitActionName);
  });
}

function registerAnimationAssetForActionName(actionName, explicitFile = "") {
  if (!actionName || ASSETS.animations[actionName]) return;
  const fileName = explicitFile || inferAnimationFileForActionName(actionName, [], motionConfig);
  if (!fileName) return;
  ASSETS.animations[actionName] = assetUrl(`./assets/animations/${fileName}`);
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

function inferModelConfigId(gender, url = "") {
  const key = String(gender || "").toLowerCase();
  const asset = String(url || "").toLowerCase();
  if (key.includes("female") || asset.includes("sk_basefemale")) return "SK_BaseFemale";
  return "SK_BaseMale";
}

function normalizeRuntimeModelConfig(config = {}) {
  return combatCollision.normalizeRuntimeModelConfig(config, { characterHeight: CHARACTER_HEIGHT });
}

function normalizeRuntimeBaseCollider(value = {}) {
  return combatCollision.normalizeRuntimeBaseCollider(value, { characterHeight: CHARACTER_HEIGHT });
}

function normalizeRuntimePartCollider(value = {}) {
  return combatCollision.normalizeRuntimePartCollider(value);
}

function toRuntimeVectorArray(value, fallback) {
  return combatCollision.toRuntimeVectorArray(value, fallback);
}

function normalizeRuntimeNonNegativeNumber(value, fallback) {
  return combatCollision.normalizeRuntimeNonNegativeNumber(value, fallback);
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
  const modelConfigId = inferModelConfigId(gender, url);
  if (!DISABLE_ANIMATION) actions.idle.play();

  return {
    gender,
    modelConfigId,
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
    hitReaction: createHitReactionState(),
    lastCombatHit: null,
    active: true,
  };
}

function createCharacterActions(mixer, model) {
  const actions = Object.fromEntries(
    Object.entries(animations).map(([actionName, clip]) => [
      actionName,
      mixer.clipAction(filterAnimationTracks(clip, model)),
    ]),
  );
  Object.entries(actions).forEach(([actionName, action]) => configureAnimationAction(actionName, action));
  return actions;
}

function configureAnimationAction(actionName, action) {
  const config = motionConfig[actionName] || {};
  const playOnce = config.loop === false || isCombatAttackAction(actionName);
  action.clampWhenFinished = playOnce;
  action.setLoop(playOnce ? THREE.LoopOnce : THREE.LoopRepeat, playOnce ? 1 : Infinity);
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
  player.runtime = {
    id: "player",
    name: state.selectedGender === "female" ? "Female Player" : "Male Player",
    faction: PLAYER_DEFAULT_FACTION,
    attributes: { ...PLAYER_DEFAULT_ATTRIBUTES },
  };
  player.combatAttack = state.combatAttack;
  cameraTarget.set(0, 1, 0);
  spawnRuntimeNpcOneNearPlayer();
}

async function spawnRuntimeNpcOneNearPlayer() {
  if (!player || runtimeNpcLoadPromise || runtimeNpcs.some((npc) => isRuntimeNpcOne(npc.data))) return;
  runtimeNpcLoadPromise = (async () => {
    try {
      const npcData = await loadRuntimeNpcByName(RUNTIME_NPC_NAME);
      if (!npcData) {
        console.warn(`Runtime NPC "${RUNTIME_NPC_NAME}" not found.`);
        return;
      }

      const behaviorTree = npcData.behaviorTreeId
        ? await loadBehaviorTreeForRuntime(npcData.behaviorTreeId)
        : null;
      const modelUrl = getNpcModelUrl(npcData.modelType);
      const character = await createCharacter(`npc-${npcData.id || RUNTIME_NPC_NAME}`, modelUrl);
      character.root.name = `RuntimeNPC_${npcData.id || RUNTIME_NPC_NAME}`;
      character.runtime = {
        id: npcData.id || RUNTIME_NPC_NAME,
        name: npcData.attributes?.name || npcData.id || RUNTIME_NPC_NAME,
        faction: npcData.faction ?? 0,
        attributes: { ...PLAYER_DEFAULT_ATTRIBUTES, ...(npcData.attributes || {}) },
      };

      const spawnOffset = NPC_SPAWN_OFFSET.clone().applyAxisAngle(WORLD_UP, player.root.rotation.y);
      character.root.position.copy(player.root.position).add(spawnOffset);
      faceCharacterToward(character, player.root.position, 1, true);
      scene.add(character.root);
      characters[`npc-${character.runtime.id}`] = character;

      const runtimeNpc = {
        data: npcData,
        character,
        behaviorTree,
        vision: normalizeNpcVision(npcData.vision),
        moveSpeed: normalizeNpcMoveSpeed(npcData.moveSpeed),
        blackboard: {
          randomPosition: null,
          lookTarget: null,
          lockedTarget: null,
          targetAngleDeltaDegrees: null,
          targetDistance: null,
          activeAttackNodeId: null,
          selectedAttackMoveId: null,
        },
        ai: {
          tickTimer: 0,
          mode: behaviorTree?.brain?.fallbackMode || "default",
          candidateMode: behaviorTree?.brain?.fallbackMode || "default",
          pendingMode: null,
          pendingElapsed: 0,
          modeElapsed: 0,
          noVisibleTargetElapsed: 0,
          result: null,
          visibleTargets: [],
        },
        combatAttack: createCombatAttackState(),
        visionHelper: null,
        modeLabel: null,
      };
      character.combatAttack = runtimeNpc.combatAttack;
      runtimeNpc.visionHelper = createNpcVisionHelper(runtimeNpc.vision);
      character.root.add(runtimeNpc.visionHelper);
      runtimeNpc.modeLabel = createNpcModeLabel(runtimeNpc);
      scene.add(runtimeNpc.modeLabel.group);
      runtimeNpcs.push(runtimeNpc);
    } catch (error) {
      console.error("Failed to spawn runtime NPC:", error);
    } finally {
      runtimeNpcLoadPromise = null;
    }
  })();
  await runtimeNpcLoadPromise;
}

function isRuntimeNpcOne(npcData) {
  const name = String(npcData?.attributes?.name || npcData?.name || npcData?.id || "").toUpperCase();
  return name === RUNTIME_NPC_NAME;
}

async function loadRuntimeNpcByName(targetName) {
  try {
    const listData = await fetchJson("/api/npcs");
    const target = (listData.npcs || []).find((npc) => {
      const id = String(npc.id || "").toUpperCase();
      const name = String(npc.name || "").toUpperCase();
      return id === targetName || name === targetName;
    });
    if (target?.id) return fetchJson(`/api/npcs/${encodeURIComponent(target.id)}`);
  } catch (error) {
    console.warn("NPC API list unavailable, trying static NPC files.", error);
  }

  const staticCandidates = [
    `./assets/npcs/${targetName}.json`,
    `./assets/npcs/${targetName.toLowerCase()}.json`,
    `./assets/npcs/${targetName[0]}${targetName.slice(1).toLowerCase()}.json`,
  ];
  for (const url of staticCandidates) {
    try {
      const data = await fetchJson(url);
      if (isRuntimeNpcOne(data)) return data;
    } catch {
      // Try the next static candidate.
    }
  }
  return null;
}

async function loadBehaviorTreeForRuntime(treeId) {
  try {
    return await fetchJson(`/api/behavior-trees/${encodeURIComponent(treeId)}`);
  } catch {
    return fetchJson(`./assets/behavior-trees/${encodeURIComponent(treeId)}.json`);
  }
}

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url} ${resp.status}`);
  return resp.json();
}

function getNpcModelUrl(modelType) {
  return modelType === "BaseFemale" ? ASSETS.models.female : ASSETS.models.male;
}

function normalizeNpcVision(vision = {}) {
  return {
    distance: Number.isFinite(Number(vision.distance)) ? Number(vision.distance) : 15,
    angle: Number.isFinite(Number(vision.angle)) ? Number(vision.angle) : 120,
  };
}

function normalizeNpcMoveSpeed(moveSpeed = {}) {
  return {
    normal: Number.isFinite(Number(moveSpeed.normal)) ? Number(moveSpeed.normal) : PLAYER_SPEED,
    combat: Number.isFinite(Number(moveSpeed.combat)) ? Number(moveSpeed.combat) : 1.2,
  };
}

function createNpcVisionHelper(vision) {
  const group = new THREE.Group();
  group.name = "NPCVisionCone";
  const material = new THREE.LineBasicMaterial({
    color: 0x79f2d0,
    transparent: true,
    opacity: 0.8,
    depthTest: false,
  });
  const line = new THREE.LineSegments(new THREE.BufferGeometry(), material);
  line.renderOrder = 3;
  group.add(line);
  group.position.y = 0.045;
  updateNpcVisionHelperGeometry(group, vision);
  return group;
}

function updateNpcVisionHelperGeometry(group, vision) {
  const line = group.children[0];
  if (!line) return;
  const distance = Math.max(0.1, Number(vision.distance) || 15);
  const angle = THREE.MathUtils.degToRad(Math.max(1, Math.min(360, Number(vision.angle) || 120)));
  const half = angle / 2;
  const segments = 32;
  const points = [];
  let previous = null;

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const theta = -half + angle * t;
    const point = new THREE.Vector3(Math.sin(theta) * distance, 0, Math.cos(theta) * distance);
    if (previous) {
      points.push(previous.x, previous.y, previous.z, point.x, point.y, point.z);
    }
    if (i === 0 || i === segments || i % 8 === 0) {
      points.push(0, 0, 0, point.x, point.y, point.z);
    }
    previous = point;
  }

  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry();
  line.geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  group.userData.visionDistance = distance;
  group.userData.visionAngle = vision.angle;
}

function refreshNpcVisionHelper(runtimeNpc) {
  if (!runtimeNpc.visionHelper) return;
  const distanceChanged = runtimeNpc.visionHelper.userData.visionDistance !== runtimeNpc.vision.distance;
  const angleChanged = runtimeNpc.visionHelper.userData.visionAngle !== runtimeNpc.vision.angle;
  if (distanceChanged || angleChanged) {
    updateNpcVisionHelperGeometry(runtimeNpc.visionHelper, runtimeNpc.vision);
  }
  runtimeNpc.visionHelper.visible = state.mode === "game" && runtimeNpc.character.root.visible;
}

function createNpcModeLabel(runtimeNpc) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const group = new THREE.Group();
  group.name = "NPCModeLabel";
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.48), material);
  mesh.renderOrder = 4;
  group.add(mesh);
  group.renderOrder = 4;
  const label = {
    group,
    canvas,
    texture,
    lastText: "",
  };
  updateNpcModeLabelText(label, getNpcBehaviorModeLabel(runtimeNpc.ai.mode));
  updateNpcModeLabelTransform(runtimeNpc);
  return label;
}

function getNpcBehaviorModeLabel(mode) {
  const labels = {
    default: "默认",
    alert: "警惕",
    attack: "战斗",
    flee: "逃跑",
  };
  return labels[mode] || mode || "默认";
}

function updateNpcModeLabelText(label, text) {
  if (!label || label.lastText === text) return;
  label.lastText = text;
  const ctx = label.canvas.getContext("2d");
  ctx.clearRect(0, 0, label.canvas.width, label.canvas.height);
  ctx.fillStyle = "rgba(6, 14, 12, 0.78)";
  ctx.strokeStyle = "rgba(121, 242, 208, 0.95)";
  ctx.lineWidth = 6;
  roundRect(ctx, 18, 18, 476, 92, 22);
  ctx.fill();
  ctx.stroke();
  ctx.font = "700 46px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#eafbf5";
  ctx.fillText(text, 256, 64);
  label.texture.needsUpdate = true;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function updateNpcModeLabelTransform(runtimeNpc) {
  const label = runtimeNpc.modeLabel;
  if (!label) return;
  label.group.visible = state.mode === "game" && runtimeNpc.character.root.visible;
  if (!label.group.visible) return;
  label.group.position.copy(runtimeNpc.character.root.position);
  label.group.position.y += CHARACTER_HEIGHT + 0.55;
  label.group.quaternion.copy(camera.quaternion);
  updateNpcModeLabelText(label, getNpcBehaviorModeLabel(runtimeNpc.ai.mode));
}

function getCharacterForward(character) {
  return new THREE.Vector3(0, 0, 1)
    .applyAxisAngle(WORLD_UP, character.root.rotation.y)
    .normalize();
}

function getYawToPosition(character, targetPosition) {
  const direction = targetPosition.clone().sub(character.root.position);
  direction.y = 0;
  if (direction.lengthSq() <= 0.000001) return character.root.rotation.y;
  direction.normalize();
  return Math.atan2(direction.x, direction.z);
}

function shortestAngleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function faceCharacterToward(character, targetPosition, delta, instant = false, turnSpeed = TURN_SPEED) {
  const targetYaw = getYawToPosition(character, targetPosition);
  if (instant) {
    character.root.rotation.y = targetYaw;
    return;
  }
  const yawDelta = shortestAngleDelta(character.root.rotation.y, targetYaw);
  const maxStep = Math.max(0, asFiniteNumber(turnSpeed, TURN_SPEED)) * Math.max(delta, 0);
  character.root.rotation.y += THREE.MathUtils.clamp(yawDelta, -maxStep, maxStep);
}

function getTargetFacingMetrics(character, targetPosition) {
  if (!character || !targetPosition) return null;
  const offset = targetPosition.clone().sub(character.root.position);
  offset.y = 0;
  const distance = offset.length();
  if (distance <= 0.000001) {
    return {
      angleDeltaRadians: 0,
      angleDeltaDegrees: 0,
      absAngleDeltaDegrees: 0,
      distance: 0,
    };
  }
  const targetYaw = Math.atan2(offset.x, offset.z);
  const angleDeltaRadians = shortestAngleDelta(character.root.rotation.y, targetYaw);
  const angleDeltaDegrees = THREE.MathUtils.radToDeg(angleDeltaRadians);
  return {
    angleDeltaRadians,
    angleDeltaDegrees,
    absAngleDeltaDegrees: Math.abs(angleDeltaDegrees),
    distance,
  };
}

function isTargetInsideNpcVision(runtimeNpc, targetCharacter) {
  const origin = runtimeNpc.character.root.position;
  const targetPosition = targetCharacter.root.position;
  const toTarget = targetPosition.clone().sub(origin);
  toTarget.y = 0;
  const distance = toTarget.length();
  if (distance <= 0.000001 || distance > runtimeNpc.vision.distance) return false;
  toTarget.normalize();
  const forward = getCharacterForward(runtimeNpc.character);
  const angle = forward.angleTo(toTarget);
  return angle <= THREE.MathUtils.degToRad(runtimeNpc.vision.angle) / 2;
}

function getCharacterRuntimeEntity(character, fallback = {}) {
  const runtime = character.runtime || {};
  const attributes = { ...PLAYER_DEFAULT_ATTRIBUTES, ...(runtime.attributes || fallback.attributes || {}) };
  return {
    id: runtime.id || fallback.id || character.root.name,
    name: runtime.name || attributes.name || fallback.name || character.root.name,
    faction: runtime.faction ?? fallback.faction ?? 0,
    attributes,
    health: attributes.health,
    stamina: attributes.stamina,
    strength: attributes.strength,
    agility: attributes.agility,
    reaction: attributes.reaction,
    position: character.root.position.toArray(),
    runtimeCharacter: character,
  };
}

function collectNpcVisibleTargets(runtimeNpc) {
  if (!player || !player.root.visible || !isTargetInsideNpcVision(runtimeNpc, player)) return [];
  const target = getCharacterRuntimeEntity(player, {
    id: "player",
    name: "Player",
    faction: PLAYER_DEFAULT_FACTION,
    attributes: PLAYER_DEFAULT_ATTRIBUTES,
  });
  target.distance = runtimeNpc.character.root.position.distanceTo(player.root.position);
  target.attentionToMe = isTargetFacingCharacter(player, runtimeNpc.character);
  return [target];
}

function isTargetFacingCharacter(sourceCharacter, targetCharacter) {
  const toTarget = targetCharacter.root.position.clone().sub(sourceCharacter.root.position);
  toTarget.y = 0;
  if (toTarget.lengthSq() <= 0.000001) return false;
  toTarget.normalize();
  return getCharacterForward(sourceCharacter).dot(toTarget) > 0.55;
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


function updateCombatColliderDebugUI() {
  const badge = document.querySelector("[data-combat-collider-debug]");
  if (!badge) return;
  badge.classList.toggle("active", state.debugCombatColliders);
  badge.textContent = state.debugCombatColliders ? "HitBox H: On" : "HitBox H: Off";
}

function toggleCombatColliderDebug() {
  state.debugCombatColliders = !state.debugCombatColliders;
  combatColliderDebug.enabled = state.debugCombatColliders;
  updateCombatColliderDebugUI();
  if (!state.debugCombatColliders) {
    combatColliderDebug.hits.length = 0;
    clearCombatColliderDebugObjects();
  }
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

function resolveCombatAttackMove(character, direction, preferredMove = null) {
  if (preferredMove?.actionName && character?.actions?.[preferredMove.actionName]) {
    return preferredMove;
  }
  const availableMoves = getCharacterAvailableCombatMoves(character, direction);
  return chooseWeightedCombatMove(availableMoves);
}

function getCharacterAvailableCombatMoves(character, direction) {
  // Future character attributes, learned skills, martial arts, and enemy-type logic
  // should filter or reorder this list here. For now every configured move is available.
  return getCombatMovesForDirection(combatMoveManager, direction)
    .filter((move) => character?.actions?.[move.actionName]);
}

function getRuntimeCombatMoveById(moveId) {
  if (!moveId) return null;
  return getAllCombatMoves(combatMoveManager).find((move) => move.id === moveId) || null;
}

function requestCombatAttack(direction) {
  if (state.mode !== "game" || !state.combatMode) return;
  state.combatAttack.queuedDirection = direction;
  if (!state.combatAttack.active) {
    beginCombatAttack(direction);
  }
}

function beginCombatAttack(direction) {
  return beginCharacterCombatAttack(player, state.combatAttack, direction);
}

function beginCharacterCombatAttack(character, attackState, direction, preferredMove = null) {
  const selectedMove = resolveCombatAttackMove(character, preferredMove?.triggerDirection || direction, preferredMove);
  const attackDirection = selectedMove?.triggerDirection || direction;
  const actionName = selectedMove?.actionName;
  const action = character?.actions[actionName];
  if (!action) return false;

  attackState.active = true;
  attackState.activeDirection = attackDirection;
  attackState.activeActionName = actionName;
  attackState.activeActionFile = selectedMove.actionFile;
  attackState.activeMoveId = selectedMove.id;
  attackState.activeMoveName = selectedMove.name;
  attackState.activeStrength = selectedMove.strength;
  attackState.queuedDirection = null;
  attackState.recoveryTimer = 0;
  attackState.hitKeys?.clear();

  configureAnimationAction(actionName, action);
  if (character.currentAction === action) {
    restartCharacterAction(character, actionName);
  } else {
    action.reset();
    character.desiredAction = action;
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
  finishCharacterCombatAttack(state.combatAttack);
}

function finishCharacterCombatAttack(attackState) {
  if (!attackState.active) return;
  attackState.active = false;
  attackState.activeDirection = null;
  attackState.activeActionName = null;
  attackState.activeActionFile = null;
  attackState.activeMoveId = null;
  attackState.activeMoveName = null;
  attackState.activeStrength = 1;
  attackState.queuedDirection = null;
  attackState.recoveryTimer = COMBAT_ATTACK_RECOVERY_DURATION;
  attackState.hitKeys?.clear();
}

function cancelCombatAttack({ clearKeys = false } = {}) {
  cancelCharacterCombatAttack(state.combatAttack, { clearKeys });
}

function cancelCharacterCombatAttack(attackState, { clearKeys = false } = {}) {
  attackState.active = false;
  attackState.activeDirection = null;
  attackState.activeActionName = null;
  attackState.activeActionFile = null;
  attackState.activeMoveId = null;
  attackState.activeMoveName = null;
  attackState.activeStrength = 1;
  attackState.queuedDirection = null;
  attackState.recoveryTimer = 0;
  attackState.hitKeys?.clear();
  if (clearKeys) {
    COMBAT_ATTACK_DIRECTIONS.forEach((direction) => {
      attackState.keys[direction] = false;
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
  return combatAttackActionNames.has(actionName);
}

function isCombatAttackComplete(actionName, action) {
  const clip = animations[actionName];
  if (!clip || !action) return true;
  return action.paused || action.time >= Math.max(0, clip.duration - 0.035);
}

function getPlayerCombatTargets() {
  return runtimeNpcs
    .map((runtimeNpc) => runtimeNpc.character)
    .filter((character) => isActiveCombatTarget(character));
}

function getNpcCombatTargets() {
  return player && isActiveCombatTarget(player) ? [player] : [];
}

function isActiveCombatTarget(character) {
  return !!character?.active && !!character?.root?.visible;
}

function evaluateCombatAttackHits(attacker, attackState, targets = []) {
  if (!attacker || !attackState?.active || !attackState.activeMoveId) return;
  const move = getRuntimeCombatMoveById(attackState.activeMoveId);
  if (!move?.hitWindows?.length) return;

  const action = attacker.actions?.[attackState.activeActionName];
  if (!action) return;

  const time = action.time;
  const activeWindows = move.hitWindows.filter((hitWindow) => (
    time >= hitWindow.start && time <= hitWindow.end
  ));
  if (!activeWindows.length) return;

  const attackerModel = getRuntimeModelConfigForCharacter(attacker);
  if (!attackerModel) return;

  attacker.root.updateMatrixWorld(true);
  activeWindows.forEach((hitWindow) => {
    const attackColliders = getAttackCollidersForHitWindow(attackerModel, attacker.modelConfigId, hitWindow);
    if (!attackColliders.length) return;

    const attackBoxes = attackColliders
      .map((collider) => ({
        collider,
        box: createPartColliderWorldBox(attacker, collider),
      }))
      .filter((entry) => entry.box);
    if (!attackBoxes.length) return;

    targets.forEach((target) => {
      if (!isActiveCombatTarget(target) || target === attacker) return;
      const targetModel = getRuntimeModelConfigForCharacter(target);
      if (!targetModel) return;

      target.root.updateMatrixWorld(true);
      const hurtColliders = getRuntimePartCollidersForChannel(targetModel, "hurt");
      let bestHit = null;

      attackBoxes.forEach((attackEntry) => {
        hurtColliders.forEach((hurtCollider) => {
          const hitKey = makeCombatHitKey(move, hitWindow, target, hurtCollider);
          if (attackState.hitKeys?.has(hitKey)) return;

          const hurtBox = createPartColliderWorldBox(target, hurtCollider);
          if (!hurtBox || !attackEntry.box.intersectsBox(hurtBox)) return;

          const hit = createCombatHitResult({
            attacker,
            target,
            move,
            hitWindow,
            attackCollider: attackEntry.collider,
            hurtCollider,
            targetModel,
            hitKey,
          });
          if (!bestHit || hit.strengthDelta > bestHit.strengthDelta) bestHit = hit;
        });
      });

      if (!bestHit) return;
      attackState.hitKeys?.add(bestHit.hitKey);
      applyCombatHit(bestHit);
      recordCombatColliderDebugHit(bestHit);
    });
  });
}

function makeCombatHitKey(move, hitWindow, target, hurtCollider) {
  return [
    move.id,
    hitWindow.id,
    getRuntimeCharacterId(target),
    hurtCollider.id,
  ].join(":");
}

function createCombatHitResult({
  attacker,
  target,
  move,
  hitWindow,
  attackCollider,
  hurtCollider,
  targetModel,
  hitKey,
}) {
  const outputStrength = normalizeRuntimeNonNegativeNumber(move.strength, 1)
    + normalizeRuntimeNonNegativeNumber(attackCollider.strength, 0);
  const defenseStrength = normalizeRuntimeNonNegativeNumber(targetModel.baseCollider?.strength, 0)
    + normalizeRuntimeNonNegativeNumber(hurtCollider.strength, 0);
  const strengthDelta = outputStrength - defenseStrength;
  return {
    attacker,
    target,
    move,
    hitWindow,
    attackCollider,
    hurtCollider,
    targetModel,
    outputStrength,
    defenseStrength,
    strengthDelta,
    hitKey,
  };
}

function applyCombatHit(hit) {
  const knockbackDistance = Math.max(0, hit.strengthDelta * 0.1);
  if (knockbackDistance > 0) {
    applyCharacterKnockback(
      hit.target,
      getCombatKnockbackDirection(hit.attacker, hit.move),
      knockbackDistance,
    );
  }

  const hitstunApplied = hit.strengthDelta > 0
    && hit.move.impact?.hitstun?.enabled
    && applyCharacterHitReaction(
      hit.target,
      hit.move.impact.hitstun.hitActionName,
      hit.attacker,
    );

  const record = {
    moveId: hit.move.id,
    moveName: hit.move.name,
    hitWindowId: hit.hitWindow.id,
    attackColliderId: hit.attackCollider.id,
    hurtColliderId: hit.hurtCollider.id,
    outputStrength: hit.outputStrength,
    defenseStrength: hit.defenseStrength,
    strengthDelta: hit.strengthDelta,
    knockbackDistance,
    hitstunApplied,
  };
  hit.attacker.lastCombatHitDealt = record;
  hit.target.lastCombatHit = record;
}

function getCombatKnockbackDirection(attacker, move) {
  return combatCollision.getCombatKnockbackDirection(THREE, attacker, move, WORLD_UP);
}

function applyCharacterKnockback(character, direction, distance) {
  if (!character || distance <= 0 || direction.lengthSq() <= 0.000001) return;
  const steps = Math.max(1, Math.ceil(distance / 0.16));
  const step = direction.clone().setY(0).normalize().multiplyScalar(distance / steps);
  for (let i = 0; i < steps; i += 1) {
    const next = character.root.position.clone().add(step);
    if (!canMoveTo(next)) break;
    character.root.position.copy(next);
  }
  character.root.updateMatrixWorld(true);
}

function applyCharacterHitReaction(character, actionName, sourceCharacter) {
  const action = character?.actions?.[actionName];
  const clip = animations[actionName];
  if (!character || !action || !clip) return false;

  const attackState = getCharacterCombatAttackState(character);
  if (attackState?.active) cancelCharacterCombatAttack(attackState);

  character.hitReaction.active = true;
  character.hitReaction.timer = Math.max(0.05, clip.duration);
  character.hitReaction.actionName = actionName;
  character.hitReaction.sourceId = getRuntimeCharacterId(sourceCharacter);

  action.enabled = true;
  action.paused = false;
  action.clampWhenFinished = true;
  action.setLoop(THREE.LoopOnce, 1);
  action.timeScale = 1;
  action.reset();
  character.desiredAction = action;
  return true;
}

function updateCharacterHitReaction(character, delta) {
  const reaction = character?.hitReaction;
  if (!reaction?.active) return false;

  const action = character.actions?.[reaction.actionName];
  if (!action) {
    clearCharacterHitReaction(character);
    return false;
  }

  reaction.timer = Math.max(0, reaction.timer - delta);
  character.desiredAction = action;
  if (character.actions.walk) character.actions.walk.timeScale = 1;
  if (character.actions.combatWalk) character.actions.combatWalk.timeScale = 1;

  if (reaction.timer > 0) return true;
  clearCharacterHitReaction(character);
  return false;
}

function clearCharacterHitReaction(character) {
  if (!character?.hitReaction) return;
  character.hitReaction.active = false;
  character.hitReaction.timer = 0;
  character.hitReaction.actionName = null;
  character.hitReaction.sourceId = null;
}

function getCharacterCombatAttackState(character) {
  if (!character) return null;
  if (character === player) return state.combatAttack;
  return character.combatAttack || runtimeNpcs.find((runtimeNpc) => runtimeNpc.character === character)?.combatAttack || null;
}

function getRuntimeModelConfigForCharacter(character) {
  const modelId = character?.modelConfigId || inferModelConfigId(character?.gender);
  return modelConfig.models?.[modelId] || null;
}

function getAttackCollidersForHitWindow(model, modelId, hitWindow) {
  return combatCollision.getAttackCollidersForHitWindow(model, modelId, hitWindow);
}

function getRuntimePartCollidersForChannel(model, channel) {
  return combatCollision.getRuntimePartCollidersForChannel(model, channel);
}

function createPartColliderWorldBox(character, collider) {
  return combatCollision.createPartColliderWorldBox(THREE, character, collider, COLLIDER_LOCAL_CORNERS);
}

function createColliderWorldBox(parent, collider, type) {
  return combatCollision.createColliderWorldBox(THREE, parent, collider, type, COLLIDER_LOCAL_CORNERS);
}

function getRuntimeCharacterId(character) {
  return character?.runtime?.id || character?.root?.uuid || "unknown";
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
    if (player.currentAction === action) evaluateCombatAttackHits(player, attack, getPlayerCombatTargets());
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

function consumeCombatRecoveryControlScale(delta, attack = state.combatAttack) {
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
    if (event.code === "KeyH" && !event.repeat) {
      event.preventDefault();
      toggleCombatColliderDebug();
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
    updateRuntimeNpcs(delta);
    cameraTarget.lerp(new THREE.Vector3(player.root.position.x, 1.05, player.root.position.z), 1 - Math.exp(-CAMERA_LERP * delta));
  }

  // Bake Into Pose 去趋势后，动画自身的脚步放置已经正确（动画师设计的重心摆动与脚步是配合的），
  // 不再需要 applyFootLock 额外补偿（Foot Lock 与去趋势振荡互相拉锯会产生抖动）。
  // applyFootLock 仅保留用于未来可能的 IK 脚底贴地修正。

  updateRootMarker();
  updateFacingMarker();
  updateCombatColliderDebugLayer(delta);
  updateCamera(delta);
  window.__DEMO_STATE = getDebugState();
  renderer.render(scene, camera);
}

function createCombatColliderDebugState() {
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const geometry = new THREE.EdgesGeometry(boxGeometry);
  boxGeometry.dispose();
  const group = new THREE.Group();
  group.name = "CombatColliderDebugLayer";
  group.visible = false;
  return {
    enabled: false,
    group,
    geometry,
    objects: [],
    pool: [],
    hits: [],
    materials: {
      enabled: createCombatColliderDebugMaterial(0x43d7ff, 0.58),
      attack: createCombatColliderDebugMaterial(0xff3048, 1),
      hit: createCombatColliderDebugMaterial(0xffffff, 1),
    },
  };
}

function createCombatColliderDebugMaterial(color, opacity) {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
  });
}

function clearCombatColliderDebugObjects() {
  combatColliderDebug.objects.forEach((object) => {
    if (object.parent) object.parent.remove(object);
    object.visible = false;
    combatColliderDebug.pool.push(object);
  });
  combatColliderDebug.objects.length = 0;
  combatColliderDebug.group.visible = false;
}

function updateCombatColliderDebugLayer(delta) {
  if (!combatColliderDebug.enabled) {
    clearCombatColliderDebugObjects();
    return;
  }

  try {
    combatColliderDebug.hits = combatColliderDebug.hits
      .map((entry) => ({ ...entry, ttl: entry.ttl - delta }))
      .filter((entry) => entry.ttl > 0 && isActiveCombatTarget(entry.target) && isActiveCombatTarget(entry.attacker));

    clearCombatColliderDebugObjects();
    combatColliderDebug.group.visible = true;
    const characters = getRuntimeCombatCharacters();
    characters.forEach(renderEnabledCombatColliderDebug);
    characters.forEach(renderActiveAttackColliderDebug);
    renderRecentHurtColliderDebug();
  } catch (error) {
    console.warn("Combat collider debug draw failed; H debug has been disabled.", error);
    state.debugCombatColliders = false;
    combatColliderDebug.enabled = false;
    combatColliderDebug.hits.length = 0;
    clearCombatColliderDebugObjects();
    updateCombatColliderDebugUI();
  }
}

function getRuntimeCombatCharacters() {
  return [player, ...runtimeNpcs.map((runtimeNpc) => runtimeNpc.character)]
    .filter((character) => isActiveCombatTarget(character));
}

function renderEnabledCombatColliderDebug(character) {
  const model = getRuntimeModelConfigForCharacter(character);
  if (!model) return;

  character.root.updateMatrixWorld(true);
  if (model.baseCollider?.enabled !== false) {
    addCombatBaseColliderDebugWire(character, model.baseCollider, "enabled");
  }
  (model.partColliders || [])
    .filter((collider) => collider.enabled !== false)
    .forEach((collider) => addCombatPartColliderDebugWire(character, collider, "enabled"));
}

function renderActiveAttackColliderDebug(character) {
  const attackState = getCharacterCombatAttackState(character);
  if (!attackState?.active || !attackState.activeMoveId) return;
  const move = getRuntimeCombatMoveById(attackState.activeMoveId);
  const action = character.actions?.[attackState.activeActionName];
  const model = getRuntimeModelConfigForCharacter(character);
  if (!move?.hitWindows?.length || !action || !model) return;

  const activeWindows = move.hitWindows.filter((hitWindow) => (
    action.time >= hitWindow.start && action.time <= hitWindow.end
  ));
  if (!activeWindows.length) return;

  character.root.updateMatrixWorld(true);
  activeWindows.forEach((hitWindow) => {
    getAttackCollidersForHitWindow(model, character.modelConfigId, hitWindow)
      .forEach((collider) => addCombatPartColliderDebugWire(character, collider, "attack"));
  });
}

function renderRecentHurtColliderDebug() {
  const rendered = new Set();
  combatColliderDebug.hits.forEach((entry) => {
    const attackerId = getRuntimeCharacterId(entry.attacker);
    const attackKey = `${attackerId}:attack:${entry.attackCollider?.id || "unknown"}`;
    if (entry.attackCollider && !rendered.has(attackKey)) {
      addCombatPartColliderDebugWire(entry.attacker, entry.attackCollider, "attack");
      rendered.add(attackKey);
    }

    const targetId = getRuntimeCharacterId(entry.target);
    const baseKey = `${targetId}:hit-base`;
    if (entry.baseCollider?.enabled !== false && !rendered.has(baseKey)) {
      addCombatBaseColliderDebugWire(entry.target, entry.baseCollider, "hit");
      rendered.add(baseKey);
    }
    const hurtKey = `${targetId}:hit:${entry.hurtCollider?.id || "unknown"}`;
    if (entry.hurtCollider && !rendered.has(hurtKey)) {
      addCombatPartColliderDebugWire(entry.target, entry.hurtCollider, "hit");
      rendered.add(hurtKey);
    }
  });
}

function getCombatColliderDebugMaterial(role) {
  if (role === "attack") return combatColliderDebug.materials.attack;
  if (role === "hit") return combatColliderDebug.materials.hit;
  return combatColliderDebug.materials.enabled;
}

function addCombatBaseColliderDebugWire(character, collider, role = "enabled") {
  if (!character?.root || !collider) return;
  const wire = createCombatColliderDebugWire(collider, "base", getCombatColliderDebugMaterial(role), role);
  character.root.add(wire);
  combatColliderDebug.objects.push(wire);
}

function addCombatPartColliderDebugWire(character, collider, role = "enabled") {
  const bone = character?.scene?.getObjectByName(collider?.bone);
  if (!bone || !collider) return;
  const wire = createCombatColliderDebugWire(collider, "part", getCombatColliderDebugMaterial(role), role);
  bone.add(wire);
  combatColliderDebug.objects.push(wire);
}

function createCombatColliderDebugWire(collider, type, material, role = "enabled") {
  const wire = combatColliderDebug.pool.pop() || new THREE.LineSegments(combatColliderDebug.geometry, material);
  wire.material = material;
  wire.name = `CombatColliderDebug_${role}_${type}_${collider.id || "base"}`;
  wire.visible = true;
  wire.renderOrder = role === "hit" ? 46 : role === "attack" ? 44 : 40;
  const position = toRuntimeVectorArray(type === "base" ? collider.center : collider.offset, [0, 0, 0]);
  const size = toRuntimeVectorArray(collider.size, [0.24, 0.24, 0.24]).map((item) => Math.max(0.001, Math.abs(item)));
  const rotation = toRuntimeVectorArray(collider.rotationDegrees, [0, 0, 0]);
  wire.position.set(...position);
  wire.scale.set(...size);
  wire.rotation.set(
    THREE.MathUtils.degToRad(rotation[0]),
    THREE.MathUtils.degToRad(rotation[1]),
    THREE.MathUtils.degToRad(rotation[2]),
  );
  return wire;
}

function recordCombatColliderDebugHit(hit) {
  if (!combatColliderDebug.enabled) return;
  combatColliderDebug.hits.push({
    attacker: hit.attacker,
    attackCollider: hit.attackCollider,
    target: hit.target,
    baseCollider: hit.targetModel?.baseCollider || null,
    hurtCollider: hit.hurtCollider,
    ttl: COMBAT_COLLIDER_DEBUG_HIT_TTL,
  });
  if (combatColliderDebug.hits.length > COMBAT_COLLIDER_DEBUG_MAX_HITS) {
    combatColliderDebug.hits.splice(0, combatColliderDebug.hits.length - COMBAT_COLLIDER_DEBUG_MAX_HITS);
  }
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
    combatColliderDebugEnabled: state.debugCombatColliders,
    combatColliderDebugObjectCount: combatColliderDebug.objects.length,
    combatColliderDebugHitCount: combatColliderDebug.hits.length,
    combatAttackActive: state.combatAttack.active,
    combatAttackDirection: state.combatAttack.activeDirection,
    combatAttackAction: state.combatAttack.activeActionName,
    combatAttackActionFile: state.combatAttack.activeActionFile,
    combatAttackMoveId: state.combatAttack.activeMoveId,
    combatAttackMoveName: state.combatAttack.activeMoveName,
    combatAttackStrength: state.combatAttack.activeStrength,
    combatAttackQueuedDirection: state.combatAttack.queuedDirection,
    combatAttackKeys: { ...state.combatAttack.keys },
    combatAttackRecoveryTimer: state.combatAttack.recoveryTimer,
    combatAttackHitCount: state.combatAttack.hitKeys?.size ?? 0,
    combatMoveActions: [...combatAttackActionNames],
    playerModelConfigId: player?.modelConfigId ?? null,
    playerHitReaction: player?.hitReaction ? { ...player.hitReaction } : null,
    playerLastCombatHit: player?.lastCombatHit ?? null,
    playerLastCombatHitDealt: player?.lastCombatHitDealt ?? null,
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
    runtimeNpcs: runtimeNpcs.map((runtimeNpc) => ({
      id: runtimeNpc.character.runtime?.id || runtimeNpc.data.id,
      name: runtimeNpc.character.runtime?.name || runtimeNpc.data.attributes?.name,
      mode: runtimeNpc.ai.mode,
      candidateMode: runtimeNpc.ai.candidateMode,
      pendingMode: runtimeNpc.ai.pendingMode,
      modeElapsed: runtimeNpc.ai.modeElapsed,
      pendingElapsed: runtimeNpc.ai.pendingElapsed,
      behaviorTreeId: runtimeNpc.data.behaviorTreeId || null,
      behaviorTreeLoaded: !!runtimeNpc.behaviorTree,
      visibleTargetCount: runtimeNpc.ai.visibleTargets.length,
      vision: { ...runtimeNpc.vision },
      position: runtimeNpc.character.root.position.toArray(),
      targetAngleDeltaDegrees: runtimeNpc.blackboard.targetAngleDeltaDegrees,
      targetDistance: runtimeNpc.blackboard.targetDistance,
      activeAttackNodeId: runtimeNpc.blackboard.activeAttackNodeId,
      selectedAttackMoveId: runtimeNpc.blackboard.selectedAttackMoveId,
      currentAction: getActionName(runtimeNpc.character, runtimeNpc.character.currentAction),
      desiredAction: getActionName(runtimeNpc.character, runtimeNpc.character.desiredAction),
      combatAttackActionFile: runtimeNpc.combatAttack.activeActionFile,
      combatAttackMoveId: runtimeNpc.combatAttack.activeMoveId,
      combatAttackMoveName: runtimeNpc.combatAttack.activeMoveName,
      combatAttackStrength: runtimeNpc.combatAttack.activeStrength,
      combatAttackHitCount: runtimeNpc.combatAttack.hitKeys?.size ?? 0,
      modelConfigId: runtimeNpc.character.modelConfigId,
      hitReaction: { ...runtimeNpc.character.hitReaction },
      lastCombatHit: runtimeNpc.character.lastCombatHit,
      lastCombatHitDealt: runtimeNpc.character.lastCombatHitDealt,
    })),
    selectionChildren: selectionSet?.children.length ?? 0,
    rendererSize: renderer ? renderer.getDrawingBufferSize(new THREE.Vector2()).toArray() : null,
  };
}

function updatePlayer(delta) {
  if (updateCharacterHitReaction(player, delta)) return;

  const attackActionName = updateCombatAttackState();
  if (attackActionName) {
    if (player.actions.walk) player.actions.walk.timeScale = 1.0;
    if (player.actions.combatWalk) player.actions.combatWalk.timeScale = 1.0;
    return;
  }

  const controlScale = consumeCombatRecoveryControlScale(delta);
  updateCharacterLocomotion(player, {
    moving: state.keys.forward,
    turn: (state.keys.left ? 1 : 0) - (state.keys.right ? 1 : 0),
    combatMode: state.combatMode,
    combatColliderDebugEnabled: state.debugCombatColliders,
    combatColliderDebugObjectCount: combatColliderDebug.objects.length,
    combatColliderDebugHitCount: combatColliderDebug.hits.length,
    controlScale,
  }, delta);
  return;
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

function getCharacterLocomotionActions(character, combatMode) {
  return combatMode
    ? {
        idle: character.actions.combatIdle,
        walk: character.actions.combatWalk,
        turnLeft: character.actions.combatTurnLeft,
        turnRight: character.actions.combatTurnRight,
      }
    : {
        idle: character.actions.idle,
        walk: character.actions.walk,
        turnLeft: character.actions.turnLeft,
        turnRight: character.actions.turnRight,
      };
}

function updateCharacterLocomotion(character, intent, delta) {
  const controlScale = intent.controlScale ?? 1;
  const moving = !!intent.moving;
  const turn = Number(intent.turn) || 0;
  const turningLeft = turn > 0.001;
  const turningRight = turn < -0.001;
  const locomotion = getCharacterLocomotionActions(character, !!intent.combatMode);
  const nextAction = moving
    ? locomotion.walk
    : turningLeft
      ? locomotion.turnLeft
      : turningRight
        ? locomotion.turnRight
        : locomotion.idle;
  const nextActionName = getActionName(character, nextAction) || "idle";
  const config = motionConfig[nextActionName] || { motionMode: "InPlace" };
  const moveSpeed = Number.isFinite(Number(intent.moveSpeed))
    ? Number(intent.moveSpeed)
    : getConfiguredCodeMoveSpeed(nextActionName);
  const turnSpeed = Number.isFinite(Number(intent.turnSpeed))
    ? Number(intent.turnSpeed)
    : TURN_SPEED;
  const isTurningAction = nextActionName === "turnLeft"
    || nextActionName === "turnRight"
    || nextActionName === "combatTurnLeft"
    || nextActionName === "combatTurnRight";
  const useRootRotation = isTurningAction && config.motionMode === "RootMotion";

  if (!useRootRotation && !intent.rotationApplied) {
    character.root.rotation.y += turn * turnSpeed * controlScale * delta;
  }

  character.desiredAction = nextAction;

  if (character.actions.walk && nextAction !== character.actions.walk) character.actions.walk.timeScale = 1.0;
  if (character.actions.combatWalk && nextAction !== character.actions.combatWalk) character.actions.combatWalk.timeScale = 1.0;
  if (isTurningAction) nextAction.timeScale = controlScale < 1 ? controlScale : 1.0;
  if (!moving) return;

  const effectiveMoveSpeed = moveSpeed * controlScale;
  if (config.motionMode === "RootMotion") {
    if (hasConfiguredCodeMoveSpeed(nextActionName)) {
      const naturalSpeed = computeAnimNaturalSpeed(nextActionName, character);
      if (naturalSpeed > 0.1) {
        const targetScale = moveSpeed / naturalSpeed;
        nextAction.timeScale = THREE.MathUtils.clamp(targetScale * controlScale, 0, 3.0);
      } else {
        nextAction.timeScale = controlScale < 1 ? controlScale : 1.0;
      }
    }
    return;
  }

  const naturalSpeed = computeAnimNaturalSpeed(nextActionName, character);
  if (naturalSpeed > 0.1) {
    const targetScale = effectiveMoveSpeed / naturalSpeed;
    nextAction.timeScale = THREE.MathUtils.clamp(targetScale, 0, 3.0);
  } else {
    nextAction.timeScale = controlScale < 1 ? controlScale : 1.0;
  }

  const forward = getConfiguredCodeMoveDirection(nextActionName, character);
  const next = character.root.position.clone().addScaledVector(forward, effectiveMoveSpeed * delta);
  if (canMoveTo(next)) {
    character.root.position.copy(next);
  }
}

function updateRuntimeNpcs(delta) {
  runtimeNpcs.forEach((runtimeNpc) => {
    if (!runtimeNpc.character.active || !runtimeNpc.character.root.visible) return;
    refreshNpcVisionHelper(runtimeNpc);
    updateRuntimeNpcBrain(runtimeNpc, delta);
    if (updateCharacterHitReaction(runtimeNpc.character, delta)) {
      updateNpcModeLabelTransform(runtimeNpc);
      return;
    }
    executeRuntimeNpcBehavior(runtimeNpc, delta);
    updateNpcModeLabelTransform(runtimeNpc);
  });
}

function updateRuntimeNpcBrain(runtimeNpc, delta) {
  if (!runtimeNpc.behaviorTree) return;
  runtimeNpc.ai.modeElapsed = (runtimeNpc.ai.modeElapsed || 0) + delta;
  runtimeNpc.ai.tickTimer -= delta;
  if (runtimeNpc.ai.tickTimer <= 0 || !runtimeNpc.ai.result) {
    const brain = runtimeNpc.behaviorTree.brain || {};
    const tickInterval = Math.max(0.05, Number(brain.tickIntervalMs || 300) / 1000);
    runtimeNpc.ai.tickTimer = tickInterval;
    runtimeNpc.blackboard.randomPosition = getOrCreateNpcRandomPosition(runtimeNpc);
    const visibleTargets = collectNpcVisibleTargets(runtimeNpc);
    const context = {
      self: getCharacterRuntimeEntity(runtimeNpc.character, {
        id: runtimeNpc.data.id,
        name: runtimeNpc.data.attributes?.name,
        faction: runtimeNpc.data.faction,
        attributes: runtimeNpc.data.attributes,
      }),
      visibleTargets,
      blackboard: {
        randomPosition: runtimeNpc.blackboard.randomPosition,
        lookTarget: runtimeNpc.blackboard.lookTarget,
        lockedTarget: runtimeNpc.blackboard.lockedTarget,
        targetAngleDeltaDegrees: runtimeNpc.blackboard.targetAngleDeltaDegrees,
        targetDistance: runtimeNpc.blackboard.targetDistance,
      },
    };
    const result = evaluateNpcBrain(runtimeNpc.behaviorTree, context);
    runtimeNpc.ai.result = result;
    runtimeNpc.ai.candidateMode = result.mode || brain.fallbackMode || "default";
    runtimeNpc.ai.visibleTargets = visibleTargets;
    if (result.blackboard.lookTarget) {
      runtimeNpc.blackboard.lookTarget = result.blackboard.lookTarget;
    }
    if (result.blackboard.lockedTarget) {
      runtimeNpc.blackboard.lockedTarget = result.blackboard.lockedTarget;
    } else if (result.blackboard.lookTarget) {
      runtimeNpc.blackboard.lockedTarget = result.blackboard.lookTarget;
    }
  }
  updateRuntimeNpcModeController(runtimeNpc, delta);
}

function updateRuntimeNpcModeController(runtimeNpc, delta) {
  const ai = runtimeNpc.ai;
  const currentMode = ai.mode || runtimeNpc.behaviorTree?.brain?.fallbackMode || "default";
  const candidateMode = ai.candidateMode || currentMode;
  ai.noVisibleTargetElapsed = ai.visibleTargets.length ? 0 : (ai.noVisibleTargetElapsed || 0) + delta;

  if (candidateMode === currentMode) {
    ai.pendingMode = null;
    ai.pendingElapsed = 0;
    return;
  }

  const config = getRuntimeModeSwitchConfig(runtimeNpc.behaviorTree, currentMode);
  const minSatisfied = ai.modeElapsed * 1000 >= config.minDurationMs;
  const lostTargetSatisfied = candidateMode !== "default"
    || ai.visibleTargets.length > 0
    || ai.noVisibleTargetElapsed * 1000 >= config.lostTargetGraceMs;
  const canInterrupt = config.interruptibleBy.includes(candidateMode);

  if (canInterrupt) {
    commitRuntimeNpcMode(runtimeNpc, candidateMode);
    return;
  }

  if (!minSatisfied || !lostTargetSatisfied) {
    ai.pendingMode = candidateMode;
    ai.pendingElapsed = 0;
    return;
  }

  if (ai.pendingMode !== candidateMode) {
    ai.pendingMode = candidateMode;
    ai.pendingElapsed = 0;
  } else {
    ai.pendingElapsed += delta;
  }

  if (ai.pendingElapsed * 1000 >= config.stableDurationMs) {
    commitRuntimeNpcMode(runtimeNpc, candidateMode);
  }
}

function commitRuntimeNpcMode(runtimeNpc, mode) {
  runtimeNpc.ai.mode = mode;
  runtimeNpc.ai.modeElapsed = 0;
  runtimeNpc.ai.pendingMode = null;
  runtimeNpc.ai.pendingElapsed = 0;
  if (mode !== "attack") {
    runtimeNpc.blackboard.lockedTarget = null;
    runtimeNpc.blackboard.targetAngleDeltaDegrees = null;
    runtimeNpc.blackboard.targetDistance = null;
    runtimeNpc.blackboard.activeAttackNodeId = null;
    runtimeNpc.blackboard.selectedAttackMoveId = null;
    cancelCharacterCombatAttack(runtimeNpc.combatAttack);
  }
  if (mode === "default") {
    runtimeNpc.blackboard.lookTarget = null;
  }
}

function getRuntimeModeSwitchConfig(behaviorTree, mode) {
  const defaults = DEFAULT_MODE_SWITCH_CONFIGS[mode] || DEFAULT_MODE_SWITCH_CONFIGS.custom;
  const node = behaviorTree?.behaviorModes?.[mode]?.nodes?.find((item) => item.type === "modeSwitch");
  const config = node?.params?.modeSwitch || {};
  const interruptibleBy = Array.isArray(config.interruptibleBy)
    ? config.interruptibleBy
    : defaults.interruptibleBy;
  return {
    minDurationMs: asFiniteNumber(config.minDurationMs, defaults.minDurationMs),
    stableDurationMs: asFiniteNumber(config.stableDurationMs, defaults.stableDurationMs),
    lostTargetGraceMs: asFiniteNumber(config.lostTargetGraceMs, defaults.lostTargetGraceMs),
    interruptibleBy: interruptibleBy.filter(Boolean),
  };
}

function asFiniteNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function executeRuntimeNpcBehavior(runtimeNpc, delta) {
  const character = runtimeNpc.character;
  const mode = runtimeNpc.ai.mode || runtimeNpc.behaviorTree?.brain?.fallbackMode || "default";
  const result = runtimeNpc.ai.result;
  const nodes = getOrderedRuntimeBehaviorNodes(runtimeNpc.behaviorTree, mode);
  const command = {
    combatMode: mode === "attack",
    moveTarget: null,
    lookTarget: null,
    attackTarget: null,
    lockNode: null,
    lockTarget: null,
    lockTurnSpeed: DEFAULT_LOCK_TURN_SPEED,
    attackNodes: [],
    selectedAttackNode: null,
    turn: 0,
    rotationApplied: false,
    moveSpeed: mode === "attack" ? runtimeNpc.moveSpeed.combat : runtimeNpc.moveSpeed.normal,
  };

  if (!nodes.length) {
    applyFallbackNpcCommand(runtimeNpc, command, mode);
  } else {
    nodes.forEach((node) => applyNpcBehaviorNode(runtimeNpc, result, command, node));
  }

  resolveNpcLockedAttack(runtimeNpc, command, mode, delta);

  const attackTargetPosition = getRuntimePosition(command.attackTarget);
  if (attackTargetPosition) {
    command.lookTarget = attackTargetPosition;
  }
  const lookTargetPosition = getRuntimePosition(command.lookTarget);
  if (lookTargetPosition && !command.rotationApplied) {
    faceCharacterToward(character, lookTargetPosition, delta);
    updateNpcTargetBlackboardMetrics(runtimeNpc, lookTargetPosition);
  }

  const attackDistance = attackTargetPosition
    ? character.root.position.distanceTo(attackTargetPosition)
    : Infinity;
  const shouldAttack = !!command.selectedAttackNode || (!!attackTargetPosition && attackDistance <= NPC_ATTACK_RANGE);
  const attackActionName = updateNpcCombatAttack(runtimeNpc, shouldAttack, delta, command.selectedAttackNode);
  if (attackActionName) {
    if (character.actions.walk) character.actions.walk.timeScale = 1.0;
    if (character.actions.combatWalk) character.actions.combatWalk.timeScale = 1.0;
    return;
  }

  if (!command.lockNode && attackTargetPosition && attackDistance > NPC_ATTACK_RANGE) {
    command.moveTarget = attackTargetPosition;
    command.combatMode = true;
    command.moveSpeed = runtimeNpc.moveSpeed.combat;
  }

  const moveTargetPosition = getRuntimePosition(command.moveTarget);
  const moving = !!moveTargetPosition && character.root.position.distanceTo(moveTargetPosition) > NPC_RANDOM_REACH_DISTANCE;
  if (moving) {
    if (!command.rotationApplied) {
      faceCharacterToward(character, moveTargetPosition, delta);
    }
  } else if (command.moveTarget === runtimeNpc.blackboard.randomPosition) {
    runtimeNpc.blackboard.randomPosition = null;
  }

  const controlScale = consumeCombatRecoveryControlScale(delta, runtimeNpc.combatAttack);
  updateCharacterLocomotion(character, {
    moving,
    turn: command.turn,
    combatMode: command.combatMode,
    controlScale,
    moveSpeed: command.moveSpeed,
    turnSpeed: command.lockTurnSpeed,
    rotationApplied: command.rotationApplied,
  }, delta);
}

function resolveNpcLockedAttack(runtimeNpc, command, mode, delta) {
  if (!command.lockNode) {
    const attackTargetPosition = getRuntimePosition(command.attackTarget);
    command.selectedAttackNode = selectFirstSatisfiedAttackNode(
      runtimeNpc,
      command.attackNodes,
      attackTargetPosition,
    );
    if (command.selectedAttackNode) {
      command.attackTarget = resolveRuntimeBinding(
        runtimeNpc,
        runtimeNpc.ai.result,
        command.selectedAttackNode.params?.bindings?.targetPos || "lockedTarget",
      ) || command.attackTarget;
    }
    runtimeNpc.blackboard.activeAttackNodeId = command.selectedAttackNode?.id || null;
    runtimeNpc.blackboard.selectedAttackMoveId = command.selectedAttackNode?.params?.attack?.combatMoveId || null;
    return;
  }

  const lockTargetPosition = getRuntimePosition(command.lockTarget);
  if (!lockTargetPosition) {
    clearNpcTargetBlackboardMetrics(runtimeNpc);
    command.attackTarget = null;
    return;
  }

  const before = getTargetFacingMetrics(runtimeNpc.character, lockTargetPosition);
  const turn = Math.abs(before?.angleDeltaRadians || 0) > THREE.MathUtils.degToRad(0.5)
    ? Math.sign(before.angleDeltaRadians)
    : 0;
  faceCharacterToward(runtimeNpc.character, lockTargetPosition, delta, false, command.lockTurnSpeed);
  const metrics = updateNpcTargetBlackboardMetrics(runtimeNpc, lockTargetPosition);
  command.turn = turn;
  command.rotationApplied = true;
  command.combatMode = true;
  command.lookTarget = command.lockTarget;

  const attackNodes = getCandidateAttackNodesAfterLock(runtimeNpc.behaviorTree, mode, command.lockNode, command.attackNodes);
  const selectedAttackNode = selectFirstSatisfiedAttackNode(runtimeNpc, attackNodes, lockTargetPosition, metrics);
  command.selectedAttackNode = selectedAttackNode;
  command.attackTarget = selectedAttackNode ? command.lockTarget : null;
  if (!selectedAttackNode && shouldNpcChaseLockedTarget(metrics, attackNodes)) {
    command.moveTarget = command.lockTarget;
    command.moveSpeed = runtimeNpc.moveSpeed.combat;
  }
  runtimeNpc.blackboard.activeAttackNodeId = selectedAttackNode?.id || null;
  runtimeNpc.blackboard.selectedAttackMoveId = selectedAttackNode?.params?.attack?.combatMoveId || null;
}

function selectFirstSatisfiedAttackNode(runtimeNpc, attackNodes, targetPosition, knownMetrics = null) {
  if (!targetPosition || !attackNodes?.length) return null;
  const metrics = knownMetrics || updateNpcTargetBlackboardMetrics(runtimeNpc, targetPosition);
  if (!metrics) return null;
  return attackNodes.find((node) => {
    const config = getRuntimeAttackConfig(node);
    return metrics.absAngleDeltaDegrees <= config.attackAngleDegrees
      && metrics.distance <= config.attackDistance;
  }) || null;
}

function getCandidateAttackNodesAfterLock(behaviorTree, mode, lockNode, fallbackAttackNodes = []) {
  const stateForMode = getRuntimeBehaviorState(behaviorTree, mode);
  if (!stateForMode || !lockNode) return fallbackAttackNodes;
  const nodesById = new Map(stateForMode.nodes.map((node) => [node.id, node]));
  const directAttackNodes = (stateForMode.transitions || [])
    .filter((transition) => transition.from === lockNode.id)
    .map((transition) => nodesById.get(transition.to))
    .filter((node) => node?.type === "attack");
  const seen = new Set();
  return [...directAttackNodes, ...fallbackAttackNodes].filter((node) => {
    if (!node || seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function shouldNpcChaseLockedTarget(metrics, attackNodes) {
  if (!metrics) return false;
  const ranges = (attackNodes || [])
    .map((node) => getRuntimeAttackConfig(node).attackDistance)
    .filter((distance) => Number.isFinite(distance) && distance >= 0);
  const maxAttackDistance = ranges.length ? Math.max(...ranges) : DEFAULT_ATTACK_DISTANCE;
  return metrics.distance > maxAttackDistance;
}

function updateNpcTargetBlackboardMetrics(runtimeNpc, targetPosition) {
  const metrics = getTargetFacingMetrics(runtimeNpc.character, targetPosition);
  if (!metrics) {
    clearNpcTargetBlackboardMetrics(runtimeNpc);
    return null;
  }
  runtimeNpc.blackboard.targetAngleDeltaDegrees = metrics.angleDeltaDegrees;
  runtimeNpc.blackboard.targetDistance = metrics.distance;
  return metrics;
}

function clearNpcTargetBlackboardMetrics(runtimeNpc) {
  runtimeNpc.blackboard.targetAngleDeltaDegrees = null;
  runtimeNpc.blackboard.targetDistance = null;
  runtimeNpc.blackboard.activeAttackNodeId = null;
  runtimeNpc.blackboard.selectedAttackMoveId = null;
}

function getRuntimeLockTargetConfig(node) {
  const params = node?.params?.lockTarget || {};
  return {
    turnSpeed: Math.max(0.01, asFiniteNumber(params.turnSpeed, DEFAULT_LOCK_TURN_SPEED)),
  };
}

function getRuntimeAttackConfig(node) {
  const params = node?.params?.attack || {};
  return {
    attackAngleDegrees: Math.max(0, asFiniteNumber(params.attackAngleDegrees, DEFAULT_ATTACK_ARC_DEGREES)),
    attackDistance: Math.max(0, asFiniteNumber(params.attackDistance, DEFAULT_ATTACK_DISTANCE)),
    combatMoveId: String(params.combatMoveId || ""),
  };
}

function applyFallbackNpcCommand(runtimeNpc, command, mode) {
  if (mode === "attack") {
    command.attackTarget = runtimeNpc.blackboard.lockedTarget || runtimeNpc.blackboard.lookTarget;
  } else if (mode === "flee") {
    command.moveTarget = runtimeNpc.ai.result?.blackboard?.fleePosition || runtimeNpc.blackboard.randomPosition;
    command.moveSpeed = runtimeNpc.moveSpeed.normal * 1.25;
  } else {
    command.moveTarget = runtimeNpc.blackboard.randomPosition;
  }
}

function applyNpcBehaviorNode(runtimeNpc, brainResult, command, node) {
  const type = node.type;
  const bindings = node.params?.bindings || {};
  if (type === "lookAt") {
    command.lookTarget = resolveRuntimeBinding(runtimeNpc, brainResult, bindings.targetPos || "highestDanger");
  } else if (type === "lockTarget") {
    const target = resolveRuntimeBinding(runtimeNpc, brainResult, bindings.targetPos || "lookTarget");
    const lockedTarget = target || runtimeNpc.blackboard.lockedTarget;
    runtimeNpc.blackboard.lockedTarget = lockedTarget;
    command.lockNode = node;
    command.lockTarget = lockedTarget;
    command.lockTurnSpeed = getRuntimeLockTargetConfig(node).turnSpeed;
    command.lookTarget = lockedTarget;
    command.combatMode = true;
  } else if (type === "attack") {
    command.combatMode = true;
    command.attackNodes.push(node);
    if (!command.attackTarget) {
      command.attackTarget = resolveRuntimeBinding(runtimeNpc, brainResult, bindings.targetPos || "lockedTarget");
    }
    command.moveSpeed = runtimeNpc.moveSpeed.combat;
  } else if (type === "run") {
    command.moveTarget = resolveRuntimeBinding(runtimeNpc, brainResult, bindings.destinationPos || "fleeFromHighestDanger");
    command.moveSpeed = runtimeNpc.moveSpeed.normal * 1.25;
  } else if (type === "walk" || type === "move") {
    command.moveTarget = resolveRuntimeBinding(runtimeNpc, brainResult, bindings.destinationPos || "randomPosition");
  }
}

function getRuntimeBehaviorState(behaviorTree, mode) {
  return behaviorTree?.behaviorModes?.[mode]
    || behaviorTree?.behaviorModes?.default
    || null;
}

function getOrderedRuntimeBehaviorNodes(behaviorTree, mode) {
  const stateForMode = getRuntimeBehaviorState(behaviorTree, mode);
  if (!stateForMode?.nodes?.length) return [];

  const nodesById = new Map(stateForMode.nodes.map((node) => [node.id, node]));
  const transitions = Array.isArray(stateForMode.transitions) ? stateForMode.transitions : [];
  const ordered = [];
  const visited = new Set();
  let current = transitions.find((transition) => transition.from === "entry")?.to;

  while (current && nodesById.has(current) && !visited.has(current)) {
    visited.add(current);
    ordered.push(nodesById.get(current));
    current = transitions.find((transition) => transition.from === current)?.to;
  }

  if (ordered.length) return ordered;
  return stateForMode.nodes.slice().sort((a, b) => (a.x || 0) - (b.x || 0));
}

function resolveRuntimeBinding(runtimeNpc, brainResult, selector) {
  switch (selector) {
    case "highestDanger":
      return brainResult?.blackboard?.highestDangerTarget || null;
    case "weakestDanger":
      return brainResult?.blackboard?.weakestDangerTarget || null;
    case "lookTarget":
      return runtimeNpc.blackboard.lookTarget || brainResult?.blackboard?.lookTarget || null;
    case "lockedTarget":
      return runtimeNpc.blackboard.lockedTarget || brainResult?.blackboard?.lockedTarget || null;
    case "randomPosition":
      runtimeNpc.blackboard.randomPosition = getOrCreateNpcRandomPosition(runtimeNpc);
      return runtimeNpc.blackboard.randomPosition;
    case "fleeFromHighestDanger":
      return brainResult?.blackboard?.fleePosition || runtimeNpc.blackboard.randomPosition;
    case "selfPosition":
      return runtimeNpc.character.root.position;
    default:
      return null;
  }
}

function getRuntimePosition(value) {
  if (!value) return null;
  if (value.isVector3) return value;
  if (value.runtimeCharacter?.root) return value.runtimeCharacter.root.position;
  if (Array.isArray(value) && value.length >= 3) {
    return new THREE.Vector3(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
  }
  if (Array.isArray(value.position) && value.position.length >= 3) {
    return new THREE.Vector3(Number(value.position[0]) || 0, Number(value.position[1]) || 0, Number(value.position[2]) || 0);
  }
  if (value.position?.isVector3) return value.position;
  if (value.position && typeof value.position === "object") {
    return new THREE.Vector3(Number(value.position.x) || 0, Number(value.position.y) || 0, Number(value.position.z) || 0);
  }
  return null;
}

function getOrCreateNpcRandomPosition(runtimeNpc) {
  const current = getRuntimePosition(runtimeNpc.blackboard.randomPosition);
  if (current && runtimeNpc.character.root.position.distanceTo(current) > NPC_RANDOM_REACH_DISTANCE) {
    return current.toArray();
  }

  const radius = Number(runtimeNpc.behaviorTree?.brain?.blackboardSources?.randomPosition?.radius) || 6;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const angle = Math.random() * Math.PI * 2;
    const distance = radius * (0.35 + Math.random() * 0.65);
    const position = runtimeNpc.character.root.position.clone().add(new THREE.Vector3(
      Math.sin(angle) * distance,
      0,
      Math.cos(angle) * distance,
    ));
    position.x = THREE.MathUtils.clamp(position.x, -WORLD_SIZE * TILE_SIZE + 1, WORLD_SIZE * TILE_SIZE - 1);
    position.z = THREE.MathUtils.clamp(position.z, -WORLD_SIZE * TILE_SIZE + 1, WORLD_SIZE * TILE_SIZE - 1);
    if (canMoveTo(position)) return position.toArray();
  }

  return runtimeNpc.character.root.position.toArray();
}

function updateNpcCombatAttack(runtimeNpc, shouldAttack, delta, attackNode = null) {
  const attack = runtimeNpc.combatAttack;
  attack.aiCooldown = Math.max(0, (attack.aiCooldown || 0) - delta);
  if (!shouldAttack && !attack.active) {
    cancelCharacterCombatAttack(attack);
    return null;
  }

  if (!attack.active) {
    if (attack.aiCooldown <= 0) {
      const attackConfig = getRuntimeAttackConfig(attackNode);
      const preferredMove = getRuntimeCombatMoveById(attackConfig.combatMoveId);
      beginCharacterCombatAttack(
        runtimeNpc.character,
        attack,
        preferredMove?.triggerDirection || resolveNpcCombatAttackDirection(runtimeNpc),
        preferredMove,
      );
    }
    return attack.activeActionName;
  }

  const actionName = attack.activeActionName;
  const action = runtimeNpc.character.actions[actionName];
  if (!action) {
    cancelCharacterCombatAttack(attack);
    return null;
  }

  runtimeNpc.character.desiredAction = action;
  if (runtimeNpc.character.currentAction !== action || !isCombatAttackComplete(actionName, action)) {
    if (runtimeNpc.character.currentAction === action) {
      evaluateCombatAttackHits(runtimeNpc.character, attack, getNpcCombatTargets(runtimeNpc));
    }
    return actionName;
  }

  finishCharacterCombatAttack(attack);
  attack.aiCooldown = NPC_ATTACK_COOLDOWN;
  return null;
}

function resolveNpcCombatAttackDirection(runtimeNpc) {
  // NPCs currently face their attack target before striking, so their default
  // attack intent is forward. Future AI nodes can return left/right intents here.
  return runtimeNpc?.blackboard?.attackDirection || "forward";
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
