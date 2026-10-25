import * as THREE from "three/webgpu";
import { createSafeRenderer } from "./renderer-utils.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createFacingMarker } from "./facing-marker.js";
import { normalizeInterruptWindow, isActionInterruptible } from "./combat-controls.js";
import { normalizeCombatMoveManager, getCombatMoveActionNames } from "./combat-move-manager.js";
import {
  applyPreviewPose as applySharedPreviewPose,
  filterAnimationTracks,
  computeAnimNaturalSpeed,
  getPlaybackScale,
  getPlaybackPolicy,
  calculateClipRootCycle,
  getDetrendedRootPose,
  computeIntegratedRootMotion as computeSharedRootMotion,
} from "./animation-motion.js";
import "./motion-editor.css";
import "./editor-theme.css";
import { initializeEditorUi } from "./editor-ui.js";

const ASSET_VERSION = "combat-state-20260527-02";
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
const BUILT_IN_ANIMATION_NAMES = new Set(Object.keys(ASSETS.animations));

const ROOT_TRACK_NAME = "Root";
const CHARACTER_HEIGHT = 2.2;
const PREVIEW_BASE_YAW = Math.PI;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const PLAYER_SPEED = 2;
const TRAIL_SEGMENTS = 96;

const CONTROL_SCHEMA = [
  { group: "行为切换", key: "interruptWindow", label: "动作可打断区间", type: "interrupt" },
  { group: "基础", key: "motionMode", label: "Motion Mode", type: "select", options: ["InPlace", "RootMotion"], defaultValue: "InPlace", affectsClip: true },
  { group: "姿态修正", key: "visualYawOffsetDegrees", label: "可视朝向偏移", type: "range", min: -180, max: 180, step: 1, defaultValue: 0 },
  { group: "Root Pose", key: "bakeIntoPoseXZ", label: "Root Pose XZ Bake", type: "checkbox", defaultValue: true, affectsClip: true },
  { group: "Root Pose", key: "bakeIntoPoseY", label: "Root Pose Y Bake", type: "checkbox", defaultValue: true, affectsClip: true },
  { group: "Root Pose", key: "bakeIntoPoseRotation", label: "Bake Root Rotation", type: "checkbox", defaultValue: true, affectsClip: true, visibleWhen: isInPlaceMode },
  { group: "Root Pose", key: "rootSwayScale", label: "Root Pose Sway Scale", type: "range", min: 0, max: 1.5, step: 0.01, defaultValue: 1, affectsClip: true },
  { group: "Root Motion", key: "applyRootRotation", label: "应用 Root 旋转", type: "checkbox", defaultValue: true, affectsClip: true, visibleWhen: isRootMotionMode },
  { group: "Root Motion", key: "rootPoseRotation", label: "保留 Root 姿态旋转", type: "checkbox", defaultValue: false, visibleWhen: isRootMotionMode },
  { group: "Root Motion", key: "rootPoseRotationAnchor", label: "Root 姿态锚点", type: "select", options: ["entryPose", "clipStart"], defaultValue: "entryPose", visibleWhen: isRootPoseRotationEnabled },
  { group: "Root Motion", key: "rootPoseRotationScale", label: "Root 姿态旋转强度", type: "range", min: 0, max: 1, step: 0.01, defaultValue: 1, visibleWhen: isRootPoseRotationEnabled },
  { group: "Root Motion", key: "rootMotionMoveBasis", label: "位移基准", type: "select", options: ["clipRootDelta", "characterForward"], defaultValue: "clipRootDelta", visibleWhen: isRootMotionMode },
  { group: "Root Motion", key: "rootMotionForwardOnly", label: "只取前向位移", type: "checkbox", defaultValue: false, visibleWhen: isRootMotionMode },
  { group: "移动/速度", key: "codeMoveBasis", label: "代码位移基准", type: "select", options: ["characterForward", "clipRootDelta"], defaultValue: "characterForward", visibleWhen: isCodeMoveDirectionVisible },
  { group: "移动/速度", key: "codeMoveYawOffsetDegrees", label: "代码位移朝向偏移", type: "range", min: -180, max: 180, step: 1, defaultValue: 0, visibleWhen: isCodeMoveDirectionVisible },
  { group: "移动/速度", key: "codeMoveSpeed", label: "动作目标速度/播放速度", type: "range", min: 0, max: 6, step: 0.05, defaultValue: PLAYER_SPEED, visibleWhen: isCodeMoveSpeedVisible },
  { group: "脚底锁定", key: "footLock", label: "Foot Lock", type: "checkbox", defaultValue: false, visibleWhen: isFootLockAvailable },
  { group: "脚底锁定", key: "footLockContactY", label: "接触高度", type: "number", min: 0, max: 1, step: 0.01, defaultValue: 0.09, visibleWhen: isFootLockEnabled },
  { group: "脚底锁定", key: "footLockReleaseY", label: "释放高度", type: "number", min: 0, max: 1, step: 0.01, defaultValue: 0.17, visibleWhen: isFootLockEnabled },
  { group: "脚底锁定", key: "footLockStrength", label: "锁定强度", type: "range", min: 0, max: 1, step: 0.01, defaultValue: 1, visibleWhen: isFootLockEnabled },
];

const CONTROL_BY_KEY = new Map(CONTROL_SCHEMA.map((control) => [control.key, control]));
const loader = new GLTFLoader();
const clock = new THREE.Clock();
const lastPreviewFollowPosition = new THREE.Vector3();
const scratchVector = new THREE.Vector3();
let altRightDragging = false;
let altRightPrevY = 0;

let renderer;
let scene;
let camera;
let controls;
let rootMarker;
let facingMarker;
let rootTrail;
let previewGround;
let previewGrid;
let animationAssetFiles = [];
let motionConfig = {};
let gameplayAttackNames = null;
let animations = {};
let characters = {};
let activeCharacter = null;
let activeAction = null;
let activeClip = null;
let activeFilteredClip = null;

const editor = {
  selectedActionName: null,
  selectedGender: "male",
  playing: true,
  dirty: false,
  showGround: true,
  showGrid: true,
  showSkeleton: false,
  previewLoopByAction: {},
  time: 0,
  duration: 0,
};

const refs = {};
const advancedGroupOpen = new Map();

window.__MOTION_EDITOR_READY = false;
window.__MOTION_EDITOR_ERROR = null;

boot();

async function boot() {
  mountUi();
  initializeEditorUi();
  bindUi();

  try {
    setStatus("加载 Motion Config...");
    motionConfig = await loadMotionConfig();
    gameplayAttackNames = await loadGameplayAttackNames();
    animationAssetFiles = await loadAnimationAssetFiles();
    registerConfiguredAnimationAssets();
    editor.selectedActionName = pickInitialAction();
    renderActionList();
    renderFields();

    setStatus("初始化 WebGPU...");
    await initRenderer();

    setStatus("加载动作与角色...");
    animations = await loadAnimations();
    characters = await loadCharacters();
    selectCharacter(editor.selectedGender);
    await selectAction(editor.selectedActionName);

    window.__MOTION_EDITOR_READY = true;
    document.body.dataset.ready = "true";
    setStatus("预览就绪", "saved");
    renderer.setAnimationLoop(update);
  } catch (error) {
    console.error(error);
    window.__MOTION_EDITOR_ERROR = error.message;
    setStatus(`初始化失败：${error.message}`, "bad");
  }
}

