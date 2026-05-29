import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  createTerrainMesh,
  applyHeightBrush,
  setTerrainHeights,
  getTerrainHeights,
  getTerrainVertexCount,
  setTerrainVertexColors,
  rebuildTerrain,
  getVerticesInRadius,
  updateTerrainWireframe,
} from "./terrain.js";
import { LayerManager, ColorPalette } from "./vertex-color-layers.js";
import { ObjectManager } from "./object-placement.js";
import "./scene-editor.css";

const DEFAULT_GRID = 64;
const DEFAULT_SIZE = 64;

const editor = {
  currentSceneName: null,
  dirty: false,
  editMode: "terrain",
  terrainTool: "raise",
  brushRadius: 2,
  brushStrength: 1,
  colorTool: "paint",
  colorIntensity: 1,
  colorRadius: 2,
  selectedLayerId: null,
  showWireframe: false,
  gridX: DEFAULT_GRID,
  gridZ: DEFAULT_GRID,
  worldSizeX: DEFAULT_SIZE,
  worldSizeZ: DEFAULT_SIZE,
  terrainBaseColor: "#808080",
  lightingMode: "directional",
  dirLightAzimuth: -45,
  dirLightElevation: 45,
  dirLightIntensity: 5.5,
  ambientIntensity: 2.6,
  hemiIntensity: 3.4,
};

let renderer, scene, camera, controls, clock;
let terrainMesh, terrainWireframe;
let layerManager, colorPalette;
let objectManager;
let loader;
let mouse = new THREE.Vector2();
let raycaster = new THREE.Raycaster();
let isPointerDown = false;
let isGizmoDragging = false;
let gizmoHoverAxis = null;

let ambientLight, hemiLight, keyLight;
let worldGrid;

const refs = {};

window.__SCENE_EDITOR_READY = false;
window.__SCENE_EDITOR_ERROR = null;

boot();

async function boot() {
  mountUI();
  bindUI();

  try {
    setStatus("初始化 WebGPU...");
    await initRenderer();
    bindCanvasEvents();
    bindLightControls();

    setStatus("初始化场景...");
    await initScene();

    drawLightSphere();

    setStatus("加载场景列表...");
    await loadSceneList();

    window.__SCENE_EDITOR_READY = true;
    setStatus("就绪 - 点击地形或添加物件开始编辑", "saved");
    renderer.setAnimationLoop(update);
  } catch (error) {
    console.error(error);
    window.__SCENE_EDITOR_ERROR = error.message;
    setStatus(`初始化失败: ${error.message}`, "bad");
  }
}

function mountUI() {
  const app = document.querySelector("#scene-editor-app");
  app.innerHTML = `
    <div class="editor-shell">
      <aside class="scene-rail">
        <div class="editor-brand">
          <strong>场景编辑器</strong>
          <span>Create / Edit / Save</span>
        </div>
        <div class="new-scene-row">
          <input data-new-scene-name type="text" placeholder="新建场景名..." />
          <button data-new-scene type="button">新建</button>
        </div>
        <div class="scene-list" data-scene-list></div>
      </aside>

      <main class="preview-column">
        <section class="preview-stage" data-viewport>
          <div class="status-pill" data-status>准备中...</div>
          <div class="viewport-toggles">
            <button class="toggle-button" type="button" data-toggle-wireframe>网格</button>
            <div class="light-toggle-wrapper">
              <button class="toggle-button active" type="button" data-toggle-lighting>平行光</button>
              <div class="light-dropdown" data-light-dropdown>
                <canvas class="light-sphere" data-light-sphere width="80" height="80"></canvas>
                <div class="light-sliders">
                  <div class="control-row" style="gap:2px;">
                    <span style="color:#d5cab7;font-size:10px;font-weight:800;">强度</span>
                    <input type="range" data-light-intensity min="0.5" max="15" step="0.1" value="5.5" />
                  </div>
                  <div class="control-row" style="gap:2px;">
                    <span style="color:#d5cab7;font-size:10px;font-weight:800;">颜色</span>
                    <input type="color" data-light-color value="#ffe0aa" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        <div class="toolbar-bar">
          <div class="toolbar-info" data-toolbar-info></div>
        </div>
      </main>

      <aside class="property-panel">
        <div class="panel-head">
          <div class="panel-title">
            <h1 data-panel-title>场景编辑器</h1>
            <span data-panel-subtitle>工具 & 属性</span>
          </div>
          <button class="save-button" data-save-scene2 type="button">保存</button>
        </div>
        <div class="field-scroll" data-field-scroll></div>
      </aside>
    </div>
  `;

  refs.sceneList = document.querySelector("[data-scene-list]");
  refs.newSceneName = document.querySelector("[data-new-scene-name]");
  refs.newSceneBtn = document.querySelector("[data-new-scene]");
  refs.viewport = document.querySelector("[data-viewport]");
  refs.status = document.querySelector("[data-status]");
  refs.toggleWireframe = document.querySelector("[data-toggle-wireframe]");
  refs.toggleLighting = document.querySelector("[data-toggle-lighting]");
  refs.lightDropdown = document.querySelector("[data-light-dropdown]");
  refs.lightSphere = document.querySelector("[data-light-sphere]");
  refs.lightIntensity = document.querySelector("[data-light-intensity]");
  refs.lightColor = document.querySelector("[data-light-color]");
  refs.saveScene2 = document.querySelector("[data-save-scene2]");
  refs.panelTitle = document.querySelector("[data-panel-title]");
  refs.panelSubtitle = document.querySelector("[data-panel-subtitle]");
  refs.fieldScroll = document.querySelector("[data-field-scroll]");
  refs.toolbarInfo = document.querySelector("[data-toolbar-info]");
}

function bindUI() {
  refs.newSceneBtn.addEventListener("click", createNewScene);
  refs.toggleWireframe.addEventListener("click", toggleWireframe);
  refs.toggleLighting.addEventListener("click", toggleLightingMode);
  refs.saveScene2.addEventListener("click", saveCurrentScene);

  window.addEventListener("resize", resize);
  window.addEventListener("keydown", onKeyDown);
}

function bindCanvasEvents() {
  const canvas = renderer.domElement;
  if (!canvas) return;
  canvas.addEventListener("pointerdown", onPointerDown, true);
  canvas.addEventListener("pointermove", onPointerMove, true);
  canvas.addEventListener("pointerup", onPointerUp, true);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
}

