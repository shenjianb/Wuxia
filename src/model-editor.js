import * as THREE from "three/webgpu";
import { createSafeRenderer } from "./renderer-utils.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import "./model-editor.css";

const ASSET_VERSION = "model-editor-20260608-01";
const assetUrl = (path) => `${path}?v=${ASSET_VERSION}`;

const MODELS = [
  {
    id: "SK_BaseMale",
    label: "男 Base",
    sourceName: "SK_BaseMan_merged.fbx",
    fileName: "SK_BaseMale.glb",
    url: assetUrl("./assets/models/SK_BaseMale.glb"),
  },
  {
    id: "SK_BaseFemale",
    label: "女 Base",
    sourceName: "SK_BaseFemale_merged.fbx",
    fileName: "SK_BaseFemale.glb",
    url: assetUrl("./assets/models/SK_BaseFemale.glb"),
  },
];

const MODEL_BY_ID = new Map(MODELS.map((model) => [model.id, model]));

const ASSETS = {
  animations: {
    idle: assetUrl("./assets/animations/Anim_Normal_Idle2.glb"),
    walk: assetUrl("./assets/animations/Anim_Normal_Walk_F.glb"),
    turnLeft: assetUrl("./assets/animations/Anim_Normal_Idle_Turn_L.glb"),
    turnRight: assetUrl("./assets/animations/Anim_Normal_Idle_Turn_R.glb"),
    combatIdle: assetUrl("./assets/animations/Anim_Combat_Idle_Hand.glb"),
    combatWalk: assetUrl("./assets/animations/Anim_Combat_Walk_Short_F_Hand.glb"),
    combatTurnLeft: assetUrl("./assets/animations/Anim_Combat_Idle_Turn_L_Hand.glb"),
    combatTurnRight: assetUrl("./assets/animations/Anim_Combat_Idle_Turn_R_Hand.glb"),
    combat_Att_F_Hand_0: assetUrl("./assets/animations/Anim_Combat_Att_F_Hand_0.glb"),
    combat_Att_F_Hand_1: assetUrl("./assets/animations/Anim_Combat_Att_F_Hand_1.glb"),
    combat_Att_F_Hand_1_Ro: assetUrl("./assets/animations/Anim_Combat_Att_F_Hand_1_Ro.glb"),
    combat_Att_F_Hand_2: assetUrl("./assets/animations/Anim_Combat_Att_F_Hand_2.glb"),
    combat_Att_LB_Hand_0: assetUrl("./assets/animations/Anim_Combat_Att_LB_Hand_0.glb"),
    combat_Att_RB_Hand_0: assetUrl("./assets/animations/Anim_Combat_Att_RB_Hand_0.glb"),
  },
};

const ROOT_TRACK_NAME = "Root";
const CHARACTER_HEIGHT = 2.2;
const PREVIEW_BASE_YAW = Math.PI;
const UNIT_BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
const UNIT_BOX_EDGES = new THREE.EdgesGeometry(UNIT_BOX_GEOMETRY);
const CHANNELS = [
  { id: "hurt", label: "被击" },
  { id: "attack", label: "攻击" },
];
const BASE_USES = [
  { id: "sceneCollision", label: "场景碰撞" },
  { id: "vision", label: "视野检测" },
];
const DEFAULT_BASE_COLLIDER_STRENGTH = 10;
const DEFAULT_PART_COLLIDER_STRENGTH = 0;
const FUTURE_FEATURES = [
  "模型导入",
  "虚拟骨骼挂点",
  "装备碰撞配置",
];

const loader = new GLTFLoader();
const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const scratchVector = new THREE.Vector3();
let altRightDragging = false;
let altRightPrevY = 0;

let renderer;
let scene;
let camera;
let orbitControls;
let transformControls;
let transformHelper;
let previewGround;
let previewGrid;
let modelConfig = createEmptyModelConfig();
let motionConfig = {};
let animationAssetFiles = [];
let animations = {};
let characters = {};
let activeCharacter = null;
let activeAction = null;
let activeClip = null;
let activeFilteredClip = null;

const editor = {
  selectedModelId: MODELS[0].id,
  selectedActionName: null,
  editMode: "base",
  transformMode: "translate",
  selectedColliderId: "base",
  selectedBoneName: "",
  boneFilter: "",
  playing: true,
  dirty: false,
  duration: 0,
  time: 0,
  showGround: true,
  showGrid: true,
  showSkeleton: true,
  transformDragging: false,
};

const refs = {};
const normalizedModelConfigIds = new Set();

window.__MODEL_EDITOR_READY = false;
window.__MODEL_EDITOR_ERROR = null;

boot();

async function boot() {
  mountUi();
  bindUi();

  try {
    setStatus("加载模型配置...");
    modelConfig = normalizeModelConfig(await loadModelConfig());

    setStatus("加载动作配置...");
    motionConfig = await loadMotionConfig();
    animationAssetFiles = await loadAnimationAssetFiles();
    registerAnimationAssets();
    editor.selectedActionName = pickInitialAction();
    renderActionOptions();

    setStatus("初始化 WebGPU...");
    await initRenderer();

    setStatus("加载角色模型...");
    characters = await loadCharacters();
    selectModel(editor.selectedModelId);

    if (editor.selectedActionName) {
      await selectAction(editor.selectedActionName);
    }

    window.__MODEL_EDITOR_READY = true;
    document.body.dataset.ready = "true";
    setStatus("预览就绪", "saved");
    renderer.setAnimationLoop(update);
  } catch (error) {
    console.error(error);
    window.__MODEL_EDITOR_ERROR = error.message;
    setStatus(`初始化失败：${error.message}`, "bad");
  }
}

function mountUi() {
  const app = document.querySelector("#model-editor-app");
  app.innerHTML = `
    <div class="editor-shell">
      <aside class="model-rail">
        <div class="editor-brand">
          <strong>模型编辑器</strong>
          <span>build_glb_assets.MODELS</span>
        </div>
        <div class="model-list" data-model-list></div>
        <section class="future-panel">
          <h2>扩展占位</h2>
          <div data-future-list></div>
        </section>
      </aside>

      <main class="preview-column">
        <section class="preview-stage" data-viewport>
          <div class="status-pill" data-status>准备中...</div>
          <div class="preview-toggles">
            <button class="toggle-button active" type="button" data-toggle-ground>地板</button>
            <button class="toggle-button active" type="button" data-toggle-grid>网格</button>
            <button class="toggle-button active" type="button" data-toggle-skeleton>骨骼</button>
          </div>
          <div class="transform-toolbar">
            <button type="button" data-transform-mode="translate">移动</button>
            <button type="button" data-transform-mode="rotate">旋转</button>
            <button type="button" data-transform-mode="scale">缩放</button>
          </div>
          <div class="readout" data-readout></div>
        </section>
        <section class="timeline-bar">
          <select data-action-select></select>
          <button type="button" data-play>暂停</button>
          <button type="button" data-stop>归零</button>
          <input data-timeline type="range" min="0" max="1" step="0.001" value="0" />
          <div class="time-text" data-time>0.00 / 0.00s</div>
        </section>
      </main>

      <aside class="property-panel">
        <div class="panel-head">
          <div class="panel-title">
            <h1 data-model-title>未选择模型</h1>
            <span data-model-subtitle>model_config.json</span>
          </div>
          <button class="save-button" type="button" data-save>保存</button>
        </div>
        <div class="mode-tabs">
          <button type="button" data-edit-mode="base">基础碰撞</button>
          <button type="button" data-edit-mode="parts">部位碰撞</button>
        </div>
        <section class="bone-browser" data-bone-browser>
          <div class="bone-browser-head">
            <h2>骨骼列表</h2>
            <input data-bone-filter type="search" placeholder="筛选骨骼" />
          </div>
          <div class="bone-list" data-bone-list></div>
        </section>
        <div class="field-scroll" data-fields></div>
      </aside>
    </div>
  `;

  refs.modelList = document.querySelector("[data-model-list]");
  refs.futureList = document.querySelector("[data-future-list]");
  refs.viewport = document.querySelector("[data-viewport]");
  refs.status = document.querySelector("[data-status]");
  refs.toggleGround = document.querySelector("[data-toggle-ground]");
  refs.toggleGrid = document.querySelector("[data-toggle-grid]");
  refs.toggleSkeleton = document.querySelector("[data-toggle-skeleton]");
  refs.readout = document.querySelector("[data-readout]");
  refs.actionSelect = document.querySelector("[data-action-select]");
  refs.play = document.querySelector("[data-play]");
  refs.stop = document.querySelector("[data-stop]");
  refs.timeline = document.querySelector("[data-timeline]");
  refs.time = document.querySelector("[data-time]");
  refs.modelTitle = document.querySelector("[data-model-title]");
  refs.modelSubtitle = document.querySelector("[data-model-subtitle]");
  refs.save = document.querySelector("[data-save]");
  refs.boneBrowser = document.querySelector("[data-bone-browser]");
  refs.boneFilter = document.querySelector("[data-bone-filter]");
  refs.boneList = document.querySelector("[data-bone-list]");
  refs.fields = document.querySelector("[data-fields]");
  refs.modeButtons = [...document.querySelectorAll("[data-edit-mode]")];
  refs.transformButtons = [...document.querySelectorAll("[data-transform-mode]")];

  renderFutureList();
}