function mountUi() {
  const app = document.querySelector("#editor-app");
  app.innerHTML = `
    <div class="editor-shell">
      <aside class="action-rail">
        <div class="editor-brand">
          <strong>动作编辑器</strong>
          <span>motion_config.json</span>
        </div>
        <label class="compact-field">
          预览角色
          <select data-gender>
            <option value="male">男主角</option>
            <option value="female">女主角</option>
          </select>
        </label>
        <section class="add-action-panel">
          <label class="compact-field">
            添加动作
            <select data-add-asset></select>
          </label>
          <div class="add-action-row">
            <input data-add-action-name type="text" />
            <button type="button" data-add-action>添加</button>
          </div>
        </section>
        <div class="action-list" data-action-list></div>
      </aside>

      <main class="preview-column">
        <section class="preview-stage" data-viewport>
          <div class="status-pill" data-status>准备中...</div>
          <div class="preview-toggles">
            <button class="toggle-button active" type="button" data-toggle-ground>地板</button>
            <button class="toggle-button active" type="button" data-toggle-grid>网格</button>
            <button class="toggle-button" type="button" data-toggle-skeleton>骨骼</button>
          </div>
          <div class="readout" data-readout></div>
        </section>
        <section class="timeline-bar">
          <button data-play>暂停</button>
          <button data-stop>归零</button>
          <input data-timeline type="range" min="0" max="1" step="0.001" value="0" />
          <div class="time-text" data-time>0.00 / 0.00s</div>
        </section>
      </main>

      <aside class="property-panel">
        <div class="panel-head">
          <div class="panel-title">
            <h1 data-action-title>未选择动作</h1>
            <span data-action-subtitle>Motion Config</span>
          </div>
          <button class="save-button" data-save>保存</button>
        </div>
        <div class="field-scroll" data-fields></div>
      </aside>
    </div>
  `;

  refs.actionList = document.querySelector("[data-action-list]");
  refs.gender = document.querySelector("[data-gender]");
  refs.addAsset = document.querySelector("[data-add-asset]");
  refs.addActionName = document.querySelector("[data-add-action-name]");
  refs.addAction = document.querySelector("[data-add-action]");
  refs.viewport = document.querySelector("[data-viewport]");
  refs.status = document.querySelector("[data-status]");
  refs.toggleGround = document.querySelector("[data-toggle-ground]");
  refs.toggleGrid = document.querySelector("[data-toggle-grid]");
  refs.toggleSkeleton = document.querySelector("[data-toggle-skeleton]");
  refs.readout = document.querySelector("[data-readout]");
  refs.play = document.querySelector("[data-play]");
  refs.stop = document.querySelector("[data-stop]");
  refs.timeline = document.querySelector("[data-timeline]");
  refs.time = document.querySelector("[data-time]");
  refs.save = document.querySelector("[data-save]");
  refs.fields = document.querySelector("[data-fields]");
  refs.actionTitle = document.querySelector("[data-action-title]");
  refs.actionSubtitle = document.querySelector("[data-action-subtitle]");
}

function bindUi() {
  refs.gender.addEventListener("change", () => selectCharacter(refs.gender.value));
  refs.addAsset.addEventListener("change", () => updateAddActionName());
  refs.addAction.addEventListener("click", addSelectedAnimationAction);

  refs.play.addEventListener("click", () => {
    editor.playing = !editor.playing;
    updatePlayButton();
  });

  refs.stop.addEventListener("click", () => {
    editor.playing = false;
    editor.time = 0;
    applyPreviewPose();
    updatePlayButton();
  });

  refs.toggleGround.addEventListener("click", () => togglePreviewLayer("ground"));
  refs.toggleGrid.addEventListener("click", () => togglePreviewLayer("grid"));
  refs.toggleSkeleton.addEventListener("click", () => togglePreviewLayer("skeleton"));

  refs.timeline.addEventListener("input", () => {
    editor.time = Number(refs.timeline.value) || 0;
    editor.playing = false;
    applyPreviewPose();
    updatePlayButton();
  });

  refs.save.addEventListener("click", saveMotionConfig);

  window.addEventListener("resize", resize);
  window.addEventListener("beforeunload", (event) => {
    if (!editor.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function loadMotionConfig() {
  try {
    const response = await fetch("/api/motion-config", { cache: "no-store" });
    if (response.ok) return response.json();
  } catch {
    // Static builds do not have the dev write API.
  }

  const response = await fetch(assetUrl("./assets/animations/motion_config.json"), { cache: "no-store" });
  if (!response.ok) throw new Error(`motion_config.json 加载失败：${response.status}`);
  return response.json();
}

async function loadAnimationAssetFiles() {
  try {
    const response = await fetch("/api/animation-assets", { cache: "no-store" });
    if (response.ok) {
      const payload = await response.json();
      return Array.isArray(payload.files) ? payload.files : [];
    }
  } catch {
    // Static builds do not expose a directory listing.
  }

  return Object.values(ASSETS.animations)
    .map((url) => decodeURIComponent(url.split("?")[0].split("/").pop()))
    .filter(Boolean);
}

function registerConfiguredAnimationAssets() {
  animationAssetFiles.forEach((fileName) => {
    const actionName = findConfiguredActionNameForAsset(fileName);
    if (motionConfig[actionName] && !ASSETS.animations[actionName]) {
      ASSETS.animations[actionName] = assetUrl(`./assets/animations/${fileName}`);
    }
  });
  renderAddActionOptions();
}

async function initRenderer() {
scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d0c);

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(3.8, 2.7, 4.6);

  renderer = await createSafeRenderer(THREE, { antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  refs.viewport.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.05, 0);
  controls.enableDamping = true;
  controls.minDistance = 2.4;
  controls.maxDistance = 10;
  controls.mouseButtons = { LEFT: -1, MIDDLE: -1, RIGHT: 0 };
  controls.update();

  bindAltRightDolly();

  scene.add(new THREE.AmbientLight(0xffffff, 2.4));
  const hemi = new THREE.HemisphereLight(0xd8ecff, 0x51452f, 2.6);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffdfaa, 5.2);
  key.position.set(-3.8, 6.4, 4.2);
  key.castShadow = true;
  scene.add(key);

  previewGround = new THREE.Mesh(
    new THREE.CircleGeometry(4.5, 72),
    new THREE.MeshStandardMaterial({ color: 0x20251f, roughness: 0.92 }),
  );
  previewGround.name = "PreviewGround";
  previewGround.rotation.x = -Math.PI / 2;
  previewGround.position.y = -0.015;
  previewGround.receiveShadow = true;
  scene.add(previewGround);

  previewGrid = new THREE.GridHelper(8, 16, 0x79d2c0, 0x3c473d);
  previewGrid.name = "PreviewGrid";
  previewGrid.position.y = 0.005;
  scene.add(previewGrid);
  updatePreviewLayerButtons();

  rootMarker = createRootMarker();
  facingMarker = createFacingMarker(THREE);
  rootTrail = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x79d2c0, transparent: true, opacity: 0.72, depthTest: false }),
  );
  rootTrail.renderOrder = 3;
  scene.add(rootTrail, rootMarker, facingMarker);

  resize();
}

function bindAltRightDolly() {
  const canvas = renderer.domElement;
  if (!canvas) return;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", onAltRightPointerDown, true);
  window.addEventListener("pointermove", onAltRightPointerMove);
  window.addEventListener("pointerup", onAltRightPointerUp);
}