async function initRenderer() {
  if (!navigator.gpu) {
    throw new Error("浏览器不支持 WebGPU。请用支持 WebGPU 的 Chrome/Edge 访问。");
  }

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d0c);

  camera = new THREE.PerspectiveCamera(45, 1, 0.5, 300);
  camera.position.set(14, 18, 20);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  await renderer.init();
  refs.viewport.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.minDistance = 4;
  controls.maxDistance = 120;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.mouseButtons = { LEFT: -1, MIDDLE: 2, RIGHT: 0 };
  controls.update();

  ambientLight = new THREE.AmbientLight(0xffffff, editor.ambientIntensity);
  scene.add(ambientLight);
  hemiLight = new THREE.HemisphereLight(0xd8ecff, 0x60442d, editor.hemiIntensity);
  scene.add(hemiLight);
  keyLight = new THREE.DirectionalLight(0xffe0aa, editor.dirLightIntensity);
  scene.add(keyLight);
  updateDirLightPosition();

  worldGrid = new THREE.GridHelper(80, 80, 0x3c473d, 0x252923);
  worldGrid.name = "WorldGrid";
  scene.add(worldGrid);

  loader = new GLTFLoader();

  resize();
}

async function initScene() {
  const { mesh, wireframe } = createTerrainMesh(editor.gridX, editor.gridZ, editor.worldSizeX, editor.worldSizeZ);
  terrainMesh = mesh;
  terrainWireframe = wireframe;
  scene.add(mesh);
  scene.add(wireframe);

  layerManager = new LayerManager(getTerrainVertexCount(terrainMesh));
  colorPalette = new ColorPalette();
  editor.selectedLayerId = layerManager.addLayer("底色");

  applyLayerComposite();

  objectManager = new ObjectManager(scene, loader);

  clock = new THREE.Clock();
  editor.currentSceneName = null;
  editor.dirty = false;
  renderPropertyPanel();
  renderLayersPanel();
  updateSaveButton();
  updateToolbarInfo();
}

function createNewScene() {
  const name = refs.newSceneName.value.trim();
  if (!name) { setStatus("请输入场景名称", "bad"); return; }

  const existing = refs.sceneList.querySelectorAll(".scene-name");
  for (const el of existing) {
    if (el.textContent === name) { setStatus(`场景 "${name}" 已存在`, "bad"); return; }
  }

  editor.currentSceneName = name;
  editor.dirty = true;
  editor.gridX = DEFAULT_GRID;
  editor.gridZ = DEFAULT_GRID;
  editor.worldSizeX = DEFAULT_SIZE;
  editor.worldSizeZ = DEFAULT_SIZE;

  if (terrainMesh) {
    scene.remove(terrainMesh);
    terrainMesh.geometry.dispose();
    terrainMesh.material.dispose();
  }
  if (terrainWireframe) {
    scene.remove(terrainWireframe);
    if (terrainWireframe.geometry) terrainWireframe.geometry.dispose();
    if (terrainWireframe.material) terrainWireframe.material.dispose();
  }

  const { mesh, wireframe } = createTerrainMesh(editor.gridX, editor.gridZ, editor.worldSizeX, editor.worldSizeZ);
  terrainMesh = mesh;
  terrainWireframe = wireframe;
  scene.add(mesh);
  scene.add(wireframe);
  terrainWireframe.visible = editor.showWireframe;

  layerManager = new LayerManager(getTerrainVertexCount(terrainMesh));
  editor.selectedLayerId = layerManager.addLayer("底色");
  colorPalette = new ColorPalette();
  setTerrainVertexColors(terrainMesh, layerManager.compositeAll());

  for (const obj of objectManager.getObjectList()) {
    objectManager.removeObject(obj.id);
  }

  renderSceneList();
  renderPropertyPanel();
  renderLayersPanel();
  updateSaveButton();
  setStatus(`已创建场景 "${name}"`, "saved");
  refs.newSceneName.value = "";
}

async function loadSceneList() {
  try {
    const resp = await fetch("/api/scenes");
    if (!resp.ok) throw new Error(`${resp.status}`);
    const data = await resp.json();
    renderSceneList(data.scenes || []);
  } catch (e) {
    renderSceneList([]);
  }
}

function renderSceneList(existing) {
  if (!existing) {
    const items = refs.sceneList.querySelectorAll(".scene-item");
    existing = [];
    items.forEach((item) => {
      existing.push({ name: item.querySelector(".scene-name").textContent });
    });
  }

  refs.sceneList.innerHTML = "";
  for (const s of existing) {
    const item = document.createElement("div");
    item.className = "scene-item";
    if (s.name === editor.currentSceneName) item.classList.add("active");

    const nameSpan = document.createElement("span");
    nameSpan.className = "scene-name";
    nameSpan.textContent = s.name;

    const delBtn = document.createElement("button");
    delBtn.className = "delete-scene-button";
    delBtn.textContent = "删除";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteScene(s.name);
    });

    item.appendChild(nameSpan);
    item.appendChild(delBtn);
    item.addEventListener("click", () => loadScene(s.name));
    refs.sceneList.appendChild(item);
  }
}

async function loadScene(name) {
  if (editor.dirty && !confirm("当前场景未保存，确定切换到其他场景？")) return;

  try {
    setStatus(`加载场景 "${name}"...`);
    const resp = await fetch(`/api/scenes/${encodeURIComponent(name)}`);
    if (!resp.ok) throw new Error(`${resp.status}`);
    const data = await resp.json();

    editor.currentSceneName = data.name || name;
    editor.dirty = false;
    editor.gridX = data.terrain?.gridX || DEFAULT_GRID;
    editor.gridZ = data.terrain?.gridZ || DEFAULT_GRID;
    editor.worldSizeX = data.terrain?.worldSizeX || DEFAULT_SIZE;
    editor.worldSizeZ = data.terrain?.worldSizeZ || DEFAULT_SIZE;
    editor.terrainBaseColor = data.terrain?.baseColor || "#808080";

    if (terrainMesh) {
      scene.remove(terrainMesh);
      terrainMesh.geometry.dispose();
      terrainMesh.material.dispose();
    }
    if (terrainWireframe) {
      scene.remove(terrainWireframe);
      if (terrainWireframe.geometry) terrainWireframe.geometry.dispose();
      if (terrainWireframe.material) terrainWireframe.material.dispose();
    }

    const { mesh, wireframe } = createTerrainMesh(editor.gridX, editor.gridZ, editor.worldSizeX, editor.worldSizeZ);
    terrainMesh = mesh;
    terrainWireframe = wireframe;
    scene.add(mesh);
    scene.add(wireframe);
    terrainWireframe.visible = editor.showWireframe;

    if (data.terrain?.heights) {
      setTerrainHeights(terrainMesh, new Float32Array(data.terrain.heights));
    }

    layerManager = new LayerManager(getTerrainVertexCount(terrainMesh));
    if (data.vertexColorLayers?.length) {
      layerManager.deserialize(data.vertexColorLayers);
      editor.selectedLayerId = layerManager.getLayerList()[0]?.id || null;
    } else {
      editor.selectedLayerId = layerManager.addLayer("底色");
    }
    setTerrainVertexColors(terrainMesh, layerManager.compositeAll());

    for (const obj of objectManager.getObjectList()) {
      objectManager.removeObject(obj.id);
    }
    if (data.objects?.length) {
      await objectManager.deserialize(data.objects);
    }

    objectManager.toggleWireframes(editor.showWireframe);
    renderSceneList();
    renderPropertyPanel();
    renderLayersPanel();
    updateSaveButton();
    updateToolbarInfo();
    setStatus(`已加载 "${name}"`, "saved");
    drawLightSphere();
  } catch (e) {
    setStatus(`加载失败: ${e.message}`, "bad");
  }
}