function bindUi() {
  refs.save.addEventListener("click", saveModelConfig);
  refs.actionSelect.addEventListener("change", () => selectAction(refs.actionSelect.value));
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
  refs.timeline.addEventListener("input", () => {
    editor.time = Number(refs.timeline.value) || 0;
    editor.playing = false;
    applyPreviewPose();
    updatePlayButton();
  });
  refs.toggleGround.addEventListener("click", () => togglePreviewLayer("ground"));
  refs.toggleGrid.addEventListener("click", () => togglePreviewLayer("grid"));
  refs.toggleSkeleton.addEventListener("click", () => togglePreviewLayer("skeleton"));
  refs.boneFilter.addEventListener("input", () => {
    editor.boneFilter = refs.boneFilter.value.trim();
    renderBoneList();
  });
  refs.modeButtons.forEach((button) => {
    button.addEventListener("click", () => setEditMode(button.dataset.editMode));
  });
  refs.transformButtons.forEach((button) => {
    button.addEventListener("click", () => setTransformMode(button.dataset.transformMode));
  });
  refs.viewport.addEventListener("pointerdown", selectColliderFromViewport);
  window.addEventListener("resize", resize);
  window.addEventListener("beforeunload", (event) => {
    if (!editor.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function initRenderer() {
scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0d0f);

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(3.8, 2.8, 4.6);

  renderer = await createSafeRenderer(THREE, { antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  refs.viewport.appendChild(renderer.domElement);

  orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.target.set(0, 1.05, 0);
  orbitControls.enableDamping = true;
  orbitControls.minDistance = 2.2;
  orbitControls.maxDistance = 11;
  orbitControls.mouseButtons = { LEFT: -1, MIDDLE: -1, RIGHT: 0 };
  orbitControls.update();

  bindAltRightDolly();

  transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setMode(editor.transformMode);
  transformControls.setSpace("local");
  transformControls.size = 0.86;
  transformHelper = transformControls.getHelper();
  scene.add(transformHelper);
  transformControls.addEventListener("dragging-changed", (event) => {
    editor.transformDragging = event.value;
    orbitControls.enabled = !event.value;
  });
  transformControls.addEventListener("objectChange", syncSelectedColliderFromObject);

  scene.add(new THREE.AmbientLight(0xffffff, 2.35));
  const hemi = new THREE.HemisphereLight(0xd7ecff, 0x51442f, 2.55);
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

  previewGrid = new THREE.GridHelper(8, 16, 0x7fd1c3, 0x3c473d);
  previewGrid.name = "PreviewGrid";
  previewGrid.position.y = 0.005;
  scene.add(previewGrid);

  updatePreviewLayerButtons();
  updateTransformButtons();
  resize();
}

async function loadCharacters() {
  const entries = await Promise.all(MODELS.map(async (model) => [model.id, await createCharacter(model)]));
  return Object.fromEntries(entries);
}

async function createCharacter(model) {
  const gltf = await loader.loadAsync(model.url);
  const root = new THREE.Group();
  root.name = `ModelPreview_${model.id}`;
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
  scene.add(root, skeletonOverlay.group);

  return {
    model,
    root,
    scene: gltf.scene,
    mixer: new THREE.AnimationMixer(gltf.scene),
    meshes,
    skeletonOverlay,
    rootRestPosition,
    rootRestQuaternion,
    sceneRestRotationY: gltf.scene.rotation.y,
    baseColliderMesh: null,
    partColliderMeshes: new Map(),
  };
}

function selectModel(modelId) {
  const character = characters[modelId];
  if (!character) return;

  detachTransform();
  editor.selectedModelId = modelId;
  activeCharacter = character;

  Object.values(characters).forEach((item) => {
    item.root.visible = item === activeCharacter;
    item.skeletonOverlay.group.visible = item === activeCharacter && editor.showSkeleton;
  });

  ensureModelConfig(modelId);
  rebuildCollisionMeshes(activeCharacter);
  rebuildPreviewAction(true);
  renderModelList();
  renderPanel();
  updateColliderVisibility();

  if (editor.editMode === "base") {
    selectBaseCollider();
  } else {
    const firstPart = currentModelConfig().partColliders[0];
    if (firstPart) selectPartCollider(firstPart.id);
  }

  applyPreviewPose();
}

async function selectAction(actionName) {
  if (!actionName) return;
  editor.selectedActionName = actionName;
  refs.actionSelect.value = actionName;
  editor.time = 0;

  try {
    if (!animations[actionName]) {
      setStatus(`加载动作 ${actionName}...`);
      await loadAnimationAction(actionName);
    }
    rebuildPreviewAction(false);
    setStatus("预览就绪", "saved");
  } catch (error) {
    setStatus(`动作加载失败：${error.message}`, "bad");
  }
}

async function loadAnimationAction(actionName) {
  const url = ASSETS.animations[actionName];
  if (!url) throw new Error(`没有找到 ${actionName} 对应的 GLB 资源`);
  animations[actionName] = await loadAnimationClip(actionName, url);
  return animations[actionName];
}

async function loadAnimationClip(actionName, url) {
  const gltf = await loader.loadAsync(url);
  return mergeAnimationClips(gltf.animations, actionName);
}

function rebuildPreviewAction(preserveTime = true) {
  if (!activeCharacter || !editor.selectedActionName || !animations[editor.selectedActionName]) return;

  const previousTime = preserveTime ? editor.time : 0;
  const config = currentMotionConfig();
  activeClip = animations[editor.selectedActionName];
  activeFilteredClip = filterAnimationTracks(activeClip, activeCharacter.scene, config);
  editor.duration = activeClip.duration || activeFilteredClip.duration || 0;
  editor.time = normalizePreviewTime(previousTime);

  activeCharacter.mixer.stopAllAction();
  activeAction = activeCharacter.mixer.clipAction(activeFilteredClip);
  activeAction.enabled = true;
  activeAction.setEffectiveWeight(1);
  activeAction.setLoop(config.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
  activeAction.clampWhenFinished = config.loop === false;
  activeAction.reset().play();

  applyPreviewPose();
}

function applyPreviewPose() {
  if (!activeCharacter) {
    updateTimelineUi();
    updateReadout();
    return;
  }

  const config = currentMotionConfig();
  const time = normalizePreviewTime(editor.time);
  const visualYaw = THREE.MathUtils.degToRad(config.visualYawOffsetDegrees ?? 0);

  activeCharacter.root.position.set(0, 0, 0);
  activeCharacter.root.rotation.set(0, PREVIEW_BASE_YAW, 0);
  activeCharacter.scene.rotation.y = activeCharacter.sceneRestRotationY + visualYaw;

  if (activeAction) {
    activeAction.timeScale = 1;
    activeCharacter.mixer.setTime(time);
  }

  const skeletonRoot = activeCharacter.scene.getObjectByName(ROOT_TRACK_NAME);
  if (skeletonRoot && config.motionMode === "InPlace" && config.bakeIntoPoseRotation !== false) {
    skeletonRoot.quaternion.copy(activeCharacter.rootRestQuaternion);
  }

  activeCharacter.root.updateMatrixWorld(true);
  updateSkeletonOverlay(activeCharacter);
  updateTimelineUi();
  updateReadout();
  updateDebugState();
}

function update() {
  const delta = Math.min(clock.getDelta(), 0.05);
  orbitControls?.update();

  if (editor.playing && activeAction && editor.duration > 0) {
    editor.time += delta;
    if (currentMotionConfig().loop === false && editor.time >= editor.duration) {
      editor.time = editor.duration;
      editor.playing = false;
      updatePlayButton();
    } else {
      editor.time %= editor.duration;
    }
    applyPreviewPose();
  }

  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

function rebuildCollisionMeshes(character) {
  if (!character) return;
  removeCollisionMeshes(character);

  const config = ensureModelConfig(character.model.id);
  character.baseColliderMesh = createColliderMesh("base", config.baseCollider);
  character.root.add(character.baseColliderMesh);
  applyColliderConfigToMesh(character.baseColliderMesh, config.baseCollider, "base");

  config.partColliders.forEach((collider) => {
    const bone = character.scene.getObjectByName(collider.bone);
    if (!bone) return;
    const mesh = createColliderMesh("part", collider);
    bone.add(mesh);
    applyColliderConfigToMesh(mesh, collider, "part");
    character.partColliderMeshes.set(collider.id, mesh);
  });
}

function removeCollisionMeshes(character) {
  if (character.baseColliderMesh?.parent) character.baseColliderMesh.parent.remove(character.baseColliderMesh);
  character.baseColliderMesh = null;
  character.partColliderMeshes.forEach((mesh) => {
    if (mesh.parent) mesh.parent.remove(mesh);
  });
  character.partColliderMeshes.clear();
}

function createColliderMesh(type, collider) {
  const fill = new THREE.MeshBasicMaterial({
    color: type === "base" ? 0xf6bd60 : 0x79d2c0,
    transparent: true,
    opacity: type === "base" ? 0.16 : 0.2,
    depthTest: false,
  });
  const edge = new THREE.LineBasicMaterial({
    color: type === "base" ? 0xf6bd60 : 0x79d2c0,
    transparent: true,
    opacity: 0.96,
    depthTest: false,
  });
  const mesh = new THREE.Mesh(UNIT_BOX_GEOMETRY, fill);
  const edges = new THREE.LineSegments(UNIT_BOX_EDGES, edge);
  mesh.add(edges);
  mesh.name = `${type === "base" ? "BaseCollider" : "PartCollider"}_${collider.id || "base"}`;
  mesh.renderOrder = 20;
  edges.renderOrder = 21;
  mesh.userData = {
    colliderType: type,
    colliderId: type === "base" ? "base" : collider.id,
    fillMaterial: fill,
    edgeMaterial: edge,
  };
  return mesh;
}

function applyColliderConfigToMesh(mesh, collider, type) {
  const position = type === "base" ? collider.center : collider.offset;
  const rotation = collider.rotationDegrees || [0, 0, 0];
  const size = collider.size || [0.25, 0.25, 0.25];

  mesh.position.fromArray(toVectorArray(position, [0, type === "base" ? 1 : 0, 0]));
  mesh.rotation.set(
    THREE.MathUtils.degToRad(Number(rotation[0]) || 0),
    THREE.MathUtils.degToRad(Number(rotation[1]) || 0),
    THREE.MathUtils.degToRad(Number(rotation[2]) || 0),
  );
  mesh.scale.fromArray(toVectorArray(size, [0.25, 0.25, 0.25]).map((value) => Math.max(0.001, Math.abs(value))));
}

function updateColliderVisibility() {
  if (!activeCharacter) return;
  const selected = getSelectedColliderRecord();

  if (activeCharacter.baseColliderMesh) {
    const visible = editor.editMode === "base" && (currentModelConfig().baseCollider.enabled !== false || selected?.mesh === activeCharacter.baseColliderMesh);
    activeCharacter.baseColliderMesh.visible = visible;
    updateColliderMaterial(activeCharacter.baseColliderMesh, selected?.mesh === activeCharacter.baseColliderMesh);
  }

  activeCharacter.partColliderMeshes.forEach((mesh, id) => {
    const config = findPartCollider(id);
    const visible = editor.editMode === "parts" && (config?.enabled !== false || selected?.mesh === mesh);
    mesh.visible = visible;
    updateColliderMaterial(mesh, selected?.mesh === mesh, config?.enabled !== false);
  });

  attachTransformToSelected();
}

function updateColliderMaterial(mesh, selected = false, enabled = true) {
  if (!mesh) return;
  const type = mesh.userData.colliderType;
  const fillColor = selected ? 0xffffff : type === "base" ? 0xf6bd60 : 0x79d2c0;
  const edgeColor = selected ? 0xffffff : type === "base" ? 0xf6bd60 : 0x79d2c0;
  mesh.userData.fillMaterial.color.setHex(fillColor);
  mesh.userData.edgeMaterial.color.setHex(edgeColor);
  mesh.userData.fillMaterial.opacity = selected ? 0.28 : type === "base" ? 0.16 : 0.2;
  mesh.userData.edgeMaterial.opacity = enabled ? 0.96 : 0.42;
}

function selectBaseCollider() {
  editor.editMode = "base";
  editor.selectedColliderId = "base";
  editor.selectedBoneName = "";
  renderPanel();
  updateColliderVisibility();
}

function selectPartCollider(colliderId) {
  const collider = findPartCollider(colliderId);
  if (!collider) return;
  editor.editMode = "parts";
  editor.selectedColliderId = collider.id;
  editor.selectedBoneName = collider.bone;
  renderPanel();
  updateColliderVisibility();
}

function setEditMode(mode) {
  if (mode !== "base" && mode !== "parts") return;
  editor.editMode = mode;
  if (mode === "parts") {
    editor.showSkeleton = true;
    const selectedPart = findPartCollider(editor.selectedColliderId) || currentModelConfig().partColliders[0];
    if (selectedPart) {
      editor.selectedColliderId = selectedPart.id;
      editor.selectedBoneName = selectedPart.bone;
    } else {
      editor.selectedColliderId = "";
    }
  } else {
    editor.selectedColliderId = "base";
    editor.selectedBoneName = "";
  }
  renderPanel();
  updatePreviewLayerButtons();
  updateSkeletonOverlay(activeCharacter);
  updateColliderVisibility();
}

function setTransformMode(mode) {
  if (!["translate", "rotate", "scale"].includes(mode)) return;
  editor.transformMode = mode;
  transformControls?.setMode(mode);
  updateTransformButtons();
}

function attachTransformToSelected() {
  if (!transformControls) return;
  const record = getSelectedColliderRecord();
  if (!record?.mesh || !record.mesh.visible) {
    detachTransform();
    return;
  }
  transformControls.setMode(editor.transformMode);
  transformControls.setSpace("local");
  transformControls.attach(record.mesh);
}

function detachTransform() {
  transformControls?.detach();
}

function syncSelectedColliderFromObject() {
  const record = getSelectedColliderRecord();
  if (!record?.mesh || !record.config) return;

  const mesh = record.mesh;
  const positionKey = record.type === "base" ? "center" : "offset";
  record.config[positionKey] = vectorToArray(mesh.position);
  record.config.rotationDegrees = [
    roundNumber(THREE.MathUtils.radToDeg(mesh.rotation.x)),
    roundNumber(THREE.MathUtils.radToDeg(mesh.rotation.y)),
    roundNumber(THREE.MathUtils.radToDeg(mesh.rotation.z)),
  ];
  record.config.size = [
    Math.max(0.001, roundNumber(Math.abs(mesh.scale.x))),
    Math.max(0.001, roundNumber(Math.abs(mesh.scale.y))),
    Math.max(0.001, roundNumber(Math.abs(mesh.scale.z))),
  ];
  mesh.scale.fromArray(record.config.size);
  setDirty(true);
  syncPanelInputs();
  updateReadout();
  updateDebugState();
}

function selectColliderFromViewport(event) {
  if (!camera || !activeCharacter || editor.transformDragging || event.button !== 0) return;
  const rect = refs.viewport.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const candidates = getVisibleColliderMeshes();
  const hits = raycaster.intersectObjects(candidates, true);
  const hit = hits.map((item) => findColliderMesh(item.object)).find(Boolean);
  if (!hit) return;
  if (hit.userData.colliderType === "base") {
    selectBaseCollider();
  } else {
    selectPartCollider(hit.userData.colliderId);
  }
}

function findColliderMesh(object) {
  let current = object;
  while (current) {
    if (current.userData?.colliderType) return current;
    current = current.parent;
  }
  return null;
}

function getVisibleColliderMeshes() {
  if (!activeCharacter) return [];
  const meshes = [];
  if (activeCharacter.baseColliderMesh?.visible) meshes.push(activeCharacter.baseColliderMesh);
  activeCharacter.partColliderMeshes.forEach((mesh) => {
    if (mesh.visible) meshes.push(mesh);
  });
  return meshes;
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
  orbitControls.enabled = false;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function onAltRightPointerMove(event) {
  if (!altRightDragging) return;
  const deltaY = altRightPrevY - event.clientY;
  altRightPrevY = event.clientY;
  const dist = camera.position.distanceTo(orbitControls.target);
  const scale = 1 + deltaY * 0.005;
  const newDist = Math.max(
    orbitControls.minDistance,
    Math.min(orbitControls.maxDistance, dist * scale),
  );
  const dir = new THREE.Vector3().subVectors(camera.position, orbitControls.target).normalize();
  camera.position.copy(orbitControls.target).addScaledVector(dir, newDist);
}

function onAltRightPointerUp() {
  if (!altRightDragging) return;
  altRightDragging = false;
  orbitControls.enabled = true;
}

function renderPanel() {
  renderModelTitle();
  renderModeButtons();
  renderBoneBrowser();
  renderFields();
  updateSaveButton();
}

function renderModelList() {
  refs.modelList.innerHTML = "";
  MODELS.forEach((model) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "model-item";
    item.classList.toggle("active", model.id === editor.selectedModelId);
    item.innerHTML = `
      <span>${escapeHtml(model.label)}</span>
      <b>${escapeHtml(model.fileName)}</b>
    `;
    item.addEventListener("click", () => selectModel(model.id));
    refs.modelList.appendChild(item);
  });
}

function renderFutureList() {
  refs.futureList.innerHTML = "";
  FUTURE_FEATURES.forEach((feature) => {
    const item = document.createElement("button");
    item.type = "button";
    item.disabled = true;
    item.textContent = feature;
    refs.futureList.appendChild(item);
  });
}

function renderModelTitle() {
  const model = MODEL_BY_ID.get(editor.selectedModelId);
  const config = currentModelConfig();
  refs.modelTitle.textContent = model?.label || editor.selectedModelId;
  refs.modelSubtitle.textContent = `${model?.fileName || ""} · ${config.partColliders.length} 部位盒`;
}

function renderModeButtons() {
  refs.modeButtons.forEach((button) => {
    const active = button.dataset.editMode === editor.editMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderBoneBrowser() {
  refs.boneBrowser.hidden = editor.editMode !== "parts";
  refs.boneFilter.value = editor.boneFilter;
  renderBoneList();
}

function renderBoneList() {
  refs.boneList.innerHTML = "";
  if (editor.editMode !== "parts" || !activeCharacter) return;

  const filter = editor.boneFilter.toLowerCase();
  activeCharacter.skeletonOverlay.bones
    .filter((bone) => !filter || bone.name.toLowerCase().includes(filter))
    .forEach((bone) => {
      const count = currentModelConfig().partColliders.filter((collider) => collider.bone === bone.name).length;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "bone-item";
      item.classList.toggle("active", bone.name === editor.selectedBoneName);
      item.innerHTML = `
        <span>${escapeHtml(bone.name)}</span>
        ${count ? `<b>${count}</b>` : ""}
      `;
      item.addEventListener("click", () => selectBoneForPartCollider(bone.name));
      refs.boneList.appendChild(item);
    });
}

function renderFields() {
  refs.fields.innerHTML = "";
  if (!activeCharacter) return;

  if (editor.editMode === "base") {
    renderBaseFields();
  } else {
    renderPartFields();
  }
}

function renderBaseFields() {
  const config = currentModelConfig().baseCollider;
  const group = createFieldGroup("基础碰撞盒");
  group.appendChild(createCheckboxField("启用", config.enabled !== false, (checked) => {
    config.enabled = checked;
    setDirty(true);
    updateColliderVisibility();
  }));
  BASE_USES.forEach((use) => {
    group.appendChild(createCheckboxField(use.label, (config.uses || []).includes(use.id), (checked) => {
      config.uses = toggleListValue(config.uses || [], use.id, checked);
      setDirty(true);
    }));
  });
  group.appendChild(createVectorField("中心", "center", config.center, 0.01, (value) => {
    config.center = value;
    applyColliderConfigToMesh(activeCharacter.baseColliderMesh, config, "base");
    setDirty(true);
  }));
  group.appendChild(createVectorField("尺寸", "size", config.size, 0.01, (value) => {
    config.size = value.map((item) => Math.max(0.001, item));
    applyColliderConfigToMesh(activeCharacter.baseColliderMesh, config, "base");
    setDirty(true);
  }));
  group.appendChild(createVectorField("旋转", "rotationDegrees", config.rotationDegrees, 1, (value) => {
    config.rotationDegrees = value;
    applyColliderConfigToMesh(activeCharacter.baseColliderMesh, config, "base");
    setDirty(true);
  }));
  group.appendChild(createNumberField("基础强度", config.strength, 0.1, (value) => {
    config.strength = Math.max(0, value);
    setDirty(true);
  }));
  refs.fields.appendChild(group);
}

function renderPartFields() {
  const model = currentModelConfig();
  const selected = findPartCollider(editor.selectedColliderId);
  const listGroup = createFieldGroup("部位碰撞体");

  const select = document.createElement("select");
  select.className = "part-select";
  model.partColliders.forEach((collider) => {
    const option = document.createElement("option");
    option.value = collider.id;
    option.textContent = `${collider.name || collider.id} · ${collider.bone}`;
    select.appendChild(option);
  });
  select.value = selected?.id || "";
  select.disabled = !model.partColliders.length;
  select.addEventListener("change", () => selectPartCollider(select.value));
  listGroup.appendChild(wrapControl("当前碰撞体", select));

  const actionRow = document.createElement("div");
  actionRow.className = "inline-actions";
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.textContent = "新增";
  addButton.addEventListener("click", () => createPartCollider(editor.selectedBoneName || activeCharacter.skeletonOverlay.bones[0]?.name));
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "danger-button";
  deleteButton.textContent = "删除";
  deleteButton.disabled = !selected;
  deleteButton.addEventListener("click", deleteSelectedPartCollider);
  actionRow.append(addButton, deleteButton);
  listGroup.appendChild(actionRow);
  refs.fields.appendChild(listGroup);

  if (!selected) return;

  const metaGroup = createFieldGroup("部位属性");
  metaGroup.appendChild(createTextField("名称", selected.name || "", (value) => {
    selected.name = value;
    setDirty(true);
    renderBoneList();
    renderModelTitle();
  }));
  metaGroup.appendChild(createTextField("ID", selected.id, (value) => renamePartCollider(selected.id, value)));
  metaGroup.appendChild(createReadOnlyField("骨骼", selected.bone));
  metaGroup.appendChild(createCheckboxField("启用", selected.enabled !== false, (checked) => {
    selected.enabled = checked;
    setDirty(true);
    updateColliderVisibility();
  }));
  CHANNELS.forEach((channel) => {
    metaGroup.appendChild(createCheckboxField(channel.label, (selected.channels || []).includes(channel.id), (checked) => {
      selected.channels = toggleListValue(selected.channels || [], channel.id, checked);
      setDirty(true);
    }));
  });
  metaGroup.appendChild(createNumberField("部位强度", selected.strength, 0.1, (value) => {
    selected.strength = Math.max(0, value);
    setDirty(true);
  }));
  refs.fields.appendChild(metaGroup);

  const transformGroup = createFieldGroup("碰撞盒参数");
  transformGroup.appendChild(createVectorField("偏移", "offset", selected.offset, 0.01, (value) => {
    selected.offset = value;
    updateSelectedPartMesh(selected);
    setDirty(true);
  }));
  transformGroup.appendChild(createVectorField("尺寸", "size", selected.size, 0.01, (value) => {
    selected.size = value.map((item) => Math.max(0.001, item));
    updateSelectedPartMesh(selected);
    setDirty(true);
  }));
  transformGroup.appendChild(createVectorField("旋转", "rotationDegrees", selected.rotationDegrees, 1, (value) => {
    selected.rotationDegrees = value;
    updateSelectedPartMesh(selected);
    setDirty(true);
  }));
  refs.fields.appendChild(transformGroup);
}

function createFieldGroup(title) {
  const group = document.createElement("section");
  group.className = "field-group";
  const heading = document.createElement("h2");
  heading.textContent = title;
  group.appendChild(heading);
  return group;
}

function wrapControl(label, input) {
  const row = document.createElement("label");
  row.className = "control-row";
  const text = document.createElement("span");
  text.textContent = label;
  row.append(text, input);
  return row;
}

function createCheckboxField(label, checked, onChange) {
  const row = document.createElement("label");
  row.className = "check-row";
  const text = document.createElement("span");
  text.textContent = label;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  row.append(text, input);
  return row;
}

function createTextField(label, value, onChange) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value || "";
  input.addEventListener("change", () => onChange(input.value.trim()));
  return wrapControl(label, input);
}

function createReadOnlyField(label, value) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value || "";
  input.readOnly = true;
  return wrapControl(label, input);
}

function createNumberField(label, value, step, onChange) {
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.step = String(step);
  input.value = formatInputNumber(Number.isFinite(Number(value)) ? Number(value) : 0);
  input.addEventListener("input", () => {
    const parsed = Number(input.value);
    onChange(Number.isFinite(parsed) ? roundNumber(parsed) : 0);
    updateReadout();
    updateDebugState();
  });
  return wrapControl(label, input);
}

function createVectorField(label, key, values, step, onChange) {
  const row = document.createElement("div");
  row.className = "vector-row";
  const text = document.createElement("span");
  text.textContent = label;
  const grid = document.createElement("div");
  grid.className = "vector-grid";
  const current = toVectorArray(values, [0, 0, 0]);
  const inputs = [];
  ["X", "Y", "Z"].forEach((axis, index) => {
    const input = document.createElement("input");
    input.type = "number";
    input.step = String(step);
    input.value = formatInputNumber(current[index]);
    input.dataset.vectorKey = key;
    input.dataset.vectorIndex = String(index);
    input.setAttribute("aria-label", `${label} ${axis}`);
    input.addEventListener("input", () => {
      const next = inputs.map((field) => {
        const parsed = Number(field.value);
        return Number.isFinite(parsed) ? parsed : 0;
      });
      onChange(next.map(roundNumber));
      syncObjectFromSelectedConfig();
      updateReadout();
      updateDebugState();
    });
    inputs[index] = input;
    grid.appendChild(input);
  });
  row.append(text, grid);
  return row;
}

function syncPanelInputs() {
  const record = getSelectedColliderRecord();
  if (!record?.config) return;
  const vectors = record.type === "base"
    ? {
      center: record.config.center,
      size: record.config.size,
      rotationDegrees: record.config.rotationDegrees,
    }
    : {
      offset: record.config.offset,
      size: record.config.size,
      rotationDegrees: record.config.rotationDegrees,
    };
  refs.fields.querySelectorAll("[data-vector-key]").forEach((input) => {
    const key = input.dataset.vectorKey;
    const index = Number(input.dataset.vectorIndex);
    if (!vectors[key]) return;
    input.value = formatInputNumber(vectors[key][index]);
  });
}

function syncObjectFromSelectedConfig() {
  const record = getSelectedColliderRecord();
  if (!record?.mesh || !record.config) return;
  applyColliderConfigToMesh(record.mesh, record.config, record.type);
}

function updateSelectedPartMesh(collider) {
  const mesh = activeCharacter?.partColliderMeshes.get(collider.id);
  if (!mesh) return;
  applyColliderConfigToMesh(mesh, collider, "part");
  updateColliderVisibility();
}

function selectBoneForPartCollider(boneName) {
  editor.selectedBoneName = boneName;
  const existing = currentModelConfig().partColliders.find((collider) => collider.bone === boneName);
  if (existing) {
    selectPartCollider(existing.id);
    return;
  }
  createPartCollider(boneName);
}

function createPartCollider(boneName) {
  if (!activeCharacter || !boneName) return;
  const bone = activeCharacter.scene.getObjectByName(boneName);
  if (!bone) return;

  const defaults = getDefaultPartColliderTransform(bone);
  const model = currentModelConfig();
  const id = createUniquePartColliderId(boneName);
  const collider = {
    id,
    name: inferPartName(boneName),
    bone: boneName,
    shape: "box",
    enabled: true,
    offset: defaults.offset,
    size: defaults.size,
    rotationDegrees: [0, 0, 0],
    channels: ["hurt"],
    strength: DEFAULT_PART_COLLIDER_STRENGTH,
  };
  model.partColliders.push(collider);

  const mesh = createColliderMesh("part", collider);
  bone.add(mesh);
  applyColliderConfigToMesh(mesh, collider, "part");
  activeCharacter.partColliderMeshes.set(collider.id, mesh);

  setDirty(true);
  selectPartCollider(collider.id);
  renderModelTitle();
}

function deleteSelectedPartCollider() {
  const selected = findPartCollider(editor.selectedColliderId);
  if (!selected || !activeCharacter) return;
  const model = currentModelConfig();
  model.partColliders = model.partColliders.filter((collider) => collider.id !== selected.id);
  const mesh = activeCharacter.partColliderMeshes.get(selected.id);
  if (mesh?.parent) mesh.parent.remove(mesh);
  activeCharacter.partColliderMeshes.delete(selected.id);
  setDirty(true);

  const next = model.partColliders[0];
  if (next) {
    selectPartCollider(next.id);
  } else {
    editor.selectedColliderId = "";
    renderPanel();
    updateColliderVisibility();
  }
  renderModelTitle();
}

function renamePartCollider(oldId, nextValue) {
  const selected = findPartCollider(oldId);
  if (!selected || !nextValue) {
    renderFields();
    return;
  }
  const nextId = sanitizeId(nextValue);
  if (!nextId || nextId === oldId) {
    renderFields();
    return;
  }
  if (findPartCollider(nextId)) {
    setStatus(`ID 已存在：${nextId}`, "bad");
    renderFields();
    return;
  }
  selected.id = nextId;
  const mesh = activeCharacter.partColliderMeshes.get(oldId);
  if (mesh) {
    activeCharacter.partColliderMeshes.delete(oldId);
    activeCharacter.partColliderMeshes.set(nextId, mesh);
    mesh.userData.colliderId = nextId;
    mesh.name = `PartCollider_${nextId}`;
  }
  editor.selectedColliderId = nextId;
  setDirty(true);
  renderPanel();
  updateColliderVisibility();
}

function getDefaultPartColliderTransform(bone) {
  const name = bone.name.toLowerCase();
  const childBone = bone.children.find((child) => child.isBone || child.type === "Bone");
  const offset = childBone ? childBone.position.clone().multiplyScalar(0.5) : new THREE.Vector3();
  const length = childBone ? Math.max(0.12, childBone.position.length()) : 0.28;

  if (name.includes("head")) return { offset: [0, 0.1, 0], size: [0.32, 0.35, 0.32] };
  if (name.includes("spine") || name.includes("pelvis")) return { offset: vectorToArray(offset), size: [0.58, 0.62, 0.48] };
  if (name.includes("upperarm")) return { offset: vectorToArray(offset), size: [Math.max(0.24, length), 0.18, 0.18] };
  if (name.includes("forearm")) return { offset: vectorToArray(offset), size: [Math.max(0.22, length), 0.16, 0.16] };
  if (name.includes("thigh")) return { offset: vectorToArray(offset), size: [0.24, Math.max(0.36, length), 0.22] };
  if (name.includes("calf")) return { offset: vectorToArray(offset), size: [0.2, Math.max(0.34, length), 0.2] };
  if (name.includes("hand")) return { offset: vectorToArray(offset), size: [0.18, 0.18, 0.18] };
  if (name.includes("foot")) return { offset: vectorToArray(offset), size: [0.22, 0.16, 0.34] };
  return { offset: vectorToArray(offset), size: [0.24, 0.24, 0.24] };
}

function inferPartName(boneName) {
  const map = [
    ["Bip001_Head", "头"],
    ["Bip001_Spine1", "躯干"],
    ["Bip001_Spine2", "上身"],
    ["Bip001_Pelvis", "骨盆"],
    ["Bip001_L_UpperArm", "左大臂"],
    ["Bip001_L_Forearm", "左小臂"],
    ["Bip001_L_Hand", "左手"],
    ["Bip001_R_UpperArm", "右大臂"],
    ["Bip001_R_Forearm", "右小臂"],
    ["Bip001_R_Hand", "右手"],
    ["Bip001_L_Thigh", "左大腿"],
    ["Bip001_L_Calf", "左小腿"],
    ["Bip001_L_Foot", "左脚"],
    ["Bip001_R_Thigh", "右大腿"],
    ["Bip001_R_Calf", "右小腿"],
    ["Bip001_R_Foot", "右脚"],
  ];
  return map.find(([key]) => key === boneName)?.[1] || boneName.replace(/^Bip001[_\s]*/i, "");
}

function createUniquePartColliderId(boneName) {
  const modelPrefix = editor.selectedModelId === "SK_BaseFemale" ? "female" : "male";
  const base = `${modelPrefix}-${sanitizeId(boneName.replace(/^Bip001[_\s]*/i, "")) || "part"}`;
  let id = base;
  let index = 2;
  while (findPartCollider(id)) {
    id = `${base}-${index}`;
    index += 1;
  }
  return id;
}

function getSelectedColliderRecord() {
  if (!activeCharacter) return null;
  if (editor.editMode === "base" || editor.selectedColliderId === "base") {
    return {
      type: "base",
      config: currentModelConfig().baseCollider,
      mesh: activeCharacter.baseColliderMesh,
    };
  }
  const config = findPartCollider(editor.selectedColliderId);
  return {
    type: "part",
    config,
    mesh: config ? activeCharacter.partColliderMeshes.get(config.id) : null,
  };
}

function findPartCollider(colliderId) {
  if (!colliderId || colliderId === "base") return null;
  return currentModelConfig().partColliders.find((collider) => collider.id === colliderId) || null;
}

function currentModelConfig() {
  return ensureModelConfig(editor.selectedModelId);
}

function ensureModelConfig(modelId) {
  if (!modelConfig.models) modelConfig.models = {};
  if (!modelConfig.models[modelId]) {
    const model = MODEL_BY_ID.get(modelId);
    modelConfig.models[modelId] = {
      label: model?.label || modelId,
      asset: model?.fileName || `${modelId}.glb`,
      baseCollider: createDefaultBaseCollider(modelId),
      partColliders: [],
      future: createFutureConfig(),
    };
  }

  const config = modelConfig.models[modelId];
  if (!normalizedModelConfigIds.has(modelId)) {
    config.label = config.label || MODEL_BY_ID.get(modelId)?.label || modelId;
    config.asset = config.asset || MODEL_BY_ID.get(modelId)?.fileName || `${modelId}.glb`;
    config.baseCollider = normalizeBaseCollider(config.baseCollider, modelId);
    config.partColliders = Array.isArray(config.partColliders)
      ? config.partColliders.map(normalizePartCollider).filter(Boolean)
      : [];
    config.future = config.future || createFutureConfig();
    normalizedModelConfigIds.add(modelId);
  }
  return config;
}

function normalizeModelConfig(config) {
  const normalized = (!config || typeof config !== "object" || Array.isArray(config))
    ? createEmptyModelConfig()
    : { version: config.version || 1, models: config.models || {} };
  MODELS.forEach((model) => {
    if (!normalized.models[model.id]) {
      normalized.models[model.id] = {
        label: model.label,
        asset: model.fileName,
        baseCollider: createDefaultBaseCollider(model.id),
        partColliders: [],
        future: createFutureConfig(),
      };
    }
  });
  modelConfig = normalized;
  normalizedModelConfigIds.clear();
  MODELS.forEach((model) => ensureModelConfig(model.id));
  return modelConfig;
}

function normalizeBaseCollider(value, modelId) {
  const fallback = createDefaultBaseCollider(modelId);
  const config = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    enabled: config.enabled !== false,
    shape: "box",
    center: toVectorArray(config.center, fallback.center),
    size: toVectorArray(config.size, fallback.size).map((item) => Math.max(0.001, item)),
    rotationDegrees: toVectorArray(config.rotationDegrees, [0, 0, 0]),
    uses: Array.isArray(config.uses) ? config.uses.filter(Boolean) : fallback.uses,
    strength: normalizeNonNegativeNumber(config.strength, fallback.strength),
  };
}

function normalizePartCollider(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.bone) return null;
  const id = sanitizeId(value.id || value.bone);
  const bone = normalizeRuntimeBoneName(value.bone);
  return {
    id,
    name: String(value.name || inferPartName(bone)),
    bone,
    shape: "box",
    enabled: value.enabled !== false,
    offset: toVectorArray(value.offset, [0, 0, 0]),
    size: toVectorArray(value.size, [0.24, 0.24, 0.24]).map((item) => Math.max(0.001, item)),
    rotationDegrees: toVectorArray(value.rotationDegrees, [0, 0, 0]),
    channels: Array.isArray(value.channels) ? value.channels.filter(Boolean) : ["hurt"],
    strength: normalizeNonNegativeNumber(value.strength, DEFAULT_PART_COLLIDER_STRENGTH),
  };
}

function createEmptyModelConfig() {
  return { version: 1, models: {} };
}

function createDefaultBaseCollider(modelId) {
  const female = modelId === "SK_BaseFemale";
  return {
    enabled: true,
    shape: "box",
    center: [0, 1.08, 0],
    size: female ? [0.72, 2.08, 0.68] : [0.78, 2.08, 0.72],
    rotationDegrees: [0, 0, 0],
    uses: ["sceneCollision", "vision"],
    strength: DEFAULT_BASE_COLLIDER_STRENGTH,
  };
}

function createFutureConfig() {
  return {
    modelImport: { enabled: false },
    virtualMountPoints: [],
    equipmentProfiles: [],
  };
}

async function loadModelConfig() {
  try {
    const response = await fetch("/api/model-config", { cache: "no-store" });
    if (response.ok) return response.json();
  } catch {
    // Static builds do not have the dev write API.
  }

  try {
    const response = await fetch(assetUrl("./assets/models/model_config.json"), { cache: "no-store" });
    if (response.ok) return response.json();
  } catch {
    // Fall through to generated defaults.
  }
  return createEmptyModelConfig();
}

async function loadMotionConfig() {
  try {
    const response = await fetch("/api/motion-config", { cache: "no-store" });
    if (response.ok) return response.json();
  } catch {
    // Static builds do not have the dev write API.
  }

  const response = await fetch(assetUrl("./assets/animations/motion_config.json"), { cache: "no-store" });
  if (!response.ok) return {};
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

function registerAnimationAssets() {
  animationAssetFiles.forEach((fileName) => {
    const actionName = findConfiguredActionNameForAsset(fileName) || getActionNameFromAssetFile(fileName);
    if (actionName && !ASSETS.animations[actionName]) {
      ASSETS.animations[actionName] = assetUrl(`./assets/animations/${fileName}`);
    }
  });
}

function renderActionOptions() {
  const selectedValue = refs.actionSelect.value || editor.selectedActionName;
  refs.actionSelect.innerHTML = "";
  getActionNames().forEach((actionName) => {
    const option = document.createElement("option");
    option.value = actionName;
    option.textContent = actionName;
    refs.actionSelect.appendChild(option);
  });
  if (selectedValue && ASSETS.animations[selectedValue]) refs.actionSelect.value = selectedValue;
}

function getActionNames() {
  return [...new Set([...Object.keys(ASSETS.animations), ...Object.keys(motionConfig)])]
    .filter((actionName) => ASSETS.animations[actionName])
    .sort((a, b) => {
      const aCombat = a.toLowerCase().includes("combat");
      const bCombat = b.toLowerCase().includes("combat");
      if (aCombat !== bCombat) return aCombat ? 1 : -1;
      return a.localeCompare(b);
    });
}

function pickInitialAction() {
  const names = getActionNames();
  return names.includes("idle") ? "idle" : names[0] || null;
}

function currentMotionConfig() {
  return {
    motionMode: "InPlace",
    loop: true,
    bakeIntoPoseXZ: true,
    bakeIntoPoseY: true,
    bakeIntoPoseRotation: true,
    rootSwayScale: 1,
    ...(motionConfig[editor.selectedActionName] || {}),
  };
}

async function saveModelConfig() {
  refs.save.disabled = true;
  setStatus("保存中...");
  try {
    const response = await fetch("/api/model-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: modelConfig }),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `${response.status} ${response.statusText}`);
    }
    setDirty(false);
    setStatus("已保存到 model_config.json", "saved");
  } catch (error) {
    setStatus(`保存失败：${error.message}`, "bad");
  } finally {
    refs.save.disabled = false;
    updateSaveButton();
  }
}

function togglePreviewLayer(layerName) {
  if (layerName === "ground") editor.showGround = !editor.showGround;
  if (layerName === "grid") editor.showGrid = !editor.showGrid;
  if (layerName === "skeleton") editor.showSkeleton = !editor.showSkeleton;
  updatePreviewLayerButtons();
  Object.values(characters).forEach((character) => {
    character.skeletonOverlay.group.visible = character === activeCharacter && editor.showSkeleton;
  });
  if (activeCharacter) updateSkeletonOverlay(activeCharacter);
}

function updatePreviewLayerButtons() {
  if (previewGround) previewGround.visible = editor.showGround;
  if (previewGrid) previewGrid.visible = editor.showGrid;
  refs.toggleGround.classList.toggle("active", editor.showGround);
  refs.toggleGrid.classList.toggle("active", editor.showGrid);
  refs.toggleSkeleton.classList.toggle("active", editor.showSkeleton);
}

function updateTransformButtons() {
  refs.transformButtons.forEach((button) => {
    const active = button.dataset.transformMode === editor.transformMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setDirty(dirty) {
  editor.dirty = dirty;
  updateSaveButton();
}

function updateSaveButton() {
  refs.save.classList.toggle("dirty", editor.dirty);
  refs.save.textContent = editor.dirty ? "保存*" : "保存";
}

function setStatus(text, kind = "") {
  refs.status.textContent = text;
  refs.status.classList.toggle("bad", kind === "bad");
  refs.status.classList.toggle("saved", kind === "saved");
}

function updatePlayButton() {
  refs.play.textContent = editor.playing ? "暂停" : "播放";
}

function updateTimelineUi() {
  refs.timeline.max = Math.max(editor.duration, 0.001);
  refs.timeline.value = Math.min(editor.time, editor.duration || 0);
  refs.time.textContent = `${formatNumber(editor.time)} / ${formatNumber(editor.duration)}s`;
}

function updateReadout() {
  const record = getSelectedColliderRecord();
  const model = MODEL_BY_ID.get(editor.selectedModelId);
  const colliderLabel = record?.type === "base"
    ? "基础碰撞"
    : record?.config?.name || "未选择";
  const boneLabel = record?.type === "part" ? record.config?.bone || "-" : "-";
  const size = record?.config?.size || [0, 0, 0];
  const strength = record?.config?.strength ?? 0;
  refs.readout.innerHTML = `
    <div><span>Model</span><b>${escapeHtml(model?.id || "-")}</b></div>
    <div><span>Action</span><b>${escapeHtml(editor.selectedActionName || "-")}</b></div>
    <div><span>Mode</span><b>${editor.editMode === "base" ? "基础" : "部位"}</b></div>
    <div><span>Collider</span><b>${escapeHtml(colliderLabel)}</b></div>
    <div><span>Bone</span><b>${escapeHtml(boneLabel)}</b></div>
    <div><span>Size</span><b>${formatNumber(size[0])}, ${formatNumber(size[1])}, ${formatNumber(size[2])}</b></div>
    <div><span>Strength</span><b>${formatNumber(strength)}</b></div>
  `;
}

function updateDebugState() {
  window.__MODEL_EDITOR_STATE = {
    ready: window.__MODEL_EDITOR_READY,
    selectedModelId: editor.selectedModelId,
    selectedActionName: editor.selectedActionName,
    editMode: editor.editMode,
    transformMode: editor.transformMode,
    selectedColliderId: editor.selectedColliderId,
    selectedBoneName: editor.selectedBoneName,
    partColliderCount: currentModelConfig().partColliders.length,
    duration: editor.duration,
    time: editor.time,
  };
}

function normalizePreviewTime(time) {
  if (!editor.duration) return 0;
  return THREE.MathUtils.clamp(time, 0, editor.duration);
}

function mergeAnimationClips(clips, name) {
  const tracks = clips.flatMap((clip) => clip.tracks.map((track) => track.clone()));
  return new THREE.AnimationClip(name, -1, tracks);
}

function filterAnimationTracks(clip, model, config = {}) {
  const resolvedConfig = {
    motionMode: "InPlace",
    bakeIntoPoseXZ: true,
    bakeIntoPoseY: true,
    bakeIntoPoseRotation: true,
    ...config,
  };

  const clone = clip.clone();
  clone.tracks = clone.tracks.map((track) => {
    const targetName = getTrackTargetName(track.name);
    if (track.name.endsWith(".scale")) return null;

    if (targetName === ROOT_TRACK_NAME) {
      if (isRotationTrack(track.name)) {
        if (resolvedConfig.motionMode === "InPlace" && resolvedConfig.bakeIntoPoseRotation) return null;
        if (resolvedConfig.motionMode === "RootMotion" && resolvedConfig.applyRootRotation === false) return null;
      }

      if (track.name.endsWith(".position") && resolvedConfig.motionMode === "InPlace") {
        const numKeys = track.times.length;
        if (numKeys >= 2) {
          const stride = 3;
          const values = new track.values.constructor(track.values.length);
          const duration = track.times[numKeys - 1] - track.times[0];
          const t0 = track.times[0];
          const startX = track.values[0];
          const startY = track.values[1];
          const startZ = track.values[2];
          const endIdx = (numKeys - 1) * stride;
          const endX = track.values[endIdx];
          const endY = track.values[endIdx + 1];
          const endZ = track.values[endIdx + 2];
          const driftRateX = duration > 0 ? (endX - startX) / duration : 0;
          const driftRateY = duration > 0 ? (endY - startY) / duration : 0;
          const driftRateZ = duration > 0 ? (endZ - startZ) / duration : 0;

          for (let i = 0; i < numKeys; i += 1) {
            const t = track.times[i] - t0;
            values[i * stride] = track.values[i * stride] - (resolvedConfig.bakeIntoPoseXZ ? driftRateX * t : 0);
            values[i * stride + 1] = track.values[i * stride + 1] - (resolvedConfig.bakeIntoPoseY ? driftRateY * t : 0);
            values[i * stride + 2] = track.values[i * stride + 2] - (resolvedConfig.bakeIntoPoseXZ ? driftRateZ * t : 0);
          }

          const swayScale = resolvedConfig.rootSwayScale ?? 1;
          if (swayScale < 1) {
            const baseX = values[0];
            const baseY = values[1];
            const baseZ = values[2];
            for (let i = 1; i < numKeys; i += 1) {
              values[i * stride] = baseX + (values[i * stride] - baseX) * swayScale;
              values[i * stride + 1] = baseY + (values[i * stride + 1] - baseY) * swayScale;
              values[i * stride + 2] = baseZ + (values[i * stride + 2] - baseZ) * swayScale;
            }
          }
          return new THREE.VectorKeyframeTrack(track.name, track.times.slice(), values);
        }
      }
    }

    if (targetName !== ROOT_TRACK_NAME && track.name.endsWith(".position")) {
      if (targetName === "Bip001_Pelvis" || targetName === "Bip001 Pelvis") {
        const target = model.getObjectByName(targetName);
        if (target && track.values.length >= 3) {
          const values = new track.values.constructor(track.values.length);
          const firstX = track.values[0];
          const firstY = track.values[1];
          const firstZ = track.values[2];

          for (let i = 0; i < track.values.length; i += 3) {
            values[i] = target.position.x + (track.values[i] - firstX);
            values[i + 1] = target.position.y + (track.values[i + 1] - firstY);
            values[i + 2] = target.position.z + (track.values[i + 2] - firstZ);
          }
          return new THREE.VectorKeyframeTrack(track.name, track.times.slice(), values);
        }
      }
      return null;
    }

    return track;
  }).filter(Boolean);

  clone.resetDuration();
  return clone;
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

function updateSkeletonOverlay(character) {
  if (!character?.skeletonOverlay) return;
  character.skeletonOverlay.group.visible = character === activeCharacter && editor.showSkeleton;
  if (!character.skeletonOverlay.group.visible) return;

  character.root.updateMatrixWorld(true);
  const overlay = character.skeletonOverlay;
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

function getTrackTargetName(trackName) {
  const dotIndex = trackName.lastIndexOf(".");
  return dotIndex === -1 ? trackName : trackName.slice(0, dotIndex);
}

function isRotationTrack(trackName) {
  return trackName.endsWith(".rotation") || trackName.endsWith(".quaternion");
}

function findConfiguredActionNameForAsset(fileName) {
  const derivedName = getActionNameFromAssetFile(fileName);
  if (motionConfig[derivedName]) return derivedName;

  const derivedKey = getCanonicalActionKey(derivedName);
  const configNames = Object.keys(motionConfig);
  return configNames.find((actionName) => getCanonicalActionKey(actionName) === derivedKey)
    ?? configNames
      .sort((a, b) => b.length - a.length)
      .find((actionName) => {
        const configKey = getCanonicalActionKey(actionName);
        return configKey.length >= 4 && derivedKey.endsWith(configKey);
      })
    ?? null;
}

function getActionNameFromAssetFile(fileName) {
  const baseName = fileName.replace(/\.glb$/i, "");
  const withoutPrefix = baseName.replace(/^Anim[_-]?/i, "");
  return normalizeActionName(withoutPrefix);
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

function getCanonicalActionKey(value) {
  return String(value ?? "")
    .replace(/\.glb$/i, "")
    .replace(/^Anim[_-]?/i, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function toVectorArray(value, fallback) {
  const source = Array.isArray(value) ? value : fallback;
  return [0, 1, 2].map((index) => {
    const number = Number(source[index]);
    return Number.isFinite(number) ? roundNumber(number) : fallback[index];
  });
}

function vectorToArray(vector) {
  return [roundNumber(vector.x), roundNumber(vector.y), roundNumber(vector.z)];
}

function toggleListValue(list, value, enabled) {
  const next = new Set(list);
  if (enabled) next.add(value);
  else next.delete(value);
  return [...next];
}

function sanitizeId(value) {
  return String(value ?? "")
    .trim()
    .replace(/^Bip001[_\s]*/i, "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function normalizeRuntimeBoneName(value) {
  const name = String(value ?? "").trim();
  if (!name) return "";
  if (!name.startsWith("Bip001")) return name.replace(/\s+/g, "_");
  return name.replace(/^Bip001\s+/, "Bip001_").replace(/\s+/g, "_");
}

function roundNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 10000) / 10000;
}

function normalizeNonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? roundNumber(number) : fallback;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0.00";
  return number.toFixed(2);
}

function formatInputNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return String(roundNumber(number));
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