function onAltRightPointerDown(event) {
  if (event.button !== 2 || !event.altKey) return;
  altRightDragging = true;
  altRightPrevY = event.clientY;
  controls.enabled = false;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function onAltRightPointerMove(event) {
  if (!altRightDragging) return;
  const deltaY = altRightPrevY - event.clientY;
  altRightPrevY = event.clientY;
  const dist = camera.position.distanceTo(controls.target);
  const scale = 1 + deltaY * 0.005;
  const newDist = Math.max(
    controls.minDistance,
    Math.min(controls.maxDistance, dist * scale),
  );
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
  camera.position.copy(controls.target).addScaledVector(dir, newDist);
}

function onAltRightPointerUp() {
  if (!altRightDragging) return;
  altRightDragging = false;
  controls.enabled = true;
}

async function loadAnimations() {
  const entries = await Promise.all(
    Object.entries(ASSETS.animations).map(async ([name, url]) => {
      return [name, await loadAnimationClip(name, url)];
    }),
  );
  return Object.fromEntries(entries);
}

async function loadAnimationAction(actionName) {
  if (animations[actionName]) return animations[actionName];
  const url = ASSETS.animations[actionName];
  if (!url) throw new Error(`没有找到 ${actionName} 对应的 GLB 资源`);

  const clip = await loadAnimationClip(actionName, url);
  animations[actionName] = clip;
  return clip;
}

async function loadAnimationClip(actionName, url) {
  const gltf = await loader.loadAsync(url);
  return mergeAnimationClips(gltf.animations, actionName);
}

async function loadCharacters() {
  const [male, female] = await Promise.all([
    createCharacter("male", ASSETS.models.male),
    createCharacter("female", ASSETS.models.female),
  ]);
  scene.add(male.root, female.root);
  return { male, female };
}

async function createCharacter(gender, url) {
  const gltf = await loader.loadAsync(url);
  const root = new THREE.Group();
  root.name = `MotionPreview_${gender}`;
  root.visible = false;
  root.rotation.y = PREVIEW_BASE_YAW;
  root.add(gltf.scene);

  normalizeModel(gltf.scene);
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
  });

  const skeletonRoot = gltf.scene.getObjectByName(ROOT_TRACK_NAME);
  const rootRestPosition = skeletonRoot ? skeletonRoot.position.clone() : new THREE.Vector3();
  const rootRestQuaternion = skeletonRoot ? skeletonRoot.quaternion.clone() : new THREE.Quaternion();
  const meshes = [];
  gltf.scene.traverse((obj) => {
    if (obj.isMesh || obj.isSkinnedMesh) meshes.push(obj);
  });
  const skeletonOverlay = createSkeletonOverlay(gltf.scene);
  scene.add(skeletonOverlay.group);

  return {
    gender,
    root,
    scene: gltf.scene,
    mixer: new THREE.AnimationMixer(gltf.scene),
    meshes,
    skeletonOverlay,
    restModel: captureRestModel(gltf.scene),
    rootRestPosition,
    rootRestQuaternion,
    sceneRestRotationY: gltf.scene.rotation.y,
  };
}

function selectCharacter(gender) {
  editor.selectedGender = gender;
  refs.gender.value = gender;
  Object.values(characters).forEach((character) => {
    character.root.visible = false;
    character.skeletonOverlay.group.visible = false;
  });

  activeCharacter = characters[gender] ?? null;
  if (!activeCharacter) return;

  activeCharacter.root.visible = true;
  updateCharacterVisibility(activeCharacter);
  rebuildPreviewAction(true);
}

async function selectAction(actionName) {
  if (!actionName) return;
  activeAction?.stop();
  if (activeAction) activeAction.getMixer().uncacheAction(activeAction.getClip());
  activeAction = null;
  activeClip = null;
  editor.duration = 0;
  editor.selectedActionName = actionName;
  ensurePreviewOptions(actionName);
  editor.time = 0;
  renderActionList();
  renderFields();
  try {
    if (!animations[actionName] && ASSETS.animations[actionName]) {
      setStatus(`加载动作 ${actionName}...`);
      await loadAnimationAction(actionName);
      if (editor.selectedActionName !== actionName) return;
      setStatus("预览就绪", "saved");
      renderActionList();
    }
    if (editor.selectedActionName !== actionName) return;
    rebuildPreviewAction(false);
  } catch (error) {
    if (editor.selectedActionName !== actionName) return;
    setStatus(`动作加载失败：${error.message}`, "bad");
  }
}

function rebuildPreviewAction(preserveTime = true) {
  if (!activeCharacter || !editor.selectedActionName || !animations[editor.selectedActionName]) return;

  const previousTime = preserveTime ? editor.time : 0;
  const config = currentConfig();
  activeClip = animations[editor.selectedActionName];
  activeFilteredClip = filterAnimationTracks(activeClip, activeCharacter.restModel, motionConfig[editor.selectedActionName]);
  editor.duration = activeClip.duration || activeFilteredClip.duration || 0;
  editor.time = normalizePreviewTime(previousTime);

  activeAction?.stop();
  if (activeAction) activeAction.getMixer().uncacheAction(activeAction.getClip());
  activeCharacter.mixer.stopAllAction();
  activeAction = activeCharacter.mixer.clipAction(activeFilteredClip);
  activeAction.enabled = true;
  activeAction.setEffectiveWeight(1);
  setActionLoop(activeAction);
  activeAction.reset().play();

  applyPreviewPose();
  updateTrail();
  updateActionTitle();
}

function followPreviewRoot() {
  if (!activeCharacter || !camera || !controls) return;
  const position = activeCharacter.root.getWorldPosition(new THREE.Vector3());
  position.y = 0;
  const delta = position.clone().sub(lastPreviewFollowPosition);
  camera.position.add(delta);
  controls.target.add(delta);
  lastPreviewFollowPosition.copy(position);
}

function applyPreviewPose() {
  if (!activeCharacter || !activeAction || !activeClip) {
    followPreviewRoot();
    updateTimelineUi();
    updateReadout();
    return;
  }

  const config = currentConfig();
  const time = normalizePreviewTime(editor.time);
  applySharedPreviewPose(activeCharacter, activeAction, activeClip, time, config, {
    baseYaw: PREVIEW_BASE_YAW,
    codeMovement: editor.selectedActionName === "walk" || editor.selectedActionName === "combatWalk",
  });
  followPreviewRoot();
  updateRootMarker();
  updateFacingMarker();
  updateSkeletonOverlay(activeCharacter);
  updateTimelineUi();
  updateReadout();
  updateDebugState();
}