async function saveCurrentScene() {
  if (!editor.currentSceneName) {
    const name = prompt("请输入场景名称保存:");
    if (!name) return;
    editor.currentSceneName = name;
  }

  setStatus("保存中...");
  try {
    const data = {
      name: editor.currentSceneName,
      version: 1,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
        terrain: {
        gridX: editor.gridX,
        gridZ: editor.gridZ,
        worldSizeX: editor.worldSizeX,
        worldSizeZ: editor.worldSizeZ,
        heights: Array.from(getTerrainHeights(terrainMesh)),
        baseColor: editor.terrainBaseColor,
      },
      vertexColorLayers: layerManager.serialize(),
      objects: objectManager.serialize(),
    };

    const resp = await fetch(`/api/scenes/${encodeURIComponent(editor.currentSceneName)}`, {
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
    loadSceneList();
    setStatus(`已保存 "${editor.currentSceneName}"`, "saved");
  } catch (e) {
    setStatus(`保存失败: ${e.message}`, "bad");
  }
}

async function deleteScene(name) {
  if (!confirm(`确定删除场景 "${name}"？此操作不可撤销。`)) return;
  try {
    const resp = await fetch(`/api/scenes/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!resp.ok) throw new Error(`${resp.status}`);
    if (editor.currentSceneName === name) {
      editor.currentSceneName = null;
      editor.dirty = false;
    }
    loadSceneList();
    setStatus(`已删除 "${name}"`, "saved");
  } catch (e) {
    setStatus(`删除失败: ${e.message}`, "bad");
  }
}

function toggleWireframe() {
  editor.showWireframe = !editor.showWireframe;
  refs.toggleWireframe.classList.toggle("active", editor.showWireframe);
  if (terrainWireframe) terrainWireframe.visible = editor.showWireframe;
  objectManager.toggleWireframes(editor.showWireframe);
  if (worldGrid) worldGrid.visible = editor.showWireframe;
}

function renderPropertyPanel() {
  const scroll = refs.fieldScroll;
  scroll.innerHTML = "";

  scroll.appendChild(createEditModeSection());

  if (editor.editMode === "terrain") {
    scroll.appendChild(createFieldGroup("场景设置", [
      { type: "split", children: [
        { label: "网格 X", key: "gridX", type: "number", value: editor.gridX, min: 16, max: 1024, step: 1, onChange: (v) => changeGridSize(v, "X") },
        { label: "网格 Z", key: "gridZ", type: "number", value: editor.gridZ, min: 16, max: 1024, step: 1, onChange: (v) => changeGridSize(v, "Z") },
      ]},
      { type: "split", children: [
        { label: "尺寸 X", key: "worldSizeX", type: "number", value: editor.worldSizeX, min: 8, max: 512, step: 1, onChange: (v) => changeWorldSize(v, "X") },
        { label: "尺寸 Z", key: "worldSizeZ", type: "number", value: editor.worldSizeZ, min: 8, max: 512, step: 1, onChange: (v) => changeWorldSize(v, "Z") },
      ]},
    ]));
  }

  const terrainSection = createTerrainToolSection();
  if (terrainSection) scroll.appendChild(terrainSection);
  const colorSection = createColorToolSection();
  if (colorSection) scroll.appendChild(colorSection);
  scroll.appendChild(createObjectSection());
}

function changeGridSize(v, axis) {
  const val = Math.max(16, Math.min(1024, v));
  if (axis === "X") editor.gridX = val;
  else editor.gridZ = val;
  rebuildTerrainMesh();
  editor.dirty = true;
  updateSaveButton();
}

function changeWorldSize(v, axis) {
  const val = Math.max(8, Math.min(512, v));
  if (axis === "X") editor.worldSizeX = val;
  else editor.worldSizeZ = val;
  rebuildTerrainMesh();
  editor.dirty = true;
  updateSaveButton();
}

function rebuildTerrainMesh() {
  const oldHD = getTerrainHeights(terrainMesh);
  const oldColors = layerManager.serialize();
  const oldVertCount = getTerrainVertexCount(terrainMesh);

  rebuildTerrain(terrainMesh, terrainWireframe, editor.gridX, editor.gridZ, editor.worldSizeX, editor.worldSizeZ);
  terrainWireframe.visible = editor.showWireframe;

  const newVertCount = getTerrainVertexCount(terrainMesh);
  layerManager = new LayerManager(newVertCount);
  layerManager.deserialize(oldColors);
  if (!layerManager.getLayerList().length) {
    editor.selectedLayerId = layerManager.addLayer("底色");
  }

  const hd = getTerrainHeights(terrainMesh);
  const minCount = Math.min(oldHD.length, hd.length);
  for (let i = 0; i < minCount; i++) hd[i] = oldHD[i];
  setTerrainHeights(terrainMesh, hd);
  setTerrainVertexColors(terrainMesh, layerManager.compositeAll());
  renderLayersPanel();
}

function createFieldGroup(title, controls) {
  const group = document.createElement("section");
  group.className = "field-group";
  const h2 = document.createElement("h2");
  h2.textContent = title;
  group.appendChild(h2);

  for (const ctrl of controls) {
    if (ctrl.type === "split") {
      const row = document.createElement("div");
      row.className = "split-row";
      for (const child of ctrl.children) {
        row.appendChild(buildControl(child));
      }
      group.appendChild(row);
    } else {
      group.appendChild(buildControl(ctrl));
    }
  }
  return group;
}

function buildControl(ctrl) {
  if (ctrl.type === "number") {
    const row = document.createElement("div");
    row.className = "control-row";
    const label = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = ctrl.label;
    label.appendChild(text);
    const input = document.createElement("input");
    input.type = "number";
    input.min = ctrl.min;
    input.max = ctrl.max;
    input.step = ctrl.step || 1;
    input.value = ctrl.value;
    input.addEventListener("input", () => ctrl.onChange(Number(input.value)));
    row.appendChild(label);
    row.appendChild(input);
    return row;
  }
  if (ctrl.type === "raw") return ctrl.element;
  return document.createElement("div");
}

function createEditModeSection() {
  const group = document.createElement("section");
  group.className = "field-group";
  const h2 = document.createElement("h2");
  h2.textContent = "编辑模式";
  group.appendChild(h2);

  const modeRow = document.createElement("div");
  modeRow.className = "tool-row";

  const modes = [
    { key: "terrain", label: "地形" },
    { key: "color", label: "着色" },
    { key: "select", label: "物件" },
  ];

  modes.forEach((m) => {
    const btn = document.createElement("button");
    btn.textContent = m.label;
    btn.dataset.editMode = m.key;
    btn.addEventListener("click", () => {
      editor.editMode = m.key;
      editor.editModeEls.forEach((b) => b.classList.toggle("active-tool", b.dataset.editMode === m.key));
      controls.enabled = true;
      renderPropertyPanel();
      updateToolbarInfo();
    });
    if (m.key === editor.editMode) btn.classList.add("active-tool");
    modeRow.appendChild(btn);
  });

  editor.editModeEls = Array.from(modeRow.querySelectorAll("button"));
  group.appendChild(modeRow);

  const hintRow = document.createElement("div");
  hintRow.style.cssText = "color:#8fa79e;font-size:10px;padding-top:2px;";
  hintRow.textContent = editor.editMode === "terrain"
    ? "点击地形编辑高度"
    : editor.editMode === "color"
    ? "点击地形绘制顶点色"
    : "点击物件选中 / 拖拽Gizmo";
  group.appendChild(hintRow);

  return group;
}

function createTerrainToolSection() {
  if (editor.editMode !== "terrain") return null;
  const group = document.createElement("section");
  group.className = "field-group";
  const h2 = document.createElement("h2");
  h2.textContent = "地形工具";
  group.appendChild(h2);

  const toolRow = document.createElement("div");
  toolRow.className = "tool-row";
  ["raise", "lower", "flatten"].forEach((t) => {
    const btn = document.createElement("button");
    btn.textContent = { raise: "升", lower: "降", flatten: "抹平" }[t];
    btn.dataset.terrainTool = t;
    btn.addEventListener("click", () => {
      editor.terrainTool = t;
      editor.terrainToolEls.forEach((b) => b.classList.toggle("active-tool", b.dataset.terrainTool === t));
    });
    if (t === editor.terrainTool) btn.classList.add("active-tool");
    toolRow.appendChild(btn);
  });
  editor.terrainToolEls = Array.from(toolRow.querySelectorAll("button"));
  group.appendChild(toolRow);

  group.appendChild(buildSlider("笔刷大小", "brushRadius", editor.brushRadius, 0.5, 20, 0.1, (v) => { editor.brushRadius = v; }));
  group.appendChild(buildSlider("强度", "brushStrength", editor.brushStrength, 0.05, 2, 0.05, (v) => { editor.brushStrength = v; }));

  const colorRow = document.createElement("div");
  colorRow.className = "control-row";
  colorRow.style.display = "flex";
  colorRow.style.gap = "6px";
  colorRow.style.alignItems = "center";
  const baseColorInput = document.createElement("input");
  baseColorInput.type = "color";
  baseColorInput.value = editor.terrainBaseColor;
  baseColorInput.addEventListener("input", () => {
    editor.terrainBaseColor = baseColorInput.value;
    applyLayerComposite();
    editor.dirty = true;
  });
  colorRow.appendChild(baseColorInput);
  const baseLabel = document.createElement("span");
  baseLabel.textContent = "地形底色";
  baseLabel.style.cssText = "color:#d5cab7;font-size:12px;font-weight:800;";
  colorRow.appendChild(baseLabel);
  group.appendChild(colorRow);

  return group;
}

function createColorToolSection() {
  if (editor.editMode !== "color") return null;
  const group = document.createElement("section");
  group.className = "field-group";
  const h2 = document.createElement("h2");
  h2.textContent = "顶点着色";
  group.appendChild(h2);

  const toolRow = document.createElement("div");
  toolRow.className = "tool-row two-col";
  ["paint", "erase"].forEach((t) => {
    const btn = document.createElement("button");
    btn.textContent = { paint: "笔刷", erase: "橡皮擦" }[t];
    btn.dataset.colorTool = t;
    btn.addEventListener("click", () => {
      editor.colorTool = t;
      editor.colorToolEls.forEach((b) => b.classList.toggle("active-tool", b.dataset.colorTool === t));
    });
    if (t === editor.colorTool) btn.classList.add("active-tool");
    toolRow.appendChild(btn);
  });
  editor.colorToolEls = Array.from(toolRow.querySelectorAll("button"));
  group.appendChild(toolRow);

  const paletteDiv = document.createElement("div");
  paletteDiv.className = "color-palette";
  colorPalette.presets.forEach((p, i) => {
    const swatch = document.createElement("div");
    swatch.className = "color-swatch";
    swatch.style.backgroundColor = p.hex;
    swatch.title = p.name;
    if (p.hex === colorPalette.currentHex) swatch.classList.add("selected");
    swatch.addEventListener("click", () => {
      colorPalette.setColor(p.hex);
      paletteDiv.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("selected"));
      swatch.classList.add("selected");
    });
    paletteDiv.appendChild(swatch);
  });
  group.appendChild(paletteDiv);

  const customRow = document.createElement("div");
  customRow.className = "control-row";
  customRow.style.display = "flex";
  customRow.style.gap = "6px";
  customRow.style.alignItems = "center";
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = colorPalette.currentHex;
  colorInput.addEventListener("input", () => {
    colorPalette.setColor(colorInput.value);
  });
  customRow.appendChild(colorInput);
  const label = document.createElement("span");
  label.textContent = "自选颜色";
  label.style.cssText = "color:#d5cab7;font-size:12px;font-weight:800;";
  customRow.appendChild(label);
  group.appendChild(customRow);

  group.appendChild(buildSlider("着色笔刷大小", "colorRadius", editor.colorRadius, 0.5, 20, 0.1, (v) => { editor.colorRadius = v; }));
  group.appendChild(buildSlider("颜色强度", "colorIntensity", editor.colorIntensity, 0.05, 1, 0.05, (v) => { editor.colorIntensity = v; }));

  const layersContainer = document.createElement("div");
  layersContainer.setAttribute("data-layers-container", "");
  group.appendChild(layersContainer);
  editor.layersContainer = layersContainer;

  const addLayerBtn = document.createElement("button");
  addLayerBtn.textContent = "+ 添加图层";
  addLayerBtn.addEventListener("click", () => {
    const id = layerManager.addLayer("新图层");
    editor.selectedLayerId = id;
    renderLayersPanel();
    editor.dirty = true;
    updateSaveButton();
  });
  group.appendChild(addLayerBtn);

  return group;
}

function renderLayersPanel() {
  if (!editor.layersContainer) return;
  const container = editor.layersContainer;
  container.innerHTML = "";

  const layers = layerManager.getLayerList();
  for (const layer of layers) {
    const item = document.createElement("div");
    item.className = "layer-item";

    const visCheck = document.createElement("input");
    visCheck.type = "checkbox";
    visCheck.checked = layer.visible;
    visCheck.title = "显示/隐藏";
    visCheck.addEventListener("change", () => {
      layerManager.setLayerVisibility(layer.id, visCheck.checked);
      applyLayerComposite();
      editor.dirty = true;
      updateSaveButton();
    });

    const nameSpan = document.createElement("span");
    nameSpan.className = "layer-name";
    nameSpan.textContent = layer.name;
    nameSpan.title = layer.name;
    nameSpan.addEventListener("dblclick", () => {
      const newName = prompt("图层名称:", layer.name);
      if (newName) {
        layer.name = newName;
        renderLayersPanel();
        editor.dirty = true;
        updateSaveButton();
      }
    });

    const modeSelect = document.createElement("select");
    modeSelect.innerHTML = "";
    for (const [mode, info] of Object.entries({ normal: "覆盖", multiply: "正片叠底", overlay: "叠加" })) {
      const opt = document.createElement("option");
      opt.value = mode;
      opt.textContent = info;
      if (layer.blendMode === mode) opt.selected = true;
      modeSelect.appendChild(opt);
    }
    modeSelect.addEventListener("change", () => {
      layerManager.setLayerBlendMode(layer.id, modeSelect.value);
      applyLayerComposite();
      editor.dirty = true;
      updateSaveButton();
    });

    const delBtn = document.createElement("button");
    delBtn.textContent = "删";
    delBtn.title = "删除图层";
    delBtn.addEventListener("click", () => {
      if (layerManager.getLayerList().length <= 1) {
        setStatus("必须保留至少一个图层", "bad");
        return;
      }
      layerManager.removeLayer(layer.id);
      if (editor.selectedLayerId === layer.id) {
        editor.selectedLayerId = layerManager.getLayerList()[0]?.id || null;
      }
      renderLayersPanel();
      applyLayerComposite();
      editor.dirty = true;
      updateSaveButton();
    });

    item.style.borderColor = (layer.id === editor.selectedLayerId) ? "rgba(121,210,192,0.6)" : "";
    item.addEventListener("click", () => {
      editor.selectedLayerId = layer.id;
      renderLayersPanel();
    });

    item.appendChild(visCheck);
    item.appendChild(nameSpan);
    item.appendChild(modeSelect);
    item.appendChild(delBtn);
    container.appendChild(item);
  }
}

function applyLayerComposite() {
  if (!terrainMesh) return;
  const [br, bg, bb] = hexToRgb(editor.terrainBaseColor);
  setTerrainVertexColors(terrainMesh, layerManager.compositeAll([br, bg, bb]));
}

function hexToRgb(hex) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const num = parseInt(hex, 16);
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

function createObjectSection() {
  const group = document.createElement("section");
  group.className = "field-group";
  const h2 = document.createElement("h2");
  h2.textContent = "物件管理";
  group.appendChild(h2);

  const addRow = document.createElement("div");
  addRow.className = "obj-add-buttons";
  [
    { type: "voxelCube", label: "体素方块" },
    { type: "voxelCampfire", label: "篝火" },
    { type: "male", label: "男主" },
    { type: "female", label: "女主" },
  ].forEach((def) => {
    const btn = document.createElement("button");
    btn.textContent = def.label;
    btn.addEventListener("click", async () => {
      await objectManager.createObject(def.type, new THREE.Vector3(0, 1, 0));
      editor.dirty = true;
      updateSaveButton();
      renderObjectList();
    });
    addRow.appendChild(btn);
  });
  group.appendChild(addRow);

  const objListContainer = document.createElement("div");
  objListContainer.setAttribute("data-obj-list", "");
  group.appendChild(objListContainer);
  editor.objListContainer = objListContainer;

  const objProps = document.createElement("div");
  objProps.setAttribute("data-obj-props", "");
  group.appendChild(objProps);
  editor.objPropsContainer = objProps;

  renderObjectList();
  renderObjectProps();

  return group;
}

function renderObjectList() {
  if (!editor.objListContainer) return;
  const container = editor.objListContainer;
  container.innerHTML = "";

  const objects = objectManager.getObjectList();
  if (!objects.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:#8fa79e;font-size:11px;padding:4px 0;";
    empty.textContent = "点击上方按钮添加物件";
    container.appendChild(empty);
    return;
  }

  for (const obj of objects) {
    const item = document.createElement("div");
    item.className = "obj-list-item";
    if (obj.id === objectManager.selectedId) item.classList.add("active");

    const selectBtn = document.createElement("button");
    const typeLabel = { voxelCube: "方块", voxelCampfire: "篝火", male: "男主", female: "女主" }[obj.type] || obj.type;
    selectBtn.textContent = `${typeLabel} (${obj.id.slice(-4)})`;
    selectBtn.addEventListener("click", () => {
      objectManager.select(obj.id);
      renderObjectList();
      renderObjectProps();
      controls.enabled = true;
    });

    const delBtn = document.createElement("button");
    delBtn.className = "delete-obj-button";
    delBtn.textContent = "删";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      objectManager.removeObject(obj.id);
      editor.dirty = true;
      updateSaveButton();
      renderObjectList();
      renderObjectProps();
    });

    item.appendChild(selectBtn);
    item.appendChild(delBtn);
    container.appendChild(item);
  }
}

function renderObjectProps() {
  if (!editor.objPropsContainer) return;
  const container = editor.objPropsContainer;
  container.innerHTML = "";

  const selected = objectManager.getSelected();
  if (!selected) {
    const hint = document.createElement("div");
    hint.style.cssText = "color:#8fa79e;font-size:11px;padding:8px 0;";
    hint.textContent = "选中物件后在此调整属性";
    container.appendChild(hint);
    return;
  }

  const posGroup = document.createElement("section");
  posGroup.className = "field-group";
  posGroup.style.paddingTop = "8px";
  posGroup.style.borderTop = "none";
  posGroup.innerHTML = "<h2>位置 (XYZ)</h2>";
  posGroup.appendChild(buildVector3Control("Pos", selected.position, (v) => {
    objectManager.setPosition(selected.id, v.x, v.y, v.z);
    editor.dirty = true;
    updateSaveButton();
  }));
  container.appendChild(posGroup);

  const rotGroup = document.createElement("section");
  rotGroup.className = "field-group";
  rotGroup.innerHTML = "<h2>旋转 (XYZ 度)</h2>";
  const resetRotBtn = document.createElement("button");
  resetRotBtn.className = "reset-button";
  resetRotBtn.textContent = "重置旋转";
  resetRotBtn.addEventListener("click", () => {
    objectManager.resetRotation(selected.id);
    editor.dirty = true;
    updateSaveButton();
    renderObjectProps();
  });
  rotGroup.appendChild(buildVector3Control("Rot", new THREE.Vector3(
    THREE.MathUtils.radToDeg(selected.rotation.x),
    THREE.MathUtils.radToDeg(selected.rotation.y),
    THREE.MathUtils.radToDeg(selected.rotation.z),
  ), (v) => {
    objectManager.setRotation(selected.id,
      THREE.MathUtils.degToRad(v.x),
      THREE.MathUtils.degToRad(v.y),
      THREE.MathUtils.degToRad(v.z),
    );
    editor.dirty = true;
    updateSaveButton();
  }));
  rotGroup.appendChild(resetRotBtn);
  container.appendChild(rotGroup);

  const scaleGroup = document.createElement("section");
  scaleGroup.className = "field-group";
  scaleGroup.innerHTML = "<h2>大小 (XYZ)</h2>";
  const resetScaleBtn = document.createElement("button");
  resetScaleBtn.className = "reset-button";
  resetScaleBtn.textContent = "重置大小";
  resetScaleBtn.style.marginBottom = "8px";
  resetScaleBtn.addEventListener("click", () => {
    objectManager.resetScale(selected.id);
    editor.dirty = true;
    updateSaveButton();
    renderObjectProps();
  });
  scaleGroup.appendChild(resetScaleBtn);
  scaleGroup.appendChild(buildVector3Control("Scl", selected.scale, (v) => {
    objectManager.setScale(selected.id, v.x, v.y, v.z);
    editor.dirty = true;
    updateSaveButton();
  }));
  container.appendChild(scaleGroup);

  const delBtn = document.createElement("button");
  delBtn.className = "delete-button";
  delBtn.style.width = "100%";
  delBtn.style.marginTop = "8px";
  delBtn.textContent = "删除物件";
  delBtn.addEventListener("click", () => {
    objectManager.removeObject(selected.id);
    editor.dirty = true;
    updateSaveButton();
    renderObjectList();
    renderObjectProps();
  });
  container.appendChild(delBtn);

  const hint = document.createElement("div");
  hint.className = "shortcut-hint";
  hint.textContent = "TAB: 取消选中 | 箭头键: 微调位置 | Shift: 加速";
  container.appendChild(hint);
}

function buildVector3Control(prefix, vec, onChange) {
  const container = document.createElement("div");

  const row = document.createElement("div");
  row.className = "split-row";
  ["x", "y", "z"].forEach((axis) => {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = "0.1";
    inp.value = parseFloat(vec[axis].toFixed(2));
    inp.title = `${prefix}.${axis}`;
    inp.style.fontSize = "11px";
    inp.addEventListener("input", () => {
      vec[axis] = parseFloat(inp.value) || 0;
      onChange(vec);
    });
    row.appendChild(inp);
  });
  container.appendChild(row);

  const nudgeRow = document.createElement("div");
  nudgeRow.className = "nudge-grid";
  [
    { label: "+X", axis: "x", delta: 0.1 },
    { label: "+Y", axis: "y", delta: 0.1 },
    { label: "+Z", axis: "z", delta: 0.1 },
    { label: "-X", axis: "x", delta: -0.1 },
    { label: "-Y", axis: "y", delta: -0.1 },
    { label: "-Z", axis: "z", delta: -0.1 },
  ].forEach((n) => {
    const btn = document.createElement("button");
    btn.className = "nudge-btn";
    btn.textContent = n.label;
    btn.addEventListener("click", () => {
      vec[n.axis] += n.delta;
      vec[n.axis] = parseFloat(vec[n.axis].toFixed(2));
      onChange(vec);
      const inputs = container.querySelectorAll("input");
      if (n.axis === "x") inputs[0].value = vec[n.axis];
      if (n.axis === "y") inputs[1].value = vec[n.axis];
      if (n.axis === "z") inputs[2].value = vec[n.axis];
    });
    nudgeRow.appendChild(btn);
  });
  container.appendChild(nudgeRow);

  return container;
}

function buildSlider(label, key, value, min, max, step, onChange) {
  const row = document.createElement("div");
  row.className = "control-row";

  const headerRow = document.createElement("div");
  headerRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;";
  const lbl = document.createElement("span");
  lbl.textContent = label;
  lbl.style.cssText = "color:#d5cab7;font-size:12px;font-weight:800;";
  const valSpan = document.createElement("span");
  valSpan.textContent = parseFloat(value).toFixed(2);
  valSpan.style.cssText = "color:#aeb9ae;font-size:11px;";
  headerRow.appendChild(lbl);
  headerRow.appendChild(valSpan);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = min;
  slider.max = max;
  slider.step = step;
  slider.value = value;
  slider.addEventListener("input", () => {
    valSpan.textContent = parseFloat(slider.value).toFixed(2);
    onChange(parseFloat(slider.value));
  });

  row.appendChild(headerRow);
  row.appendChild(slider);
  return row;
}

function onPointerDown(event) {
  isPointerDown = true;
  updateMouse(event);

  if (event.button !== 0) return;

  const gizmoIntersectables = objectManager.gizmo.getIntersectables();
  raycaster.setFromCamera(mouse, camera);
  const gizmoHits = raycaster.intersectObjects(gizmoIntersectables, false);

  if (gizmoHits.length > 0) {
    const hitObj = gizmoHits[0].object;
    for (const arrow of objectManager.gizmo.arrows) {
      let found = false;
      arrow.traverse((child) => { if (child === hitObj) found = true; });
      if (found) {
        isGizmoDragging = true;
        controls.enabled = false;
        objectManager.gizmo.startDrag(
          arrow.userData.gizmoAxis,
          raycaster,
          mouse,
          camera,
        );
        event.stopImmediatePropagation();
        return;
      }
    }
  }

  const objHitId = objectManager.hitTest(raycaster);
  if (objHitId) {
    objectManager.select(objHitId);
    controls.enabled = true;
    renderObjectList();
    renderObjectProps();
    updateToolbarInfo();
    event.stopImmediatePropagation();
    return;
  }

  const terrainHits = raycaster.intersectObject(terrainMesh);
  if (terrainHits.length > 0) {
    event.stopImmediatePropagation();
    if (editor.editMode === "terrain") {
      controls.enabled = false;
      applyTerrainTool(terrainHits[0].point);
    }
    if (editor.editMode === "color" && editor.colorTool === "paint" && editor.selectedLayerId) {
      applyColorPaint(terrainHits[0].point);
    }
    if (editor.editMode === "color" && editor.colorTool === "erase" && editor.selectedLayerId) {
      applyColorErase(terrainHits[0].point);
    }
    if (editor.editMode !== "select") {
      objectManager.deselect();
      renderObjectList();
      renderObjectProps();
    }
    updateToolbarInfo();
    return;
  }

  objectManager.deselect();
  renderObjectList();
  renderObjectProps();
  updateToolbarInfo();
}

function onPointerMove(event) {
  updateMouse(event);

  if (isGizmoDragging) {
    raycaster.setFromCamera(mouse, camera);
    const delta = objectManager.gizmo.updateDrag(raycaster, camera);
    const selected = objectManager.getSelected();
    if (selected && delta.lengthSq() > 0) {
      const newPos = selected.position.clone().add(delta);
      objectManager.setPosition(selected.id, newPos.x, newPos.y, newPos.z);
      editor.dirty = true;
      updateSaveButton();
      renderObjectProps();
    }
    return;
  }

  if (isPointerDown && !controls.enabled) {
    raycaster.setFromCamera(mouse, camera);
    const terrainHits = raycaster.intersectObject(terrainMesh);
    if (terrainHits.length > 0 && editor.editMode === "terrain") {
      applyTerrainTool(terrainHits[0].point);
    }
    if (terrainHits.length > 0 && editor.editMode === "color" && editor.colorTool === "paint" && editor.selectedLayerId) {
      applyColorPaint(terrainHits[0].point);
    }
    if (terrainHits.length > 0 && editor.editMode === "color" && editor.colorTool === "erase" && editor.selectedLayerId) {
      applyColorErase(terrainHits[0].point);
    }
    return;
  }

  if (objectManager.gizmo.group.visible) {
    raycaster.setFromCamera(mouse, camera);
    const gizmoHits = raycaster.intersectObjects(objectManager.gizmo.getIntersectables(), false);
    if (gizmoHits.length > 0) {
      const hitObj = gizmoHits[0].object;
      for (const arrow of objectManager.gizmo.arrows) {
        let found = false;
        arrow.traverse((child) => { if (child === hitObj) found = true; });
        if (found && gizmoHoverAxis !== arrow.userData.gizmoAxis) {
          gizmoHoverAxis = arrow.userData.gizmoAxis;
          objectManager.gizmo.highlightAxis(gizmoHoverAxis);
          break;
        }
      }
    } else if (gizmoHoverAxis !== null) {
      gizmoHoverAxis = null;
      objectManager.gizmo.resetHighlights();
    }
  }
}

function onPointerUp() {
  isPointerDown = false;
  if (isGizmoDragging) {
    isGizmoDragging = false;
    objectManager.gizmo.endDrag();
  }
  if (!controls.enabled && !isGizmoDragging) {
    controls.enabled = true;
  }
}

function applyTerrainTool(worldHit) {
  applyHeightBrush(terrainMesh, worldHit, editor.brushRadius, editor.terrainTool, editor.brushStrength);
  updateTerrainWireframe(terrainMesh, terrainWireframe);
  terrainWireframe.visible = editor.showWireframe;
  editor.dirty = true;
  updateSaveButton();
  updateToolbarInfo();
}

function applyColorPaint(worldHit) {
  const vertices = getVerticesInRadius(terrainMesh, worldHit, editor.colorRadius);
  const [r, g, b] = colorPalette.getRGB();
  layerManager.paintVertices(editor.selectedLayerId, vertices, r, g, b, editor.colorIntensity);
  applyLayerComposite();
  editor.dirty = true;
  updateSaveButton();
}

function applyColorErase(worldHit) {
  const vertices = getVerticesInRadius(terrainMesh, worldHit, editor.colorRadius);
  const indices = vertices.map((v) => v.vertexIndex);
  layerManager.eraseVertices(editor.selectedLayerId, indices);
  applyLayerComposite();
  editor.dirty = true;
  updateSaveButton();
}

function onKeyDown(event) {
  const selected = objectManager.getSelected();
  if (!selected) return;

  const step = event.shiftKey ? 1.0 : 0.1;
  let dx = 0, dy = 0, dz = 0;
  switch (event.code) {
    case "ArrowUp": dz = -step; break;
    case "ArrowDown": dz = step; break;
    case "ArrowLeft": dx = -step; break;
    case "ArrowRight": dx = step; break;
    case "PageUp": dy = step; break;
    case "PageDown": dy = -step; break;
    case "Tab":
      event.preventDefault();
      objectManager.deselect();
      controls.enabled = true;
      renderObjectList();
      renderObjectProps();
      updateToolbarInfo();
      return;
    case "Delete":
    case "Backspace":
      event.preventDefault();
      objectManager.removeObject(selected.id);
      editor.dirty = true;
      updateSaveButton();
      renderObjectList();
      renderObjectProps();
      updateToolbarInfo();
      return;
    case "KeyS":
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        saveCurrentScene();
        return;
      }
      break;
    default: return;
  }

  if (dx !== 0 || dy !== 0 || dz !== 0) {
    event.preventDefault();
    const p = selected.position;
    objectManager.setPosition(selected.id, p.x + dx, p.y + dy, p.z + dz);
    editor.dirty = true;
    updateSaveButton();
    renderObjectProps();
    updateToolbarInfo();
  }
}

function updateMouse(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function update(timeMs) {
  const delta = Math.min(clock.getDelta(), 0.05);
  controls?.update();

  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }

  updateToolbarInfo();
}

function bindLightControls() {
  const canvas = refs.lightSphere;
  if (!canvas) return;

  let isLightDrag = false;

  canvas.addEventListener("pointerdown", (e) => {
    isLightDrag = true;
    canvas.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!isLightDrag) return;
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = e.clientX - rect.left - cx;
    const dy = e.clientY - rect.top - cy;
    const r = cx - 5;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 2) return;
    const nx = dx / dist;
    const ny = -dy / dist;
    const clampedDist = Math.min(dist / r, 1);
    const theta = Math.atan2(nx, ny);
    const phi = clampedDist * (Math.PI / 2);
    const azimuth = THREE.MathUtils.radToDeg(theta - Math.PI / 2);
    const elevation = 90 - THREE.MathUtils.radToDeg(phi);
    editor.dirLightAzimuth = Math.round(azimuth);
    editor.dirLightElevation = THREE.MathUtils.clamp(Math.round(elevation), 5, 85);
    updateDirLightPosition();
    updateLightSphere();
    drawLightSphere();
  });
  canvas.addEventListener("pointerup", () => { isLightDrag = false; });
  canvas.addEventListener("pointerleave", () => { isLightDrag = false; });

  refs.lightIntensity.addEventListener("input", () => {
    editor.dirLightIntensity = parseFloat(refs.lightIntensity.value);
    if (keyLight) keyLight.intensity = editor.dirLightIntensity;
  });
  refs.lightColor.addEventListener("input", () => {
    if (keyLight) keyLight.color.set(refs.lightColor.value);
  });
}

function drawLightSphere() {
  const canvas = refs.lightSphere;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2, r = cx - 6;

  ctx.clearRect(0, 0, w, h);

  const grd = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.05, cx, cy, r);
  grd.addColorStop(0, "#e8e4d8");
  grd.addColorStop(0.5, "#8a8578");
  grd.addColorStop(1, "#3a3530");
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = grd;
  ctx.fill();
  ctx.strokeStyle = "rgba(244,239,230,0.3)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const azimuth = THREE.MathUtils.degToRad(editor.dirLightAzimuth);
  const elevation = THREE.MathUtils.degToRad(editor.dirLightElevation);
  const phi = Math.PI / 2 - elevation;
  const lx = Math.cos(phi) * Math.sin(azimuth);
  const ly = Math.sin(phi);
  const lz = Math.cos(phi) * Math.cos(azimuth);

  const sx = cx;
  const sy = cy;
  const ex = cx + lx * r * 0.85;
  const ey = cy - ly * r * 0.85;

  ctx.beginPath();
  ctx.moveTo(sx - lx * r * 0.15, sy + ly * r * 0.15);
  ctx.lineTo(ex, ey);
  ctx.strokeStyle = "#ffdd57";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(ex, ey, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#ffdd57";
  ctx.fill();
}

function updateLightSphere() {
  refs.lightIntensity.value = editor.dirLightIntensity;
  refs.lightColor.value = `#${(new THREE.Color(keyLight ? keyLight.color.getHex() : 0xffe0aa)).getHexString()}`;
}

function toggleLightingMode() {
  editor.lightingMode = editor.lightingMode === "flat" ? "directional" : "flat";
  if (editor.lightingMode === "flat") {
    hemiLight.visible = false;
    keyLight.visible = false;
    ambientLight.intensity = 6;
    refs.toggleLighting.textContent = "无光";
    refs.toggleLighting.classList.remove("active");
    refs.lightDropdown.style.display = "none";
  } else {
    hemiLight.visible = true;
    keyLight.visible = true;
    ambientLight.intensity = editor.ambientIntensity;
    refs.toggleLighting.textContent = "平行光";
    refs.toggleLighting.classList.add("active");
    refs.lightDropdown.style.display = "";
  }
}

function updateDirLightPosition() {
  if (!keyLight) return;
  const azimuth = THREE.MathUtils.degToRad(editor.dirLightAzimuth);
  const elevation = THREE.MathUtils.degToRad(editor.dirLightElevation);
  const dist = 12;
  keyLight.position.set(
    Math.cos(elevation) * Math.sin(azimuth) * dist,
    Math.sin(elevation) * dist,
    Math.cos(elevation) * Math.cos(azimuth) * dist,
  );
  drawLightSphere();
}

function updateToolbarInfo() {
  if (!refs.toolbarInfo) return;
  const selected = objectManager.getSelected();
  const modeLabel = editor.editMode === "terrain" ? "地形" : editor.editMode === "color" ? "着色" : "物件";
  const toolLabel = editor.editMode === "terrain"
    ? (editor.terrainTool === "raise" ? "升" : editor.terrainTool === "lower" ? "降" : "抹平")
    : editor.editMode === "color"
    ? (editor.colorTool === "paint" ? "笔刷" : "橡皮擦")
    : "";
  let info = `模式: ${modeLabel}`;
  if (toolLabel) info += ` | 工具: ${toolLabel}`;
  if (selected) {
    info += ` | 选中: ${selected.type}`;
    info += ` | Pos: ${selected.position.x.toFixed(1)},${selected.position.y.toFixed(1)},${selected.position.z.toFixed(1)}`;
  }
  refs.toolbarInfo.textContent = info;
}

function updateSaveButton() {
  if (refs.saveScene2) refs.saveScene2.classList.toggle("dirty", editor.dirty);
}

function setStatus(text, kind = "") {
  if (!refs.status) return;
  refs.status.textContent = text;
  refs.status.classList.toggle("saved", kind === "saved");
  refs.status.classList.toggle("bad", kind === "bad");
}

function resize() {
  if (!renderer) return;
  const rect = refs.viewport.getBoundingClientRect();
  const w = rect.width || window.innerWidth;
  const h = rect.height || window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
