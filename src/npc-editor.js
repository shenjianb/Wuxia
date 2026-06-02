import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  ATTRIBUTE_DEFS,
  FACTION_TYPES,
  MODEL_TYPES,
  VISION_DEFAULTS,
  MOVE_SPEED_DEFAULTS,
  getDefaultAttributes,
} from "./character-attributes.js";
import "./npc-editor.css";

const ASSET_VERSION = "npc-editor-20260530-01";
const assetUrl = (p) => `${p}?v=${ASSET_VERSION}`;

const ASSETS = {
  models: {
    BaseMale: assetUrl("./assets/models/SK_BaseMale.glb"),
    BaseFemale: assetUrl("./assets/models/SK_BaseFemale.glb"),
  },
};

const CHARACTER_HEIGHT = 2.2;
const PREVIEW_BASE_YAW = Math.PI;

const editor = {
  currentNpcId: null,
  dirty: false,
  faction: 0,
  modelType: "BaseMale",
  attributes: getDefaultAttributes(),
  vision: { ...VISION_DEFAULTS },
  moveSpeed: { ...MOVE_SPEED_DEFAULTS },
  behaviorTreeId: "",
  showGround: true,
  showGrid: true,
  showSkeleton: false,
};

let renderer, scene, camera, controls, clock;
let loader;
let ambientLight, hemiLight, keyLight;
let previewGround, previewGrid;
let npcModel = null;
let skeletonOverlay = null;

const refs = {};

window.__NPC_EDITOR_READY = false;
window.__NPC_EDITOR_ERROR = null;

boot();

async function boot() {
  mountUI();
  bindUI();

  try {
    setStatus("初始化 WebGPU...");
    await initRenderer();

    setStatus("加载 NPC 列表...");
    await loadNpcList();

    window.__NPC_EDITOR_READY = true;
    setStatus("就绪", "saved");
    renderer.setAnimationLoop(update);
  } catch (error) {
    console.error(error);
    window.__NPC_EDITOR_ERROR = error.message;
    setStatus(`初始化失败: ${error.message}`, "bad");
  }
}

function mountUI() {
  const app = document.querySelector("#npc-editor-app");
  app.innerHTML = `
    <div class="editor-shell">
      <aside class="npc-rail">
        <div class="editor-brand">
          <strong>NPC 编辑器</strong>
          <span>Create / Edit / Save</span>
        </div>
        <div class="new-npc-row">
          <input data-new-npc-id type="text" placeholder="新建 NPC ID..." />
          <button data-new-npc type="button">新建</button>
        </div>
        <div class="npc-list" data-npc-list></div>
      </aside>

      <main class="preview-column">
        <section class="preview-stage" data-viewport>
          <div class="status-pill" data-status>准备中...</div>
          <div class="preview-toggles">
            <button class="toggle-button active" type="button" data-toggle-ground>地面</button>
            <button class="toggle-button active" type="button" data-toggle-grid>网格</button>
            <button class="toggle-button" type="button" data-toggle-skeleton>骨骼</button>
          </div>
        </section>
        <div class="toolbar-bar">
          <span class="toolbar-info" data-toolbar-info></span>
        </div>
      </main>

      <aside class="property-panel">
        <div class="panel-head">
          <div class="panel-title">
            <h1 data-panel-title>NPC 属性</h1>
            <span data-panel-subtitle>选择一个 NPC 或创建新的</span>
          </div>
          <button class="save-button" data-save type="button">保存</button>
        </div>
        <div class="field-scroll" data-field-scroll></div>
      </aside>
    </div>
  `;

  refs.npcList = document.querySelector("[data-npc-list]");
  refs.newNpcId = document.querySelector("[data-new-npc-id]");
  refs.newNpcBtn = document.querySelector("[data-new-npc]");
  refs.viewport = document.querySelector("[data-viewport]");
  refs.status = document.querySelector("[data-status]");
  refs.toggleGround = document.querySelector("[data-toggle-ground]");
  refs.toggleGrid = document.querySelector("[data-toggle-grid]");
  refs.toggleSkeleton = document.querySelector("[data-toggle-skeleton]");
  refs.saveBtn = document.querySelector("[data-save]");
  refs.panelTitle = document.querySelector("[data-panel-title]");
  refs.panelSubtitle = document.querySelector("[data-panel-subtitle]");
  refs.fieldScroll = document.querySelector("[data-field-scroll]");
  refs.toolbarInfo = document.querySelector("[data-toolbar-info]");
}