function update(timeMs) {
  const delta = Math.min(clock.getDelta(), 0.05);
  controls?.update();

  if (editor.playing && activeAction && editor.duration > 0) {
    const config = currentConfig();
    editor.time += delta * getPreviewPlaybackScale();
    if (!getPreviewLoop() && editor.time >= editor.duration) {
      editor.time = editor.duration;
      editor.playing = false;
      updatePlayButton();
    } else {
      editor.time = editor.time % editor.duration;
    }
    applyPreviewPose();
  }

  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

function togglePreviewLayer(layerName) {
  if (layerName === "ground") {
    editor.showGround = !editor.showGround;
  } else if (layerName === "grid") {
    editor.showGrid = !editor.showGrid;
  } else if (layerName === "skeleton") {
    editor.showSkeleton = !editor.showSkeleton;
  }
  updatePreviewLayerButtons();
  Object.values(characters).forEach(updateCharacterVisibility);
  if (activeCharacter) updateSkeletonOverlay(activeCharacter);
  updateDebugState();
}

function updatePreviewLayerButtons() {
  if (previewGround) previewGround.visible = editor.showGround;
  if (previewGrid) previewGrid.visible = editor.showGrid;

  refs.toggleGround?.classList.toggle("active", editor.showGround);
  refs.toggleGround?.setAttribute("aria-pressed", String(editor.showGround));
  refs.toggleGrid?.classList.toggle("active", editor.showGrid);
  refs.toggleGrid?.setAttribute("aria-pressed", String(editor.showGrid));
  refs.toggleSkeleton?.classList.toggle("active", editor.showSkeleton);
  refs.toggleSkeleton?.setAttribute("aria-pressed", String(editor.showSkeleton));
}

function renderAddActionOptions() {
  if (!refs.addAsset) return;

  const selectedValue = refs.addAsset.value;
  refs.addAsset.innerHTML = "";

  const availableFiles = animationAssetFiles.filter((fileName) => {
    return !findConfiguredActionNameForAsset(fileName) && !isAnimationFileRegistered(fileName);
  });

  if (!availableFiles.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "没有可添加动作";
    refs.addAsset.appendChild(option);
    refs.addAsset.disabled = true;
    refs.addAction.disabled = true;
    refs.addActionName.value = "";
    return;
  }

  refs.addAsset.disabled = false;
  refs.addAction.disabled = false;
  availableFiles.forEach((fileName) => {
    const option = document.createElement("option");
    option.value = fileName;
    option.textContent = fileName;
    refs.addAsset.appendChild(option);
  });
  if (availableFiles.includes(selectedValue)) refs.addAsset.value = selectedValue;
  updateAddActionName();
}

function isAnimationFileRegistered(fileName) {
  return Object.entries(ASSETS.animations).some(([actionName, url]) => {
    if (!BUILT_IN_ANIMATION_NAMES.has(actionName) && !motionConfig[actionName]) return false;
    const registeredFile = decodeURIComponent(url.split("?")[0].split("/").pop() ?? "");
    return registeredFile.toLowerCase() === fileName.toLowerCase();
  });
}

function updateAddActionName() {
  if (!refs.addAsset?.value) {
    refs.addActionName.value = "";
    return;
  }
  refs.addActionName.value = getActionNameFromAssetFile(refs.addAsset.value);
}

async function addSelectedAnimationAction() {
  const fileName = refs.addAsset.value;
  const actionName = sanitizeActionName(refs.addActionName.value);
  if (!fileName || !actionName) return;

  if (motionConfig[actionName]) {
    setStatus(`${actionName} 已存在`, "bad");
    return;
  }

  refs.addAction.disabled = true;
  setStatus(`添加动作 ${actionName}...`);

  try {
    ASSETS.animations[actionName] = assetUrl(`./assets/animations/${fileName}`);
    motionConfig[actionName] = createDefaultMotionConfig();
    ensurePreviewOptions(actionName);
    await loadAnimationAction(actionName);
    setDirty(true);
    renderAddActionOptions();
    renderActionList();
    await selectAction(actionName);
    if (!await saveMotionConfig()) return;
    setStatus(`已添加 ${actionName}`, "saved");
  } catch (error) {
    delete ASSETS.animations[actionName];
    delete animations[actionName];
    delete motionConfig[actionName];
    setStatus(`添加失败：${error.message}`, "bad");
  } finally {
    refs.addAction.disabled = false;
    renderAddActionOptions();
  }
}

function canDeleteAction(actionName) {
  return !!motionConfig[actionName] && !BUILT_IN_ANIMATION_NAMES.has(actionName);
}

async function deleteAction(actionName) {
  if (!canDeleteAction(actionName)) return;

  const nextActionName = getActionNames().find((candidate) => (
    candidate !== actionName && ASSETS.animations[candidate]
  ));

  delete motionConfig[actionName];
  delete ASSETS.animations[actionName];
  delete animations[actionName];
  delete editor.previewLoopByAction[actionName];

  if (editor.selectedActionName === actionName) {
    activeAction = null;
    activeClip = null;
    activeFilteredClip = null;
    editor.selectedActionName = nextActionName ?? null;
    editor.time = 0;
    editor.duration = 0;
    activeCharacter?.mixer.stopAllAction();
  }

  setDirty(true);
  renderAddActionOptions();
  renderActionList();

  try {
    if (editor.selectedActionName) {
      await selectAction(editor.selectedActionName);
    } else {
      renderFields();
      updateTimelineUi();
      updateReadout();
      updateDebugState();
    }
    if (!await saveMotionConfig()) return;
    setStatus(`已删除 ${actionName}`, "saved");
  } catch (error) {
    setStatus(`删除后保存失败：${error.message}`, "bad");
  }
}

function renderActionList() {
  const actionNames = getActionNames();
  refs.actionList.innerHTML = "";
  actionNames.forEach((actionName) => {
    const item = document.createElement("div");
    item.className = "action-item";
    item.classList.toggle("active", actionName === editor.selectedActionName);
    item.classList.toggle("disabled", !ASSETS.animations[actionName]);
    item.addEventListener("click", () => {
      if (ASSETS.animations[actionName]) selectAction(actionName);
    });
    const name = document.createElement("span");
    name.className = "action-name";
    name.textContent = actionName;
    const mode = document.createElement("span");
    mode.className = "action-mode";
    mode.textContent = motionConfig[actionName]?.motionMode ?? "InPlace";
    item.append(name, mode);

    if (canDeleteAction(actionName)) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "delete-action-button";
      deleteButton.dataset.icon = "trash-2";
      deleteButton.textContent = "删除";
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteAction(actionName);
      });
      item.appendChild(deleteButton);
    }

    refs.actionList.appendChild(item);
  });
}

function renderFields() {
  refs.fields.querySelectorAll("details[data-motion-group]").forEach((group) => {
    advancedGroupOpen.set(group.dataset.motionGroup, group.open);
  });
  const actionName = editor.selectedActionName;
  if (!actionName) {
    refs.fields.innerHTML = "";
    refs.actionTitle.textContent = "未选择动作";
    refs.actionSubtitle.textContent = "Motion Config";
    return;
  }
  const config = currentConfig();
  ensurePreviewOptions(actionName);
  refs.fields.innerHTML = "";
  refs.actionTitle.textContent = actionName ?? "未选择动作";
  updateActionTitle();

  refs.fields.appendChild(createPreviewOptions());
  const rules = document.createElement("output");
  rules.className = "effective-rules";
  rules.dataset.effectiveRules = "";
  rules.setAttribute("aria-label", "当前生效规则");
  refs.fields.appendChild(rules);

  const groups = new Map();
  CONTROL_SCHEMA.forEach((control) => {
    if (!isControlVisible(control, config, actionName)) return;
    if (!groups.has(control.group)) groups.set(control.group, []);
    groups.get(control.group).push(control);
  });

  groups.forEach((controlsInGroup, groupName) => {
    const group = createMotionGroup(groupName, groupName === "基础" || groupName === "行为切换");
    controlsInGroup.forEach((control) => group.appendChild(createControl(control, config)));
    refs.fields.appendChild(group);
  });

  const unknownKeys = Object.keys(config).filter((key) => !CONTROL_BY_KEY.has(key));
  if (unknownKeys.length) {
    const group = createMotionGroup("扩展参数");
    unknownKeys.forEach((key) => group.appendChild(createUnknownControl(key, config[key])));
    refs.fields.appendChild(group);
  }

  refs.fields.appendChild(createJsonEditor(config));
  updateEffectiveRules();
}

function createMotionGroup(name, basic = false) {
  const group = document.createElement(basic ? "section" : "details");
  group.className = "field-group";
  const heading = document.createElement(basic ? "h2" : "summary");
  heading.textContent = name;
  group.appendChild(heading);
  if (!basic) {
    group.dataset.motionGroup = name;
    group.open = advancedGroupOpen.get(name) ?? false;
    group.addEventListener("toggle", () => {
      if (group.isConnected) advancedGroupOpen.set(name, group.open);
    });
  }
  return group;
}

