import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import "./styles.css";

const ASSETS = {
  models: {
    male: "./assets/models/SK_BaseMale.glb",
    female: "./assets/models/SK_BaseFemale.glb",
  },
  animations: {
    idle: "./assets/animations/Anim_Normal_Idle2.glb",
    walk: "./assets/animations/Anim_Normal_Walk_F.glb",
  },
};

const CHARACTER_HEIGHT = 2.2;
const PLAYER_SPEED = 2.65;
const TURN_SPEED = 2.35;
const CAMERA_LERP = 4.5;
const SELECT_TRANSITION_SPEED = 1.25;
const WORLD_SIZE = 18;
const TILE_SIZE = 1.35;

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
    <div class="badge" data-renderer>WebGPU</div>
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
let selectionSet;
let worldSet;
let player;
let obstacles = [];

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
  const [idleGltf, walkGltf] = await Promise.all([
    loader.loadAsync(ASSETS.animations.idle),
    loader.loadAsync(ASSETS.animations.walk),
  ]);
  return {
    idle: renameClip(idleGltf.animations[0], "idle"),
    walk: renameClip(walkGltf.animations[0], "walk"),
  };
}

function renameClip(clip, name) {
  const clone = clip.clone();
  clone.name = name;
  return clone;
}

async function createCharacter(gender, url) {
  const gltf = await loader.loadAsync(url);
  const root = new THREE.Group();
  root.name = `Character_${gender}`;
  root.add(gltf.scene);

  gltf.scene.rotation.x = Math.PI / 2;
  normalizeModel(gltf.scene);
  tintCharacter(gltf.scene, gender);
  gltf.scene.traverse((obj) => {
    if (obj.isMesh || obj.isSkinnedMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  const mixer = new THREE.AnimationMixer(gltf.scene);
  const actions = {
    idle: mixer.clipAction(animations.idle),
    walk: mixer.clipAction(animations.walk),
  };
  if (!DISABLE_ANIMATION) actions.idle.play();

  return {
    gender,
    root,
    scene: gltf.scene,
    mixer,
    actions,
    currentAction: actions.idle,
    desiredAction: actions.idle,
    active: true,
  };
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

function bindInput() {
  document.querySelectorAll("[data-choice]").forEach((button) => {
    button.addEventListener("click", () => chooseGender(button.dataset.choice));
  });

  window.addEventListener("keydown", (event) => {
    if (event.code === "Space") state.keys.forward = true;
    if (event.code === "ArrowLeft") state.keys.left = true;
    if (event.code === "ArrowRight") state.keys.right = true;
    if (event.code === "Digit1") chooseGender("male");
    if (event.code === "Digit2") chooseGender("female");
  });

  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") state.keys.forward = false;
    if (event.code === "ArrowLeft") state.keys.left = false;
    if (event.code === "ArrowRight") state.keys.right = false;
  });

  window.addEventListener("resize", resize);
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
    character.mixer.update(delta);
    updateAction(character, character.desiredAction, delta);
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

  updateCamera(delta);
  window.__DEMO_STATE = getDebugState();
  renderer.render(scene, camera);
}

function getDebugState() {
  return {
    objectCount: scene.children.length,
    cameraPosition: camera.position.toArray(),
    cameraTarget: cameraTarget.toArray(),
    markerPosition: diagnosticMarker.position.toArray(),
    markerVisible: diagnosticMarker.visible && diagnosticMarker.parent !== null,
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
  const turn = (state.keys.left ? 1 : 0) - (state.keys.right ? 1 : 0);
  player.root.rotation.y += turn * TURN_SPEED * delta;

  const moving = state.keys.forward;
  player.desiredAction = moving ? player.actions.walk : player.actions.idle;

  if (!moving) return;

  const forward = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.root.rotation.y);
  const next = player.root.position.clone().addScaledVector(forward, PLAYER_SPEED * delta);
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

function updateAction(character, nextAction) {
  if (!nextAction || character.currentAction === nextAction) return;
  nextAction.enabled = true;
  nextAction.reset().fadeIn(0.22).play();
  character.currentAction.fadeOut(0.22);
  character.currentAction = nextAction;
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