function bindUI() {
  refs.newNpcBtn.addEventListener("click", createNewNpc);
  refs.toggleGround.addEventListener("click", () => togglePreviewLayer("ground"));
  refs.toggleGrid.addEventListener("click", () => togglePreviewLayer("grid"));
  refs.toggleSkeleton.addEventListener("click", () => togglePreviewLayer("skeleton"));
  refs.saveBtn.addEventListener("click", saveNpc);

  window.addEventListener("resize", resize);
  window.addEventListener("beforeunload", (e) => {
    if (!editor.dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

async function initRenderer() {
  if (!navigator.gpu) {
    throw new Error("浏览器不支持 WebGPU。请用支持 WebGPU 的 Chrome/Edge 访问。");
  }

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d0c);

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(3.8, 2.7, 4.6);
  camera.lookAt(0, 1.05, 0);

  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  await renderer.init();
  refs.viewport.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.05, 0);
  controls.enableDamping = true;
  controls.minDistance = 2.4;
  controls.maxDistance = 10;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.update();

  ambientLight = new THREE.AmbientLight(0xffffff, 2.6);
  scene.add(ambientLight);
  hemiLight = new THREE.HemisphereLight(0xd8ecff, 0x60442d, 3.4);
  scene.add(hemiLight);
  keyLight = new THREE.DirectionalLight(0xffe0aa, 5.2);
  keyLight.position.set(5, 12, 7);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(512, 512);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 50;
  keyLight.shadow.camera.left = -5;
  keyLight.shadow.camera.right = 5;
  keyLight.shadow.camera.top = 5;
  keyLight.shadow.camera.bottom = -5;
  scene.add(keyLight);

  previewGround = new THREE.Mesh(
    new THREE.CircleGeometry(2.5, 48),
    new THREE.MeshStandardMaterial({ color: 0x252923, roughness: 0.9 })
  );
  previewGround.rotation.x = -Math.PI / 2;
  previewGround.position.y = 0.01;
  previewGround.receiveShadow = true;
  scene.add(previewGround);

  previewGrid = new THREE.GridHelper(8, 16, 0x3c473d, 0x252923);
  previewGrid.position.y = 0.015;
  scene.add(previewGrid);

  loader = new GLTFLoader();
  clock = new THREE.Clock();

  resize();
}

function resize() {
  const rect = refs.viewport.getBoundingClientRect();
  const w = rect.width || window.innerWidth;
  const h = rect.height || window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}

function update() {
  const delta = Math.min(clock.getDelta(), 0.05);
  controls?.update();
  if (npcModel && npcModel.mixer) {
    npcModel.mixer.update(delta);
  }
  updateSkeletonPoses();
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

function setStatus(text, kind = "") {
  refs.status.textContent = text;
  refs.status.classList.toggle("saved", kind === "saved");
  refs.status.classList.toggle("bad", kind === "bad");
}

function setDirty(dirty) {
  editor.dirty = dirty;
  updateSaveButton();
}

function updateSaveButton() {
  refs.saveBtn.classList.toggle("dirty", editor.dirty);
  refs.saveBtn.textContent = editor.dirty ? "保存*" : "保存";
}

function updateToolbarInfo() {
  if (npcModel) {
    const factionLabel = FACTION_TYPES.find((t) => t.key === editor.faction)?.label || String(editor.faction);
    refs.toolbarInfo.textContent = `模型: ${editor.modelType}  |  阵营: ${factionLabel}`;
  } else {
    refs.toolbarInfo.textContent = "暂无模型";
  }
}

function togglePreviewLayer(layer) {
  if (layer === "ground") {
    editor.showGround = !editor.showGround;
    refs.toggleGround.classList.toggle("active", editor.showGround);
    if (previewGround) previewGround.visible = editor.showGround;
  } else if (layer === "grid") {
    editor.showGrid = !editor.showGrid;
    refs.toggleGrid.classList.toggle("active", editor.showGrid);
    if (previewGrid) previewGrid.visible = editor.showGrid;
  } else if (layer === "skeleton") {
    editor.showSkeleton = !editor.showSkeleton;
    refs.toggleSkeleton.classList.toggle("active", editor.showSkeleton);
    updateSkeletonVisibility();
  }
}

function updateSkeletonVisibility() {
  if (!npcModel) return;
  npcModel.meshes.forEach((m) => {
    m.visible = !editor.showSkeleton;
  });
  if (npcModel.skeletonOverlay) {
    npcModel.skeletonOverlay.group.visible = editor.showSkeleton;
  }
}

async function loadNpcList() {
  try {
    const resp = await fetch("/api/npcs");
    if (!resp.ok) throw new Error(`${resp.status}`);
    const data = await resp.json();
    renderNpcList(data.npcs || []);
  } catch {
    renderNpcList([]);
  }
}

function renderNpcList(npcs) {
  refs.npcList.innerHTML = "";
  for (const npc of npcs) {
    const item = document.createElement("div");
    item.className = "npc-item";
    if (npc.id === editor.currentNpcId) item.classList.add("active");

    const nameSpan = document.createElement("span");
    nameSpan.className = "npc-name";
    nameSpan.textContent = npc.name || npc.id;

    const factionVal = npc.faction !== undefined ? npc.faction : 0;
    const factionInfo = FACTION_TYPES.find((t) => t.key === factionVal);
    const factionBadge = document.createElement("span");
    factionBadge.className = `faction-badge faction-${factionVal}`;
    factionBadge.textContent = factionInfo?.label || String(factionVal);

    const delBtn = document.createElement("button");
    delBtn.className = "delete-npc-button";
    delBtn.textContent = "删除";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteNpc(npc.id);
    });

    item.appendChild(nameSpan);
    item.appendChild(factionBadge);
    item.appendChild(delBtn);
    item.addEventListener("click", () => loadNpc(npc.id));
    refs.npcList.appendChild(item);
  }
}

function createNewNpc() {
  const id = refs.newNpcId.value.trim();
  if (!id) {
    setStatus("请输入 NPC ID", "bad");
    return;
  }

  const existing = refs.npcList.querySelectorAll(".npc-name");
  for (const el of existing) {
    if (el.textContent === id) {
      setStatus(`NPC "${id}" 已存在`, "bad");
      return;
    }
  }

  editor.currentNpcId = id;
  editor.dirty = true;
  editor.faction = 0;
  editor.modelType = "BaseMale";
  editor.attributes = getDefaultAttributes();
  editor.attributes.name = id;
  editor.vision = { ...VISION_DEFAULTS };
  editor.moveSpeed = { ...MOVE_SPEED_DEFAULTS };
  editor.behaviorTreeId = "";

  loadNpcModel("BaseMale");
  renderNpcListFromDom();
  renderPropertyPanel();
  updateSaveButton();
  updateToolbarInfo();
  setStatus(`已创建 NPC "${id}"`, "saved");
  refs.newNpcId.value = "";
}

function renderNpcListFromDom() {
  const items = refs.npcList.querySelectorAll(".npc-item");
  const npcs = [];
  items.forEach((item) => {
    const nameEl = item.querySelector(".npc-name");
    const badgeEl = item.querySelector(".faction-badge");
    let faction = 0;
    if (badgeEl) {
      for (const cls of badgeEl.classList) {
        if (cls.startsWith("faction-")) {
          faction = parseInt(cls.replace("faction-", ""), 10) || 0;
          break;
        }
      }
    }
    if (nameEl) {
      npcs.push({
        id: nameEl.textContent,
        name: nameEl.textContent,
        faction,
      });
    }
  });
  renderNpcList(npcs);
}

async function loadNpc(id) {
  if (editor.dirty && !confirm("当前 NPC 未保存，确定切换到其他 NPC？")) return;

  try {
    setStatus(`加载 NPC "${id}"...`);
    const resp = await fetch(`/api/npcs/${encodeURIComponent(id)}`);
    if (!resp.ok) throw new Error(`${resp.status}`);
    const data = await resp.json();

    editor.currentNpcId = data.id || id;
    editor.dirty = false;
    editor.faction = data.faction !== undefined ? data.faction : 0;
    editor.modelType = data.modelType || "BaseMale";
    editor.behaviorTreeId = data.behaviorTreeId || data.behaviorTree || data.behaviorTrees?.normal || "";

    const loadedAttrs = data.attributes || {};
    editor.attributes = getDefaultAttributes();
    for (const key of Object.keys(editor.attributes)) {
      if (loadedAttrs[key] !== undefined) {
        editor.attributes[key] = loadedAttrs[key];
      }
    }

    editor.vision = data.vision
      ? { distance: data.vision.distance ?? VISION_DEFAULTS.distance, angle: data.vision.angle ?? VISION_DEFAULTS.angle }
      : { ...VISION_DEFAULTS };
    editor.moveSpeed = data.moveSpeed
      ? { normal: data.moveSpeed.normal ?? MOVE_SPEED_DEFAULTS.normal, combat: data.moveSpeed.combat ?? MOVE_SPEED_DEFAULTS.combat }
      : { ...MOVE_SPEED_DEFAULTS };

    await loadNpcModel(editor.modelType);
    await loadNpcList();
    renderPropertyPanel();
    updateSaveButton();
    updateToolbarInfo();
    setStatus(`已加载 "${id}"`, "saved");
  } catch (e) {
    setStatus(`加载失败: ${e.message}`, "bad");
  }
}

async function saveNpc() {
  if (!editor.currentNpcId) {
    const id = prompt("请输入 NPC ID 保存:");
    if (!id) return;
    editor.currentNpcId = id;
  }

  setStatus("保存中...");
  try {
    const data = {
      id: editor.currentNpcId,
      version: 1,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      faction: editor.faction,
      modelType: editor.modelType,
      attributes: { ...editor.attributes },
      vision: { ...editor.vision },
      moveSpeed: { ...editor.moveSpeed },
      behaviorTreeId: editor.behaviorTreeId,
    };

    const checkResp = await fetch(`/api/npcs/${encodeURIComponent(editor.currentNpcId)}`);
    if (checkResp.ok) {
      const existing = await checkResp.json();
      data.created = existing.created || data.created;
    }

    const resp = await fetch(`/api/npcs/${encodeURIComponent(editor.currentNpcId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `${resp.status}`);
    }

    editor.dirty = false;
    updateSaveButton();
    await loadNpcList();
    setStatus(`已保存 "${editor.currentNpcId}"`, "saved");
  } catch (e) {
    setStatus(`保存失败: ${e.message}`, "bad");
  }
}

async function deleteNpc(id) {
  if (!confirm(`确定删除 NPC "${id}"？此操作不可撤销。`)) return;
  try {
    const resp = await fetch(`/api/npcs/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!resp.ok) throw new Error(`${resp.status}`);
    if (editor.currentNpcId === id) {
      editor.currentNpcId = null;
      editor.dirty = false;
      removeNpcModel();
      renderPropertyPanel();
      updateSaveButton();
    }
    await loadNpcList();
    setStatus(`已删除 "${id}"`, "saved");
  } catch (e) {
    setStatus(`删除失败: ${e.message}`, "bad");
  }
}

function renderPropertyPanel() {
  const scroll = refs.fieldScroll;
  scroll.innerHTML = "";

  if (!editor.currentNpcId) {
    return;
  }

  refs.panelTitle.textContent = editor.attributes.name || editor.currentNpcId;
  refs.panelSubtitle.textContent = `ID: ${editor.currentNpcId}`;

  scroll.appendChild(createAttributeSection());
  scroll.appendChild(createNpcSettingsSection());
  scroll.appendChild(createVisionSection());
  scroll.appendChild(createMoveSpeedSection());
  scroll.appendChild(createBehaviorTreeSection());
}

function createAttributeSection() {
  const group = document.createElement("section");
  group.className = "field-group";
  const h2 = document.createElement("h2");
  h2.textContent = "基础属性";
  group.appendChild(h2);

  for (const def of ATTRIBUTE_DEFS) {
    if (def.type === "string") {
      const row = document.createElement("div");
      row.className = "control-row";

      const label = document.createElement("label");
      const text = document.createElement("span");
      text.textContent = def.label;
      label.appendChild(text);

      const input = document.createElement("input");
      input.type = "text";
      input.value = editor.attributes[def.key] ?? "";
      input.addEventListener("input", () => {
        editor.attributes[def.key] = input.value;
        setDirty(true);
        refs.panelTitle.textContent = editor.attributes.name || editor.currentNpcId;
      });

      row.appendChild(label);
      row.appendChild(input);
      group.appendChild(row);
    } else if (def.type === "number") {
      const row = document.createElement("div");
      row.className = "range-row";

      const label = document.createElement("label");
      const text = document.createElement("span");
      text.textContent = def.label;
      label.appendChild(text);

      const range = document.createElement("input");
      range.type = "range";
      range.min = def.min;
      range.max = def.max;
      range.step = 1;
      range.value = editor.attributes[def.key];

      const numInput = document.createElement("input");
      numInput.type = "number";
      numInput.min = def.min;
      numInput.max = def.max;
      numInput.step = 1;
      numInput.value = editor.attributes[def.key];

      range.addEventListener("input", () => {
        const val = Number(range.value);
        numInput.value = val;
        editor.attributes[def.key] = val;
        setDirty(true);
      });

      numInput.addEventListener("input", () => {
        const val = Number(numInput.value);
        if (!isNaN(val) && val >= def.min && val <= def.max) {
          range.value = val;
          editor.attributes[def.key] = val;
          setDirty(true);
        }
      });

      const rangeRow = document.createElement("div");
      rangeRow.className = "range-row";
      rangeRow.appendChild(range);
      rangeRow.appendChild(numInput);

      const wrapper = document.createElement("div");
      wrapper.className = "control-row";
      wrapper.appendChild(label);
      wrapper.appendChild(rangeRow);
      group.appendChild(wrapper);
    }
  }

  return group;
}

function createNpcSettingsSection() {
  const group = document.createElement("section");
  group.className = "field-group";
  const h2 = document.createElement("h2");
  h2.textContent = "NPC 设置";
  group.appendChild(h2);

  const factionRow = document.createElement("div");
  factionRow.className = "control-row";
  const factionLabel = document.createElement("label");
  factionLabel.innerHTML = "<span>阵营</span>";
  const factionSelect = document.createElement("select");
  for (const t of FACTION_TYPES) {
    const opt = document.createElement("option");
    opt.value = t.key;
    opt.textContent = t.label;
    if (t.key === editor.faction) opt.selected = true;
    factionSelect.appendChild(opt);
  }
  factionSelect.addEventListener("change", () => {
    editor.faction = Number(factionSelect.value);
    setDirty(true);
    updateToolbarInfo();
    renderNpcListFromDom();
  });
  factionRow.appendChild(factionLabel);
  factionRow.appendChild(factionSelect);
  group.appendChild(factionRow);

  const modelRow = document.createElement("div");
  modelRow.className = "control-row";
  const modelLabel = document.createElement("label");
  modelLabel.innerHTML = "<span>模型</span>";
  const modelSelect = document.createElement("select");
  for (const m of MODEL_TYPES) {
    const opt = document.createElement("option");
    opt.value = m.key;
    opt.textContent = m.label;
    if (m.key === editor.modelType) opt.selected = true;
    modelSelect.appendChild(opt);
  }
  modelSelect.addEventListener("change", () => {
    editor.modelType = modelSelect.value;
    setDirty(true);
    updateToolbarInfo();
    loadNpcModel(modelSelect.value);
  });
  modelRow.appendChild(modelLabel);
  modelRow.appendChild(modelSelect);
  group.appendChild(modelRow);

  return group;
}

function createVisionSection() {
  const group = document.createElement("section");
  group.className = "field-group";
  const h2 = document.createElement("h2");
  h2.textContent = "视野";
  group.appendChild(h2);

  const visionFields = [
    { key: "distance", label: "视野距离", min: 1, max: 100, step: 1 },
    { key: "angle", label: "视野角度", min: 10, max: 360, step: 5 },
  ];

  for (const vf of visionFields) {
    const row = document.createElement("div");
    row.className = "control-row";

    const label = document.createElement("label");
    label.innerHTML = `<span>${vf.label}</span><span>${editor.vision[vf.key]}${vf.key === "angle" ? "°" : ""}</span>`;

    const range = document.createElement("input");
    range.type = "range";
    range.min = vf.min;
    range.max = vf.max;
    range.step = vf.step;
    range.value = editor.vision[vf.key];

    const numInput = document.createElement("input");
    numInput.type = "number";
    numInput.min = vf.min;
    numInput.max = vf.max;
    numInput.step = vf.step;
    numInput.value = editor.vision[vf.key];

    range.addEventListener("input", () => {
      const val = Number(range.value);
      numInput.value = val;
      editor.vision[vf.key] = val;
      setDirty(true);
      label.innerHTML = `<span>${vf.label}</span><span>${val}${vf.key === "angle" ? "°" : ""}</span>`;
    });

    numInput.addEventListener("input", () => {
      const val = Number(numInput.value);
      if (!isNaN(val) && val >= vf.min && val <= vf.max) {
        range.value = val;
        editor.vision[vf.key] = val;
        setDirty(true);
        label.innerHTML = `<span>${vf.label}</span><span>${val}${vf.key === "angle" ? "°" : ""}</span>`;
      }
    });

    const rangeRow = document.createElement("div");
    rangeRow.className = "range-row";
    rangeRow.appendChild(range);
    rangeRow.appendChild(numInput);

    row.appendChild(label);
    row.appendChild(rangeRow);
    group.appendChild(row);
  }

  return group;
}

function createMoveSpeedSection() {
  const group = document.createElement("section");
  group.className = "field-group";
  const h2 = document.createElement("h2");
  h2.textContent = "移动速度";
  group.appendChild(h2);

  const speedFields = [
    { key: "normal", label: "常规速度", min: 0.1, max: 10, step: 0.1 },
    { key: "combat", label: "战斗速度", min: 0.1, max: 10, step: 0.1 },
  ];

  for (const sf of speedFields) {
    const row = document.createElement("div");
    row.className = "control-row";

    const label = document.createElement("label");
    label.innerHTML = `<span>${sf.label}</span><span>${editor.moveSpeed[sf.key]}</span>`;

    const range = document.createElement("input");
    range.type = "range";
    range.min = sf.min;
    range.max = sf.max;
    range.step = sf.step;
    range.value = editor.moveSpeed[sf.key];

    const numInput = document.createElement("input");
    numInput.type = "number";
    numInput.min = sf.min;
    numInput.max = sf.max;
    numInput.step = sf.step;
    numInput.value = editor.moveSpeed[sf.key];

    range.addEventListener("input", () => {
      const val = Number(range.value);
      numInput.value = val;
      editor.moveSpeed[sf.key] = val;
      setDirty(true);
      label.innerHTML = `<span>${sf.label}</span><span>${val}</span>`;
    });

    numInput.addEventListener("input", () => {
      const val = Number(numInput.value);
      if (!isNaN(val) && val >= sf.min && val <= sf.max) {
        range.value = val;
        editor.moveSpeed[sf.key] = val;
        setDirty(true);
        label.innerHTML = `<span>${sf.label}</span><span>${val}</span>`;
      }
    });

    const rangeRow = document.createElement("div");
    rangeRow.className = "range-row";
    rangeRow.appendChild(range);
    rangeRow.appendChild(numInput);

    row.appendChild(label);
    row.appendChild(rangeRow);
    group.appendChild(row);
  }

  return group;
}

function createBehaviorTreeSection() {
  const group = document.createElement("section");
  group.className = "field-group";
  const h2 = document.createElement("h2");
  h2.textContent = "行为树";
  group.appendChild(h2);

  // dropdown row
  const selectRow = document.createElement("div");
  selectRow.className = "control-row";
  selectRow.innerHTML = `<label><span>行为树配置</span></label>`;
  const select = document.createElement("select");
  select.dataset.behaviorTreeSelect = "";
  const emptyOpt = document.createElement("option");
  emptyOpt.value = "";
  emptyOpt.textContent = "-- 无 --";
  select.appendChild(emptyOpt);
  select.value = editor.behaviorTreeId || "";
  select.addEventListener("change", () => {
    editor.behaviorTreeId = select.value;
    setDirty(true);
  });
  selectRow.appendChild(select);

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "btn-add";
  refreshBtn.textContent = "刷新";
  refreshBtn.style.width = "50px";
  refreshBtn.addEventListener("click", () => loadBehaviorTreeOptions(select));
  selectRow.appendChild(refreshBtn);
  group.appendChild(selectRow);

  // buttons row
  const btnRow = document.createElement("div");
  btnRow.className = "btn-row";
  btnRow.style.marginTop = "8px";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "btn-add";
  editBtn.textContent = "编辑所选行为树";
  editBtn.addEventListener("click", () => {
    const treeId = editor.behaviorTreeId;
    if (!treeId) { setStatus("请先选择一个行为树", "bad"); return; }
    window.open(`behavior-editor.html?treeId=${encodeURIComponent(treeId)}`, "_blank");
  });
  btnRow.appendChild(editBtn);

  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "btn-add";
  newBtn.textContent = "新建行为树";
  newBtn.addEventListener("click", () => {
    window.open("behavior-editor.html", "_blank");
  });
  btnRow.appendChild(newBtn);
  group.appendChild(btnRow);

  // load options
  loadBehaviorTreeOptions(select);

  return group;
}

async function loadBehaviorTreeOptions(select) {
  try {
    const resp = await fetch("/api/behavior-trees");
    if (!resp.ok) return;
    const data = await resp.json();
    const trees = data.trees || [];

    select.innerHTML = "";
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "-- 无 --";
    select.appendChild(emptyOpt);

    trees.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.name || t.id} (${t.id})`;
      if (t.id === editor.behaviorTreeId) opt.selected = true;
      select.appendChild(opt);
    });
    select.value = editor.behaviorTreeId || "";
  } catch (_) {}
}

async function loadNpcModel(modelType) {
  removeNpcModel();

  const url = ASSETS.models[modelType];
  if (!url) return;

  try {
    const gltf = await loader.loadAsync(url);
    const root = new THREE.Group();
    root.name = `NPCPreview_${modelType}`;
    root.rotation.y = PREVIEW_BASE_YAW;
    root.add(gltf.scene);

    normalizeModel(gltf.scene);

    const meshes = [];
    gltf.scene.traverse((obj) => {
      if (obj.isMesh || obj.isSkinnedMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        meshes.push(obj);
      }
    });

    const skeletonRoot = gltf.scene.getObjectByName("Root");
    const rootRestPosition = skeletonRoot?.position.clone() ?? new THREE.Vector3();
    const rootRestQuaternion = skeletonRoot?.quaternion.clone() ?? new THREE.Quaternion();

    const skOverlay = createSkeletonOverlay(gltf.scene);
    skOverlay.group.visible = false;

    const mixer = new THREE.AnimationMixer(gltf.scene);

    npcModel = {
      modelType,
      root,
      scene: gltf.scene,
      meshes,
      mixer,
      skeletonOverlay: skOverlay,
      rootRestPosition,
      rootRestQuaternion,
    };

    scene.add(root);
    updateSkeletonVisibility();
    updateToolbarInfo();
  } catch (e) {
    console.error("Failed to load NPC model:", e);
    setStatus(`模型加载失败: ${e.message}`, "bad");
  }
}

function removeNpcModel() {
  if (!npcModel) return;
  if (npcModel.skeletonOverlay) {
    scene.remove(npcModel.skeletonOverlay.group);
    disposeSkeletonOverlay(npcModel.skeletonOverlay);
  }
  scene.remove(npcModel.root);
  npcModel.root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach((m) => m.dispose());
      } else {
        obj.material.dispose();
      }
    }
  });
  npcModel = null;
  skeletonOverlay = null;
}

function disposeSkeletonOverlay(overlay) {
  overlay.group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
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
  const group = new THREE.Group();
  group.name = "SkeletonOverlay";

  const bones = [];
  model.traverse((obj) => {
    if (obj.isBone) bones.push(obj);
  });

  if (bones.length === 0) return { group, bones: [], joints: [] };

  const positions = [];
  const joints = [];
  const jointGeo = new THREE.SphereGeometry(0.025, 8, 8);

  bones.forEach((bone) => {
    const worldPos = new THREE.Vector3();
    bone.getWorldPosition(worldPos);
    const localPos = group.worldToLocal(worldPos.clone());

    const jointMat = new THREE.MeshBasicMaterial({
      color: bone.name === "Root" ? 0xf6bd60 : 0x79d2c0,
      depthTest: false,
    });
    const joint = new THREE.Mesh(jointGeo, jointMat);
    joint.position.copy(localPos);
    group.add(joint);
    joints.push({ bone, joint });

    if (bone.parent && bone.parent.isBone) {
      const parentPos = new THREE.Vector3();
      bone.parent.getWorldPosition(parentPos);
      const localParent = group.worldToLocal(parentPos.clone());
      positions.push(localParent.x, localParent.y, localParent.z, localPos.x, localPos.y, localPos.z);
    }
  });

  if (positions.length > 0) {
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x79d2c0,
      depthTest: false,
      opacity: 0.6,
      transparent: true,
    });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    group.add(lines);
  }

  scene.add(group);
  return { group, bones, joints };
}

function updateSkeletonPoses() {
  if (!npcModel || !npcModel.skeletonOverlay) return;
  const overlay = npcModel.skeletonOverlay;
  if (!overlay.group.visible) return;

  overlay.joints.forEach(({ bone, joint }) => {
    const worldPos = new THREE.Vector3();
    bone.getWorldPosition(worldPos);
    joint.position.copy(overlay.group.worldToLocal(worldPos.clone()));
  });

  overlay.group.children.forEach((child) => {
    if (child.isLineSegments) {
      const posAttr = child.geometry.getAttribute("position");
      const arr = posAttr.array;
      let idx = 0;
      for (let i = 0; i < overlay.bones.length; i++) {
        const bone = overlay.bones[i];
        if (!bone.parent || !bone.parent.isBone) continue;
        const parentPos = new THREE.Vector3();
        bone.parent.getWorldPosition(parentPos);
        const localParent = overlay.group.worldToLocal(parentPos.clone());
        const childPos = new THREE.Vector3();
        bone.getWorldPosition(childPos);
        const localChild = overlay.group.worldToLocal(childPos.clone());
        arr[idx] = localParent.x;
        arr[idx + 1] = localParent.y;
        arr[idx + 2] = localParent.z;
        arr[idx + 3] = localChild.x;
        arr[idx + 4] = localChild.y;
        arr[idx + 5] = localChild.z;
        idx += 6;
      }
      posAttr.needsUpdate = true;
    }
  });
}