function updateEffectiveRules() {
  const output = refs.fields.querySelector("[data-effective-rules]");
  if (!output) return;
  const config = currentConfig();
  const attack = gameplayAttackNames?.has(editor.selectedActionName) ?? false;
  const policy = getPlaybackPolicy(config, { attack });
  const interval = normalizeInterruptWindow(config.interruptWindow);
  const rate = getPreviewPlaybackScale();
  const rules = [
    gameplayAttackNames
      ? `游戏 ${formatNumber(attack ? 1 : rate)}x / ${policy.repetitions === 1 ? "单次" : "循环"}`
      : `配置循环 ${config.loop === false ? "关闭" : "开启"}`,
    `预览 ${getPreviewLoop() ? "循环" : "单次"}`,
  ];
  if (isMoveAction(editor.selectedActionName) && activeClip && activeCharacter) {
    rules.push(`自然速度 ${formatNumber(computeAnimNaturalSpeed(activeClip, activeCharacter))} m/s · 共享速率 ${formatNumber(rate)}x`);
  }
  rules.push(interval
    ? `可打断 ${formatNumber(interval[0] * 100)}%-${formatNumber(interval[1] * 100)}% / ${formatNumber(interval[0] * editor.duration)}-${formatNumber(interval[1] * editor.duration)}s`
    : "可打断区间 未配置 / 旧版规则");
  const text = rules.join(" · ");
  if (output.textContent !== text) output.textContent = text;
}

async function loadGameplayAttackNames() {
  for (const url of ["/api/combat-move-manager", assetUrl("./assets/combat/move_manager.json")]) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) continue;
      const manager = normalizeCombatMoveManager(await response.json());
      return new Set(getCombatMoveActionNames(manager));
    } catch { /* Read-only rule summary can fall back to config values. */ }
  }
  return null;
}

function createPreviewOptions() {
  const group = document.createElement("section");
  group.className = "field-group preview-options";
  const heading = document.createElement("h2");
  heading.textContent = "编辑器预览";

  const row = document.createElement("div");
  row.className = "control-row check-row";
  const label = document.createElement("label");
  const text = document.createElement("span");
  text.textContent = "循环播放";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = getPreviewLoop();
  input.dataset.previewLoop = "";
  input.addEventListener("change", () => updatePreviewLoop(input.checked));
  label.append(text, input);
  row.appendChild(label);

  group.append(heading, row);
  return group;
}

function isControlVisible(control, config, actionName) {
  return control.visibleWhen ? control.visibleWhen(config, actionName) : true;
}

function isInPlaceMode(config) {
  return (config.motionMode ?? "InPlace") === "InPlace";
}

function isRootMotionMode(config) {
  return (config.motionMode ?? "InPlace") === "RootMotion";
}

function isRootPoseRotationEnabled(config) {
  return isRootMotionMode(config) && !!config.rootPoseRotation;
}

function isFootLockAvailable(config) {
  return isInPlaceMode(config) || !!config.footLock;
}

function isFootLockEnabled(config) {
  return isFootLockAvailable(config) && !!config.footLock;
}

function isCodeMoveDirectionVisible(config, actionName) {
  if (isRootMotionMode(config)) return config.rootMotionMoveBasis === "characterForward";
  return isMoveAction(actionName);
}

function isCodeMoveSpeedVisible(config, actionName) {
  return isMoveAction(actionName) || Number.isFinite(Number(config.codeMoveSpeed));
}

function isMoveAction(actionName) {
  return /walk/i.test(actionName ?? "");
}

function createControl(control, config) {
  if (control.type === "interrupt") return createInterruptControl(config);
  const row = document.createElement("div");
  row.className = "control-row";
  const value = config[control.key] ?? control.defaultValue;

  if (control.type === "checkbox") {
    row.classList.add("check-row");
    const label = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = control.label;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!value;
    input.addEventListener("change", () => updateConfigValue(control.key, input.checked));
    label.append(text, input);
    row.appendChild(label);
    const resetButton = createResetButton(control);
    if (resetButton) row.appendChild(resetButton);
    return row;
  }

  row.appendChild(createControlHeader(control));

  if (control.type === "select") {
    const select = document.createElement("select");
    const options = new Set(control.options);
    options.add(String(value));
    options.forEach((optionValue) => {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionValue;
      select.appendChild(option);
    });
    select.value = value;
    select.addEventListener("change", () => updateConfigValue(control.key, select.value));
    row.appendChild(select);
    return row;
  }

  if (control.type === "range") {
    const grid = document.createElement("div");
    grid.className = "range-grid";
    const range = document.createElement("input");
    range.type = "range";
    range.min = control.min;
    range.max = control.max;
    range.step = control.step;
    range.value = Number(value);
    const number = createNumberInput(control, value);

    const apply = (nextValue) => {
      const parsed = clampNumber(nextValue, control);
      range.value = parsed;
      number.value = formatNumber(parsed);
      updateConfigValue(control.key, parsed);
    };

    range.addEventListener("input", () => apply(range.value));
    number.addEventListener("input", () => apply(number.value));
    grid.append(range, number);
    row.appendChild(grid);
    return row;
  }

  const input = createNumberInput(control, value);
  input.addEventListener("input", () => {
    updateConfigValue(control.key, clampNumber(input.value, control));
  });
  row.appendChild(input);
  return row;
}

function createInterruptControl(config) {
  const row = document.createElement("div");
  row.className = "control-row interrupt-control";
  const window = normalizeInterruptWindow(config.interruptWindow);
  const label = document.createElement("label");
  label.className = "interrupt-enable";
  const text = document.createElement("span");
  text.textContent = "动作可打断区间";
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = !!window;
  enabled.dataset.interruptEnabled = "";
  enabled.addEventListener("change", () => {
    updateConfigValue("interruptWindow", enabled.checked ? [0.7, 1] : null);
    renderFields();
  });
  label.append(text, enabled);
  row.append(label);
  if (!window) return row;
  const track = document.createElement("div");
  track.className = "interrupt-track";
  const selection = document.createElement("div");
  selection.className = "interrupt-selection";
  const readout = document.createElement("output");
  readout.dataset.interruptReadout = "";
  const inputs = window.map((value, index) => {
    const input = document.createElement("input");
    input.type = "range";
    input.min = 0; input.max = 1; input.step = 0.001; input.value = value;
    input.setAttribute("aria-label", index ? "可打断区间结束" : "可打断区间开始");
    input.dataset.interruptHandle = String(index);
    input.addEventListener("input", () => {
      const values = inputs.map((item) => Number(item.value));
      values[index] = index ? Math.max(values[0], values[1]) : Math.min(values[0], values[1]);
      input.value = values[index];
      updateConfigValue("interruptWindow", values);
      paint();
    });
    return input;
  });
  function paint() {
    const [start, end] = normalizeInterruptWindow(currentConfig().interruptWindow) || [0, 0];
    inputs[0].style.zIndex = start > 0.5 ? "3" : "2";
    inputs[1].style.zIndex = start > 0.5 ? "2" : "3";
    selection.style.left = `${start * 100}%`;
    selection.style.width = `${(end - start) * 100}%`;
    readout.textContent = `${Math.round(start * 100)}%–${Math.round(end * 100)}% · ${formatNumber(start * editor.duration)}–${formatNumber(end * editor.duration)}s`;
  }
  track.append(selection, ...inputs);
  row.append(track, readout);
  paint();
  return row;
}

function createUnknownControl(key, value) {
  const row = document.createElement("div");
  row.className = typeof value === "boolean" ? "control-row check-row" : "control-row";

  if (typeof value === "boolean") {
    const label = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = key;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value;
    input.addEventListener("change", () => updateConfigValue(key, input.checked));
    label.append(text, input);
    row.appendChild(label);
    return row;
  }

  row.appendChild(createLabel({ label: key, key }));

  if (typeof value === "number") {
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.01";
    input.value = value;
    input.addEventListener("input", () => updateConfigValue(key, Number(input.value)));
    row.appendChild(input);
    return row;
  }

  if (typeof value === "string") {
    const input = document.createElement("input");
    input.value = value;
    input.addEventListener("input", () => updateConfigValue(key, input.value));
    row.appendChild(input);
    return row;
  }

  const textarea = document.createElement("textarea");
  textarea.value = JSON.stringify(value, null, 2);
  textarea.addEventListener("blur", () => {
    try {
      updateConfigValue(key, JSON.parse(textarea.value));
    } catch {
      setStatus(`${key} 不是有效 JSON`, "bad");
    }
  });
  row.appendChild(textarea);
  return row;
}

function createJsonEditor(config) {
  const group = createMotionGroup("当前动作 JSON");
  const textarea = document.createElement("textarea");
  textarea.spellcheck = false;
  textarea.value = JSON.stringify(config, null, 2);
  const message = document.createElement("div");
  message.className = "json-message";
  message.textContent = "JSON";

  textarea.addEventListener("blur", () => {
    try {
      const parsed = JSON.parse(textarea.value);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("动作配置必须是对象");
      }
      motionConfig[editor.selectedActionName] = parsed;
      setDirty(true);
      message.classList.remove("bad");
      message.textContent = "JSON 已应用";
      renderActionList();
      renderFields();
      rebuildPreviewAction(true);
    } catch (error) {
      message.classList.add("bad");
      message.textContent = error.message;
    }
  });

  group.append(textarea, message);
  return group;
}

function createLabel(control) {
  const label = document.createElement("label");
  const text = document.createElement("span");
  text.textContent = control.label;
  const key = document.createElement("span");
  key.textContent = control.key;
  label.append(text, key);
  return label;
}

function createControlHeader(control) {
  const header = document.createElement("div");
  header.className = "control-header";
  header.appendChild(createLabel(control));
  const resetButton = createResetButton(control);
  if (resetButton) header.appendChild(resetButton);
  return header;
}

function createResetButton(control) {
  if (!hasDefaultValue(control)) return null;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "reset-button";
  button.dataset.icon = "rotate-ccw";
  button.textContent = "Reset";
  button.title = `${control.key}: ${formatDefaultValue(control.defaultValue)}`;
  button.setAttribute("aria-label", `Reset ${control.key}`);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    resetConfigValue(control);
  });
  return button;
}

function hasDefaultValue(control) {
  return Object.prototype.hasOwnProperty.call(control, "defaultValue");
}

function createNumberInput(control, value) {
  const input = document.createElement("input");
  input.type = "number";
  if (Number.isFinite(control.min)) input.min = control.min;
  if (Number.isFinite(control.max)) input.max = control.max;
  input.step = control.step ?? 0.01;
  input.value = formatNumber(Number(value));
  return input;
}

function resetConfigValue(control) {
  updateConfigValue(control.key, cloneConfigValue(control.defaultValue));
  renderFields();
}

function updateConfigValue(key, value) {
  const config = ensureActionConfig(editor.selectedActionName);
  config[key] = value;
  setDirty(true);
  renderActionList();

  const control = CONTROL_BY_KEY.get(key);
  if (control?.affectsClip) {
    rebuildPreviewAction(true);
  } else {
    applyPreviewPose();
    updateTrail();
  }
  if (shouldRefreshVisibleControls(key)) {
    renderFields();
    if (key === "motionMode") {
      const relevantGroups = value === "RootMotion" ? ["Root Motion", "Root Pose"] : ["Root Pose", "移动/速度"];
      refs.fields.querySelectorAll("details[data-motion-group]").forEach((group) => {
        if (relevantGroups.includes(group.dataset.motionGroup)) {
          group.open = true;
          advancedGroupOpen.set(group.dataset.motionGroup, true);
        }
      });
    }
  }
}

function cloneConfigValue(value) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object") return structuredClone(value);
  return value;
}

function formatDefaultValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function shouldRefreshVisibleControls(key) {
  return new Set([
    "motionMode",
    "rootPoseRotation",
    "rootMotionMoveBasis",
    "footLock",
  ]).has(key);
}

function ensurePreviewOptions(actionName) {
  if (!actionName || Object.prototype.hasOwnProperty.call(editor.previewLoopByAction, actionName)) return;
  editor.previewLoopByAction[actionName] = motionConfig[actionName]?.loop !== false;
}

function getPreviewLoop() {
  ensurePreviewOptions(editor.selectedActionName);
  return editor.previewLoopByAction[editor.selectedActionName] !== false;
}

function updatePreviewLoop(loop) {
  if (!editor.selectedActionName) return;
  editor.previewLoopByAction[editor.selectedActionName] = loop;
  if (activeAction) setActionLoop(activeAction);
  editor.time = normalizePreviewTime(editor.time);
  applyPreviewPose();
}

async function saveMotionConfig() {
  refs.save.disabled = true;
  setStatus("保存中...");

  try {
    const response = await fetch("/api/motion-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: motionConfig }),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `${response.status} ${response.statusText}`);
    }
    setDirty(false);
    setStatus("已保存到 motion_config.json", "saved");
    return true;
  } catch (error) {
    setStatus(`保存失败：${error.message}`, "bad");
    return false;
  } finally {
    refs.save.disabled = false;
    updateSaveButton();
  }
}

function setDirty(dirty) {
  editor.dirty = dirty;
  updateSaveButton();
}

function updateSaveButton() {
  let marker = refs.save.parentElement.querySelector("[data-dirty-indicator]");
  if (!marker) {
    marker = document.createElement("span");
    marker.dataset.dirtyIndicator = "";
    marker.dataset.icon = "circle-alert";
    marker.setAttribute("role", "status");
    marker.setAttribute("aria-live", "polite");
    refs.save.before(marker);
  }
  marker.hidden = !editor.dirty;
  marker.textContent = editor.dirty ? "未保存" : "";
  refs.save.classList.toggle("dirty", editor.dirty);
  refs.save.dataset.dirty = String(editor.dirty);
  refs.save.dataset.icon = "save";
  refs.save.setAttribute("aria-label", editor.dirty ? "保存：有未保存设置" : "保存：设置已保存");
  refs.save.textContent = editor.dirty ? "保存*" : "保存";
}

function setStatus(text, kind = "") {
  refs.status.textContent = text;
  refs.status.classList.toggle("bad", kind === "bad");
  refs.status.classList.toggle("saved", kind === "saved");
}

function updateActionTitle() {
  const actionName = editor.selectedActionName;
  const hasAsset = !!animations[actionName];
  refs.actionTitle.textContent = actionName ?? "未选择动作";
  refs.actionSubtitle.textContent = hasAsset
    ? `${currentConfig().motionMode ?? "InPlace"} · ${formatNumber(editor.duration)}s`
    : "动画资源缺失";
}

function updatePlayButton() {
  refs.play.dataset.icon = editor.playing ? "pause" : "play";
  refs.play.setAttribute("aria-label", editor.playing ? "暂停" : "播放");
  refs.play.textContent = editor.playing ? "暂停" : "播放";
}

function updateTimelineUi() {
  updateEffectiveRules();
  refs.timeline.max = Math.max(editor.duration, 0.001);
  refs.timeline.value = Math.min(editor.time, editor.duration || 0);
  refs.time.textContent = `${formatNumber(editor.time)} / ${formatNumber(editor.duration)}s`;
  const window = normalizeInterruptWindow(currentConfig().interruptWindow);
  const output = refs.fields.querySelector("[data-interrupt-readout]");
  if (output && window) {
    output.textContent = `${Math.round(window[0] * 100)}%–${Math.round(window[1] * 100)}% · ${formatNumber(window[0] * editor.duration)}–${formatNumber(window[1] * editor.duration)}s · ${isActionInterruptible(currentConfig(), editor.time, editor.duration) ? "可打断" : "不可打断"}`;
  }
}

function updateReadout() {
  if (!activeClip || !activeCharacter) {
    refs.readout.innerHTML = "";
    return;
  }

  const config = currentConfig();
  const cycle = calculateClipRootCycle(activeClip);
  const rootDistance = Math.hypot(cycle.cyclePosition.x, cycle.cyclePosition.z);
  const skeletonRoot = activeCharacter.scene.getObjectByName(ROOT_TRACK_NAME);
  const rootWorld = skeletonRoot
    ? skeletonRoot.getWorldPosition(scratchVector).clone()
    : new THREE.Vector3();
  const playbackScale = getPreviewPlaybackScale();

  refs.readout.innerHTML = `
    <div><span>Mode</span><b>${escapeHtml(config.motionMode ?? "InPlace")}</b></div>
    <div><span>Duration</span><b>${formatNumber(editor.duration)}s</b></div>
    <div><span>Root Cycle XZ</span><b>${formatNumber(rootDistance)}</b></div>
    <div><span>Sway Scale</span><b>${formatNumber(config.rootSwayScale ?? 1)}</b></div>
    <div><span>Root World XZ</span><b>${formatNumber(rootWorld.x)}, ${formatNumber(rootWorld.z)}</b></div>
    <div><span>Preview Speed</span><b>${formatNumber(playbackScale)}x</b></div>
  `;
}

function updateTrail() {
  if (!activeClip || !activeCharacter || !rootTrail) return;

  const config = currentConfig();
  const points = [];
  for (let i = 0; i <= TRAIL_SEGMENTS; i += 1) {
    const time = activeClip.duration * (i / TRAIL_SEGMENTS);
    const point = config.motionMode === "RootMotion"
      ? computeIntegratedRootMotion(editor.selectedActionName, config, time).position
      : getInPlaceRootMarkerOffset(time, config).add(computeIntegratedRootMotion(editor.selectedActionName, config, time).position);
    points.push(new THREE.Vector3(point.x, 0.035, point.z));
  }

  rootTrail.geometry.dispose();
  rootTrail.geometry = new THREE.BufferGeometry().setFromPoints(points);
  rootTrail.visible = points.length > 1;
}

function updateRootMarker() {
  if (!rootMarker || !activeCharacter) return;
  const skeletonRoot = activeCharacter.scene.getObjectByName(ROOT_TRACK_NAME);
  const position = skeletonRoot
    ? skeletonRoot.getWorldPosition(scratchVector)
    : activeCharacter.root.getWorldPosition(scratchVector);
  rootMarker.position.set(position.x, 0.055, position.z);
  rootMarker.visible = true;
}

function updateFacingMarker() {
  if (!facingMarker || !activeCharacter) return;
  activeCharacter.root.getWorldPosition(scratchVector);
  facingMarker.position.set(scratchVector.x, 0.07, scratchVector.z);
  facingMarker.rotation.set(0, activeCharacter.root.rotation.y, 0);
  facingMarker.visible = true;
}

function updateDebugState() {
  window.__MOTION_EDITOR_STATE = {
    pose: getPreviewPoseMetrics(),
    action: editor.selectedActionName,
    gender: editor.selectedGender,
    time: editor.time,
    duration: editor.duration,
    playing: editor.playing,
    dirty: editor.dirty,
    interruptWindow: normalizeInterruptWindow(currentConfig().interruptWindow),
    interruptible: isActionInterruptible(currentConfig(), editor.time, editor.duration),
    showGround: editor.showGround,
    showGrid: editor.showGrid,
    showSkeleton: editor.showSkeleton,
    skeletonBoneCount: activeCharacter?.skeletonOverlay.bones.length ?? 0,
    skeletonEdgeCount: activeCharacter?.skeletonOverlay.edges.length ?? 0,
    config: currentConfig(),
    rendererSize: renderer ? renderer.getDrawingBufferSize(new THREE.Vector2()).toArray() : null,
  };
}

function setActionLoop(action) {
  if (!action) return;
  const loop = getPreviewLoop() ? THREE.LoopRepeat : THREE.LoopOnce;
  action.setLoop(loop, Infinity);
  action.clampWhenFinished = !getPreviewLoop();
}

function normalizePreviewTime(time) {
  return THREE.MathUtils.clamp(time, 0, editor.duration || 0);
}

function getPreviewPlaybackScale() {
  if (!activeClip || !activeCharacter) return 1;
  const actionName = editor.selectedActionName;
  if (actionName !== "walk" && actionName !== "combatWalk") return 1;
  const config = currentConfig();
  const speed = Number(config.codeMoveSpeed);
  if (config.motionMode === "RootMotion" && !(Number.isFinite(speed) && speed >= 0)) return 1;
  return getPlaybackScale(config, computeAnimNaturalSpeed(activeClip, activeCharacter), { min: 0 });
}

function getInPlaceRootMarkerOffset(time, config) {
  if (!activeClip || !activeCharacter) return new THREE.Vector3();

  const start = getDetrendedRootPose(activeClip, 0, config);
  const pose = getDetrendedRootPose(activeClip, time, config);
  const scale = activeCharacter.scene.getWorldScale(new THREE.Vector3());
  const visualYaw = THREE.MathUtils.degToRad(config.visualYawOffsetDegrees ?? 0);
  return pose
    .sub(start)
    .multiply(scale)
    .setY(0)
    .applyAxisAngle(WORLD_UP, activeCharacter.sceneRestRotationY + visualYaw)
    .applyAxisAngle(WORLD_UP, PREVIEW_BASE_YAW);
}

function computeIntegratedRootMotion(actionName, config, targetTime) {
  return computeSharedRootMotion(animations[actionName], config, activeCharacter, targetTime, {
    baseYaw: PREVIEW_BASE_YAW,
    codeMovement: actionName === "walk" || actionName === "combatWalk",
  });
}

function mergeAnimationClips(clips, name) {
  const tracks = clips.flatMap((clip) => clip.tracks.map((track) => track.clone()));
  return new THREE.AnimationClip(name, -1, tracks);
}

function captureRestModel(model) {
  const nodes = new Map();
  model.traverse((node) => nodes.set(node.name, { position: node.position.clone() }));
  return { getObjectByName: (name) => nodes.get(name) };
}

function getPreviewPoseMetrics() {
  if (!activeCharacter || !activeAction || !activeClip) return null;
  const skeletonRoot = activeCharacter.scene.getObjectByName("Root");
  const hand = activeCharacter.scene.getObjectByName("Bip001_R_Hand");
  const leftHand = activeCharacter.scene.getObjectByName("Bip001_L_Hand");
  return {
    modelId: activeCharacter.gender === "female" ? "SK_BaseFemale" : "SK_BaseMale",
    actionName: activeAction.getClip().name,
    rootPosition: activeCharacter.root.position.toArray(),
    rootQuaternion: activeCharacter.root.quaternion.toArray(),
    skeletonRootPosition: skeletonRoot?.position.toArray() ?? null,
    skeletonRootQuaternion: skeletonRoot?.quaternion.toArray() ?? null,
    handWorldPosition: hand?.getWorldPosition(new THREE.Vector3()).toArray() ?? null,
    leftHandWorldPosition: leftHand?.getWorldPosition(new THREE.Vector3()).toArray() ?? null,
    rightHandWorldPosition: hand?.getWorldPosition(new THREE.Vector3()).toArray() ?? null,
    playbackRate: getPreviewPlaybackScale(),
    playbackPolicy: {
      codeMovement: editor.selectedActionName === "walk" || editor.selectedActionName === "combatWalk",
      previewLoop: getPreviewLoop(),
      configuredLoop: currentConfig().loop ?? null,
      baseYaw: PREVIEW_BASE_YAW,
    },
  };
}

function normalizeModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = CHARACTER_HEIGHT / Math.max(size.y, 0.001);
  model.scale.multiplyScalar(scale);

  const scaledBox = new THREE.Box3().setFromObject(model);
  const center = scaledBox.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= scaledBox.min.y;
}

function createSkeletonOverlay(model) {
  const bones = [];
  model.traverse((obj) => {
    if (obj.isBone || obj.type === "Bone") bones.push(obj);
  });

  const boneSet = new Set(bones);
  const edges = bones
    .filter((bone) => bone.parent && boneSet.has(bone.parent))
    .map((bone) => ({ parent: bone.parent, child: bone }));
  const group = new THREE.Group();
  group.name = "SkeletonOverlay";
  group.visible = false;

  const linePositions = new Float32Array(Math.max(edges.length * 2 * 3, 6));
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
  lineGeometry.setDrawRange(0, edges.length * 2);

  const line = new THREE.LineSegments(
    lineGeometry,
    new THREE.LineBasicMaterial({
      color: 0xd7fff2,
      transparent: true,
      opacity: 0.88,
      depthTest: false,
    }),
  );
  line.renderOrder = 10;
  group.add(line);

  const jointGeometry = new THREE.SphereGeometry(0.028, 10, 8);
  const rootGeometry = new THREE.SphereGeometry(0.075, 16, 12);
  const jointMaterial = new THREE.MeshBasicMaterial({
    color: 0x88e7ff,
    transparent: true,
    opacity: 0.88,
    depthTest: false,
  });
  const rootMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd166,
    transparent: true,
    opacity: 1,
    depthTest: false,
  });

  const joints = bones.map((bone) => {
    const isRoot = bone.name === ROOT_TRACK_NAME;
    const joint = new THREE.Mesh(isRoot ? rootGeometry : jointGeometry, isRoot ? rootMaterial : jointMaterial);
    joint.name = isRoot ? "SkeletonRootJoint" : `SkeletonJoint_${bone.name}`;
    joint.renderOrder = isRoot ? 12 : 11;
    joint.userData.bone = bone;
    group.add(joint);
    return joint;
  });

  return {
    group,
    bones,
    edges,
    line,
    linePositions,
    joints,
  };
}

function updateCharacterVisibility(character) {
  if (!character) return;
  const characterVisible = character === activeCharacter && character.root.visible;
  character.meshes.forEach((mesh) => {
    mesh.visible = characterVisible && !editor.showSkeleton;
  });
  character.skeletonOverlay.group.visible = characterVisible && editor.showSkeleton;
}

function updateSkeletonOverlay(character) {
  if (!character?.skeletonOverlay) return;

  updateCharacterVisibility(character);
  const overlay = character.skeletonOverlay;
  if (!overlay.group.visible) return;

  character.root.updateMatrixWorld(true);
  overlay.edges.forEach((edge, index) => {
    const parent = edge.parent.getWorldPosition(new THREE.Vector3());
    const child = edge.child.getWorldPosition(new THREE.Vector3());
    const offset = index * 6;
    overlay.linePositions[offset] = parent.x;
    overlay.linePositions[offset + 1] = parent.y;
    overlay.linePositions[offset + 2] = parent.z;
    overlay.linePositions[offset + 3] = child.x;
    overlay.linePositions[offset + 4] = child.y;
    overlay.linePositions[offset + 5] = child.z;
  });
  overlay.line.geometry.attributes.position.needsUpdate = true;
  overlay.line.geometry.computeBoundingSphere();

  overlay.joints.forEach((joint) => {
    joint.userData.bone.getWorldPosition(joint.position);
  });
}

function createRootMarker() {
  const group = new THREE.Group();
  group.name = "RootMarker";
  const material = new THREE.MeshBasicMaterial({
    color: 0x75f4ff,
    transparent: true,
    opacity: 0.82,
    depthTest: false,
  });
  const barX = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.025, 0.035), material);
  const barZ = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.025, 0.43), material);
  const center = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.035, 0.08), material);
  group.add(barX, barZ, center);
  group.renderOrder = 4;
  group.visible = false;
  group.traverse((obj) => {
    obj.renderOrder = 4;
  });
  return group;
}

function currentConfig() {
  return motionConfig[editor.selectedActionName] || {};
}

function ensureActionConfig(actionName) {
  if (!actionName) return {};
  if (!motionConfig[actionName]) {
    motionConfig[actionName] = {
      motionMode: "InPlace",
      loop: true,
      bakeIntoPoseXZ: true,
      bakeIntoPoseY: true,
      bakeIntoPoseRotation: true,
      rootSwayScale: 1,
    };
  }
  return motionConfig[actionName];
}

function createDefaultMotionConfig() {
  return {
    motionMode: "InPlace",
    loop: true,
    bakeIntoPoseXZ: true,
    bakeIntoPoseY: true,
    bakeIntoPoseRotation: true,
    rootSwayScale: 1,
  };
}

function getActionNames() {
  return [...new Set([...Object.keys(motionConfig), ...Object.keys(ASSETS.animations)])];
}

function pickInitialAction() {
  const names = getActionNames();
  return names.includes("idle") ? "idle" : names[0];
}

function getActionNameFromAssetFile(fileName) {
  const baseName = fileName.replace(/\.glb$/i, "");
  const withoutPrefix = baseName.replace(/^Anim[_-]?/i, "");
  return normalizeActionName(withoutPrefix);
}

function findConfiguredActionNameForAsset(fileName) {
  const derivedName = getActionNameFromAssetFile(fileName);
  if (motionConfig[derivedName]) return derivedName;

  const derivedKey = getCanonicalActionKey(derivedName);
  const configNames = Object.keys(motionConfig);
  return configNames.find((actionName) => (
    getCanonicalActionKey(actionName) === derivedKey
  )) ?? configNames
    .sort((a, b) => b.length - a.length)
    .find((actionName) => {
      const configKey = getCanonicalActionKey(actionName);
      return configKey.length >= 4 && derivedKey.endsWith(configKey);
    }) ?? null;
}

function normalizeActionName(value) {
  const words = String(value ?? "")
    .replace(/\.glb$/i, "")
    .replace(/^Anim[_-]?/i, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (!words.length) return "";

  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join("");
}

function sanitizeActionName(value) {
  const cleaned = String(value ?? "")
    .replace(/\.glb$/i, "")
    .replace(/^Anim[_-]?/i, "")
    .replace(/[^a-zA-Z0-9_$]/g, "");
  if (!cleaned) return "";
  if (/^[0-9]/.test(cleaned)) return `action${cleaned}`;
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

function getCanonicalActionKey(value) {
  return String(value ?? "")
    .replace(/\.glb$/i, "")
    .replace(/^Anim[_-]?/i, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function clampNumber(value, control) {
  const fallback = Number(control.defaultValue ?? 0);
  let parsed = Number(value);
  if (!Number.isFinite(parsed)) parsed = fallback;
  if (Number.isFinite(control.min)) parsed = Math.max(control.min, parsed);
  if (Number.isFinite(control.max)) parsed = Math.min(control.max, parsed);
  return parsed;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0.00";
  return number.toFixed(2);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resize() {
  if (!renderer || !camera) return;
  const rect = refs.viewport.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
