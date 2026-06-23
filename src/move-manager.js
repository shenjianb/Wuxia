import * as THREE from "three/webgpu";
import { createSafeRenderer } from "./renderer-utils.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createFacingMarker } from "./facing-marker.js";
import * as combatCollision from "./combat-collision-utils.js";
import {
  COMBAT_MOVE_DIRECTIONS,
  DEFAULT_HITSTUN_DURATION,
  createDefaultHitModelBinding,
  createDefaultHitWindow,
  findActionNameForAnimationFile,
  inferAnimationFileForActionName,
  normalizeCombatDirection,
  normalizeCombatMove,
  normalizeCombatMoveManager,
} from "./combat-move-manager.js";
import "./move-manager.css";

const ASSET_VERSION = "move-manager-20260619-visual";
const assetUrl = (path) => `${path}?v=${ASSET_VERSION}`;
const CHARACTER_HEIGHT = 2.2;
const PREVIEW_BASE_YAW = Math.PI;
const MODELS = [
  { id: "SK_BaseMale", label: "男主角", url: assetUrl("./assets/models/SK_BaseMale.glb") },
  { id: "SK_BaseFemale", label: "女主角", url: assetUrl("./assets/models/SK_BaseFemale.glb") },
];
const MODEL_IDS = new Set(MODELS.map((model) => model.id));
const loader = new GLTFLoader();
const clock = new THREE.Clock();
const scratch = new THREE.Vector3();
let renderer, scene, camera, controls, ground, grid, facingMarker, knockbackMarker;
let activeCharacter = null;
let activeAction = null;
let activeClip = null;
const animations = new Map();
const characters = new Map();
const bindingColliderSelectionCache = new WeakMap();
const editor = {
  manager: null,
  motionConfig: {},
  modelConfig: { version: 1, models: {} },
  animationFiles: [],
  actionOptions: [],
  selectedDirection: "forward",
  selectedMoveId: null,
  selectedHitWindowId: null,
  selectedModelId: MODELS[0].id,
  dirty: false,
  playing: true,
  time: 0,
  duration: 0,
  drag: null,
  directionDrag: false,
  showGround: true,
  showGrid: true,
  showSkeleton: false,
  showAttack: true,
};
const refs = {};
window.__MOVE_MANAGER_READY = false;
window.__MOVE_MANAGER_ERROR = null;
window.__MOVE_MANAGER_STATE = null;
boot();

async function boot() {
  mountUi(); bindUi();
  try {
    setStatus("加载配置...");
    editor.motionConfig = await loadMotionConfig();
    const [files, manager, modelConfig] = await Promise.all([loadAnimationAssetFiles(editor.motionConfig), loadCombatMoveManager(), loadModelConfig()]);
    editor.animationFiles = files;
    editor.actionOptions = buildActionOptions(files, editor.motionConfig);
    editor.modelConfig = combatCollision.normalizeRuntimeModelConfig(modelConfig, { characterHeight: CHARACTER_HEIGHT });
    editor.manager = normalizeCombatMoveManager(manager);
    ensureSelection();
    setStatus("初始化预览...");
    await initRenderer();
    await loadCharacters();
    selectModel(editor.selectedModelId, false);
    renderAll();
    await loadSelectedMovePreview();
    window.__MOVE_MANAGER_READY = true;
    document.body.dataset.ready = "true";
    setStatus("预览就绪", "saved");
    renderer.setAnimationLoop(update);
  } catch (error) {
    console.error(error);
    window.__MOVE_MANAGER_ERROR = error.message;
    setStatus(`初始化失败：${error.message}`, "bad");
  }
}
function mountUi() {
  const app = document.querySelector("#move-manager-app");
  app.innerHTML = `<div class="move-editor-shell"><aside class="move-rail"><div class="editor-brand"><strong>招式管理器</strong><span>move_manager.json</span></div><label class="compact-field">预览角色<select data-model-select></select></label><div class="direction-tabs" data-direction-tabs></div><button type="button" data-add-move>新增招式</button><div class="move-list" data-move-list></div><div class="manager-summary" data-summary></div></aside><main class="preview-column"><section class="preview-stage" data-viewport><div class="status-pill" data-status>准备中...</div><div class="preview-toggles"><button class="toggle-button active" type="button" data-toggle-ground>地面</button><button class="toggle-button active" type="button" data-toggle-grid>网格</button><button class="toggle-button" type="button" data-toggle-skeleton>骨骼</button><button class="toggle-button active" type="button" data-toggle-attack>攻击盒</button></div><div class="direction-dial" data-direction-dial><div class="direction-dial-ring"></div><div class="direction-dial-pointer" data-direction-pointer></div></div><div class="readout" data-readout></div></section><section class="timeline-panel"><div class="timeline-controls"><button type="button" data-play>暂停</button><button type="button" data-stop>归零</button><button type="button" data-add-hit-window>新增判定</button><div class="time-text" data-time>0.00 / 0.00s</div></div><div class="hit-timeline" data-timeline-track></div></section></main><aside class="property-panel"><div class="panel-head"><div class="panel-title"><h1 data-move-title>未选择招式</h1><span data-move-subtitle>攻击判定 / 受击配置</span></div><button class="save-button" type="button" data-save>保存</button></div><div class="field-scroll" data-fields></div></aside></div>`;
  ["modelSelect:model-select","tabs:direction-tabs","moveList:move-list","summary:summary","viewport:viewport","status:status","toggleGround:toggle-ground","toggleGrid:toggle-grid","toggleSkeleton:toggle-skeleton","toggleAttack:toggle-attack","directionDial:direction-dial","directionPointer:direction-pointer","readout:readout","play:play","stop:stop","addMove:add-move","addHitWindow:add-hit-window","save:save","timelineTrack:timeline-track","time:time","moveTitle:move-title","moveSubtitle:move-subtitle","fields:fields"].forEach((entry) => { const [key, data] = entry.split(":"); refs[key] = app.querySelector(`[data-${data}]`); });
}
function bindUi() {
  refs.addMove.addEventListener("click", addMove);
  refs.addHitWindow.addEventListener("click", () => addHitWindow(selectedMove()?.id));
  refs.save.addEventListener("click", saveCombatMoveManager);
  refs.modelSelect.addEventListener("change", () => selectModel(refs.modelSelect.value));
  refs.play.addEventListener("click", togglePlayback);
  refs.stop.addEventListener("click", stopPlayback);
  refs.toggleGround.addEventListener("click", () => toggleLayer("ground"));
  refs.toggleGrid.addEventListener("click", () => toggleLayer("grid"));
  refs.toggleSkeleton.addEventListener("click", () => toggleLayer("skeleton"));
  refs.toggleAttack.addEventListener("click", () => toggleLayer("attack"));
  refs.timelineTrack.addEventListener("pointerdown", onTimelineDown);
  refs.directionDial.addEventListener("pointerdown", onDirectionDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", () => { editor.drag = null; editor.directionDrag = false; });
  window.addEventListener("resize", resize);
  window.addEventListener("beforeunload", (event) => { if (!editor.dirty) return; event.preventDefault(); event.returnValue = ""; });
}
async function loadMotionConfig() { try { const r = await fetch("/api/motion-config", { cache: "no-store" }); if (r.ok) return r.json(); } catch {} const r = await fetch(assetUrl("./assets/animations/motion_config.json"), { cache: "no-store" }); if (!r.ok) throw new Error(`motion_config.json 加载失败：${r.status}`); return r.json(); }
async function loadAnimationAssetFiles(motionConfig) { try { const r = await fetch("/api/animation-assets", { cache: "no-store" }); if (r.ok) return (await r.json()).files || []; } catch {} return Object.keys(motionConfig).filter((name) => name.startsWith("combat_Att")).map((name) => inferAnimationFileForActionName(name, [], motionConfig)).filter(Boolean); }
async function loadCombatMoveManager() { try { const r = await fetch("/api/combat-move-manager", { cache: "no-store" }); if (r.ok) return r.json(); } catch {} const r = await fetch(assetUrl("./assets/combat/move_manager.json"), { cache: "no-store" }); if (!r.ok) throw new Error(`move_manager.json 加载失败：${r.status}`); return r.json(); }
async function loadModelConfig() { try { const r = await fetch("/api/model-config", { cache: "no-store" }); if (r.ok) return r.json(); } catch {} const r = await fetch(assetUrl("./assets/models/model_config.json"), { cache: "no-store" }); return r.ok ? r.json() : { models: {} }; }
function buildActionOptions(files, config) { const options = files.filter((file) => file?.toLowerCase().endsWith(".glb")).map((fileName) => ({ fileName, actionName: findActionNameForAnimationFile(fileName, config) })); Object.keys(config).forEach((actionName) => { if (actionName.startsWith("combat_Att") && !options.some((option) => option.actionName === actionName)) options.push({ actionName, fileName: inferAnimationFileForActionName(actionName, files, config) || `Anim_${actionName.charAt(0).toUpperCase()}${actionName.slice(1)}.glb` }); }); return options.filter((option) => option.actionName).sort((a, b) => a.actionName.localeCompare(b.actionName)); }
async function initRenderer() { renderer = await createSafeRenderer(THREE, { antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(refs.viewport.clientWidth, refs.viewport.clientHeight); refs.viewport.appendChild(renderer.domElement); scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a0d0f); camera = new THREE.PerspectiveCamera(42, 1, 0.05, 80); camera.position.set(3.4, 2.2, 4.2); controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, 1.05, 0); controls.enableDamping = true; scene.add(new THREE.HemisphereLight(0xf4efe6, 0x1a201b, 2.5)); const light = new THREE.DirectionalLight(0xffe1a8, 4.5); light.position.set(3, 5, 4); scene.add(light); grid = new THREE.GridHelper(8, 40, 0x5de5d9, 0x26362f); grid.material.transparent = true; grid.material.opacity = 0.36; scene.add(grid); ground = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshBasicMaterial({ color: 0x111610, transparent: true, opacity: 0.68, side: THREE.DoubleSide })); ground.rotation.x = -Math.PI / 2; scene.add(ground); facingMarker = createFacingMarker(THREE, { renderOrder: 12 }); scene.add(facingMarker); knockbackMarker = createKnockbackMarker(); scene.add(knockbackMarker); resize(); }
async function loadCharacters() { for (const model of MODELS) { const gltf = await loader.loadAsync(model.url); const root = new THREE.Group(); root.visible = false; root.add(gltf.scene); normalizeModel(gltf.scene); const skeletonOverlay = createSkeletonOverlay(gltf.scene); scene.add(skeletonOverlay.group); scene.add(root); characters.set(model.id, { model, modelConfigId: model.id, root, scene: gltf.scene, mixer: new THREE.AnimationMixer(gltf.scene), sceneRestRotationY: gltf.scene.rotation.y, skeletonOverlay, attackMeshes: [] }); } }
function normalizeModel(model) { const box = new THREE.Box3().setFromObject(model); const size = box.getSize(new THREE.Vector3()); model.scale.multiplyScalar(CHARACTER_HEIGHT / Math.max(size.y, 0.001)); const scaledBox = new THREE.Box3().setFromObject(model); const center = scaledBox.getCenter(new THREE.Vector3()); model.position.x -= center.x; model.position.z -= center.z; model.position.y -= scaledBox.min.y; }
function selectModel(modelId, render = true) { editor.selectedModelId = MODEL_IDS.has(modelId) ? modelId : MODELS[0].id; characters.forEach((character) => { const active = character.model.id === editor.selectedModelId; character.root.visible = active; if (character.skeletonOverlay) character.skeletonOverlay.group.visible = active && editor.showSkeleton; }); activeCharacter = characters.get(editor.selectedModelId) || null; refs.modelSelect.value = editor.selectedModelId; rebuildAttackMeshes(); if (render) applyPose(); }async function loadSelectedMovePreview() { const move = selectedMove(); if (!move || !activeCharacter || !move.actionName) return; setStatus("加载动作..."); const token = Date.now(); loadSelectedMovePreview.token = token; const clip = await loadClip(move.actionName, move.actionFile); if (loadSelectedMovePreview.token !== token) return; activeClip = clip; activeCharacter.mixer.stopAllAction(); activeAction = activeCharacter.mixer.clipAction(clip); preparePreviewAction(); editor.duration = Math.max(0, clip.duration || 0); editor.time = 0; editor.playing = true; rebuildAttackMeshes(); renderTimeline(); renderPropertyPanel(); applyPose(); updatePlayButton(); setStatus("预览就绪", editor.dirty ? "dirty" : "saved"); }
async function loadClip(actionName, explicitFile = "") { if (animations.has(actionName)) return animations.get(actionName); const option = editor.actionOptions.find((item) => item.actionName === actionName); const fileName = explicitFile || option?.fileName || inferAnimationFileForActionName(actionName, editor.animationFiles, editor.motionConfig); if (!fileName) throw new Error(`未找到动作文件：${actionName}`); const gltf = await loader.loadAsync(assetUrl(`./assets/animations/${fileName}`)); const clip = gltf.animations.length === 1 ? gltf.animations[0].clone() : new THREE.AnimationClip(actionName, -1, gltf.animations.flatMap((item) => item.tracks.map((track) => track.clone()))); clip.name = actionName; animations.set(actionName, clip); return clip; }
function renderAll() { renderModelSelect(); renderDirectionTabs(); renderMoveList(); renderSummary(); renderPropertyPanel(); renderTimeline(); updateToggles(); updatePlayButton(); updateDebugState(); }
function renderModelSelect() { refs.modelSelect.innerHTML = MODELS.map((model) => `<option value="${esc(model.id)}" ${model.id === editor.selectedModelId ? "selected" : ""}>${html(model.label)} · ${model.id}</option>`).join(""); }
function renderDirectionTabs() { refs.tabs.innerHTML = ""; COMBAT_MOVE_DIRECTIONS.forEach((direction) => { const moves = editor.manager?.directions?.[direction.id]?.moves || []; const button = document.createElement("button"); button.type = "button"; button.className = "direction-tab"; button.classList.toggle("active", editor.selectedDirection === direction.id); button.innerHTML = `<span>${html(direction.label)}</span><strong>${direction.key}</strong><small>${moves.length} 招</small>`; button.addEventListener("click", () => { editor.selectedDirection = direction.id; ensureSelection(true); renderAll(); loadSelectedMovePreview(); }); refs.tabs.appendChild(button); }); }
function renderMoveList() { refs.moveList.innerHTML = ""; const moves = currentMoves(); if (!moves.length) { refs.moveList.innerHTML = `<div class="empty-state">当前方向没有招式</div>`; return; } moves.forEach((move, index) => { const item = document.createElement("button"); item.type = "button"; item.className = "move-item"; item.classList.toggle("active", move.id === editor.selectedMoveId); item.innerHTML = `<span class="move-item-index">${index + 1}</span><span class="move-item-main"><b>${html(move.name)}</b><small>${html(move.actionName || "未绑定动作")}</small></span><span class="move-item-meta">${fmt(move.weight, 0)} 权重</span><span class="move-item-meta">${move.hitWindows?.length || 0} 段</span>`; item.addEventListener("click", () => selectMove(move.id)); refs.moveList.appendChild(item); }); }
function renderSummary() { refs.summary.innerHTML = COMBAT_MOVE_DIRECTIONS.map((direction) => { const moves = editor.manager?.directions?.[direction.id]?.moves || []; const weight = moves.reduce((sum, move) => sum + (Number(move.weight) || 0), 0); return `<div><span>${html(direction.label)}</span><strong>${moves.length} 招 / ${fmt(weight, 0)} 权重</strong></div>`; }).join(""); }
function renderPropertyPanel() { const move = selectedMove(); refs.fields.innerHTML = ""; if (!move) { refs.moveTitle.textContent = "未选择招式"; refs.moveSubtitle.textContent = "攻击判定 / 受击配置"; refs.fields.innerHTML = `<div class="empty-state panel-empty">从左侧选择或新增一个招式</div>`; return; } const direction = COMBAT_MOVE_DIRECTIONS.find((item) => item.id === move.triggerDirection) || COMBAT_MOVE_DIRECTIONS[0]; refs.moveTitle.textContent = move.name || move.id; refs.moveSubtitle.textContent = `${direction.label} · ${move.actionName || "未绑定动作"}`; refs.fields.append(group("招式基础", [textField("名称", move.name, (v) => updateMoveField(move.id, "name", v)), readonlyField("ID", move.id), selectField("触发方向", move.triggerDirection, COMBAT_MOVE_DIRECTIONS.map((item) => ({ value: item.id, label: `${item.label} (${item.key})` })), (v) => updateMoveField(move.id, "triggerDirection", v)), selectField("动作", move.actionName, actionOptions(move.actionName), (v) => updateMoveField(move.id, "actionName", v)), readonlyField("动作文件", move.actionFile || ""), numberField("权重", move.weight, 1, (v) => updateMoveField(move.id, "weight", v)), numberField("强度", move.strength, 0.05, (v) => updateMoveField(move.id, "strength", v)), checkField("可被阻挡", move.blockable !== false, (v) => updateMoveField(move.id, "blockable", v)), actionButton("删除招式", "danger-button", () => deleteMove(move.id))])); refs.fields.append(renderHitWindowGroup(move)); refs.fields.append(renderHitWindowDetail(move)); refs.fields.append(renderImpactGroup(move)); updateDirectionDial(); updateSaveButton(); }
function renderHitWindowGroup(move) { const children = []; const list = document.createElement("div"); list.className = "window-chip-list"; if (!move.hitWindows?.length) list.append(empty("尚未配置攻击判定区间")); else move.hitWindows.forEach((win, index) => { const button = document.createElement("button"); button.type = "button"; button.className = "window-chip"; button.classList.toggle("active", win.id === editor.selectedHitWindowId); button.innerHTML = `<b>${index + 1}</b><span>${html(win.name)}</span><small>${fmt(win.start)}-${fmt(win.end)}s</small>`; button.addEventListener("click", () => selectHitWindow(win.id)); list.append(button); }); children.push(list, actionButton("新增区间", "", () => addHitWindow(move.id))); return group("判定区间", children); }
function renderHitWindowDetail(move) { const win = selectedHitWindow(); if (!win) return group("选中判定", [empty("未选择判定区间")]); const children = [textField("名称", win.name, (v) => updateHitWindowField(move.id, win.id, "name", v)), numberField("开始秒", win.start, 0.01, (v) => updateHitWindowField(move.id, win.id, "start", v)), numberField("结束秒", win.end, 0.01, (v) => updateHitWindowField(move.id, win.id, "end", v)), actionButton("删除区间", "danger-button", () => deleteHitWindow(move.id, win.id)), renderBindings(move, win)]; if (editor.duration > 0 && win.end > editor.duration) children.splice(3, 0, warning(`区间结束 ${fmt(win.end)}s 超出动作时长 ${fmt(editor.duration)}s`)); return group("选中判定", children); }
function renderBindings(move, win) { const wrap = document.createElement("section"); wrap.className = "binding-section"; const head = document.createElement("div"); head.className = "binding-headline"; head.innerHTML = `<h3>攻击部位绑定</h3>`; const add = document.createElement("button"); add.type = "button"; add.textContent = "新增模型绑定"; add.addEventListener("click", () => addModelBinding(move.id, win.id)); head.append(add); wrap.append(head); if (!win.modelBindings?.length) { wrap.append(empty("此区间尚未绑定 attack 部位盒")); return wrap; } win.modelBindings.forEach((binding, index) => { const card = document.createElement("div"); card.className = "binding-card"; card.append(selectField("模型", binding.modelId, modelOptions(binding.modelId), (v) => updateModelBindingModel(move.id, win.id, index, v))); card.append(actionButton("删除绑定", "danger-button small", () => deleteModelBinding(move.id, win.id, index))); const chips = document.createElement("div"); chips.className = "collider-chip-list"; const model = editor.modelConfig.models?.[binding.modelId]; const allColliders = (model?.partColliders || []).filter((collider) => collider.enabled !== false); const colliders = combatCollision.getRuntimePartCollidersForChannel(model, "attack"); const hiddenCount = allColliders.length - colliders.length; if (hiddenCount > 0) chips.append(warning(`${hiddenCount} 个部位盒未勾选 attack 通道，已隐藏`)); if (!colliders.length) chips.append(empty("此模型没有 attack 通道部位盒")); const selected = new Set(binding.attackColliderIds || []); colliders.forEach((collider) => { const label = document.createElement("label"); label.className = "check-chip"; label.innerHTML = `<input type="checkbox" ${selected.has(collider.id) ? "checked" : ""}/><span>${html(collider.name || collider.id)}</span><small>${html(collider.bone || "")}</small>`; label.querySelector("input").addEventListener("change", (event) => updateModelBindingCollider(move.id, win.id, index, collider.id, event.target.checked)); chips.append(label); }); card.append(chips); wrap.append(card); }); return wrap; }
function renderImpactGroup(move) { return group("击退 / 受击", [checkField("自定义击退方向", !!move.impact?.knockback?.customDirection, (v) => updateImpact(move.id, "customDirection", v)), numberField("击退方向角度", move.impact?.knockback?.directionDegrees ?? 0, 1, (v) => updateImpact(move.id, "directionDegrees", v)), rangeField("方向拖拽同步", move.impact?.knockback?.directionDegrees ?? 0, -180, 180, 1, (v) => updateImpact(move.id, "directionDegrees", v)), checkField("进入受击僵直", !!move.impact?.hitstun?.enabled, (v) => updateImpact(move.id, "hitstunEnabled", v)), numberField("硬直时间（秒）", move.impact?.hitstun?.duration ?? DEFAULT_HITSTUN_DURATION, 0.05, (v) => updateImpact(move.id, "hitstunDuration", v)), selectField("受击动作", move.impact?.hitstun?.hitActionName || "", [{ value: "", label: "缺省：不播放动作" }, ...actionOptions(move.impact?.hitstun?.hitActionName || "")], (v) => updateImpact(move.id, "hitActionName", v))]); }
function group(title, children) { const section = document.createElement("section"); section.className = "field-group"; const h = document.createElement("h2"); h.textContent = title; section.append(h, ...children); return section; }
function textField(label, value, onInput) { const el = field(label, `<input type="text" value="${esc(value)}"/>`); el.querySelector("input").addEventListener("input", (e) => onInput(e.target.value)); return el; }
function readonlyField(label, value) { return field(label, `<input type="text" value="${esc(value)}" readonly/>`); }
function numberField(label, value, step, onChange) { const el = field(label, `<input type="number" min="0" step="${step}" value="${esc(value)}"/>`); el.querySelector("input").addEventListener("change", (e) => onChange(Number(e.target.value) || 0)); return el; }
function rangeField(label, value, min, max, step, onInput) { const el = field(label, `<input type="range" min="${min}" max="${max}" step="${step}" value="${esc(value)}"/>`); el.querySelector("input").addEventListener("input", (e) => onInput(Number(e.target.value) || 0)); return el; }
function checkField(label, checked, onChange) { const el = document.createElement("label"); el.className = "check-row"; el.innerHTML = `<span>${html(label)}</span><input type="checkbox" ${checked ? "checked" : ""}/>`; el.querySelector("input").addEventListener("change", (e) => onChange(e.target.checked)); return el; }
function selectField(label, value, options, onChange) { const el = field(label, `<select>${options.map((option) => `<option value="${esc(option.value)}" ${option.value === value ? "selected" : ""}>${html(option.label)}</option>`).join("")}</select>`); el.querySelector("select").addEventListener("change", (e) => onChange(e.target.value)); return el; }
function field(label, control) { const el = document.createElement("label"); el.className = "control-row"; el.innerHTML = `<span>${html(label)}</span>${control}`; return el; }
function actionButton(text, cls, onClick) { const row = document.createElement("div"); row.className = "inline-actions"; const button = document.createElement("button"); button.type = "button"; button.className = cls || ""; button.textContent = text; button.addEventListener("click", onClick); row.append(button); return row; }
function empty(text) { const el = document.createElement("div"); el.className = "empty-state tiny"; el.textContent = text; return el; }
function warning(text) { const el = document.createElement("div"); el.className = "field-warning"; el.textContent = text; return el; }
function actionOptions(selected) { const has = !selected || editor.actionOptions.some((option) => option.actionName === selected); return (has ? editor.actionOptions : [{ actionName: selected, fileName: "动作文件列表未找到" }, ...editor.actionOptions]).map((option) => ({ value: option.actionName, label: `${option.actionName} · ${option.fileName}` })); }
function modelOptions(selected) { const options = Object.entries(editor.modelConfig.models || {}).map(([id, config]) => ({ value: id, label: `${config.label || id} · ${id}` })); if (selected && !options.some((item) => item.value === selected)) options.unshift({ value: selected, label: `已保存：${selected}` }); return options.length ? options : [{ value: "", label: "未加载模型配置" }]; }function renderTimeline() { refs.timelineTrack.innerHTML = ""; const duration = Math.max(editor.duration, 0.001); (selectedMove()?.hitWindows || []).forEach((win, index) => { const start = editor.duration > 0 ? Math.max(0, win.start) / duration : 0; const end = editor.duration > 0 ? Math.max(win.start, win.end) / duration : 0; const block = document.createElement("div"); block.className = "timeline-window"; block.classList.toggle("active", win.id === editor.selectedHitWindowId); block.classList.toggle("overrun", editor.duration > 0 && win.end > editor.duration); block.dataset.windowId = win.id; block.style.left = `${Math.min(start, 1) * 100}%`; block.style.width = `${Math.max(0.6, (Math.min(end, 1) - Math.min(start, 1)) * 100)}%`; block.innerHTML = `<span class="timeline-handle left" data-handle="start"></span><b>${index + 1}</b><span class="timeline-window-name">${html(win.name)}</span><span class="timeline-handle right" data-handle="end"></span>`; refs.timelineTrack.append(block); }); const playhead = document.createElement("div"); playhead.className = "timeline-playhead"; playhead.dataset.playhead = "true"; refs.timelineTrack.append(playhead); updateTimelineUi(); }
function updateTimelineUi() { const duration = Math.max(editor.duration, 0.001); const playhead = refs.timelineTrack?.querySelector("[data-playhead]"); if (playhead) playhead.style.left = `${THREE.MathUtils.clamp(editor.time / duration, 0, 1) * 100}%`; refs.time.textContent = `${fmt(editor.time)} / ${fmt(editor.duration)}s`; updateDebugState(); }
function onTimelineDown(event) { if (!selectedMove() || editor.duration <= 0) return; const block = event.target.closest("[data-window-id]"); const rect = refs.timelineTrack.getBoundingClientRect(); if (!block) { editor.drag = { type: "scrub", rect }; scrubTimeline(event); return; } const win = selectedMove().hitWindows.find((item) => item.id === block.dataset.windowId); if (!win) return; editor.selectedHitWindowId = win.id; editor.drag = { type: event.target.dataset.handle || "move", windowId: win.id, rect, startX: event.clientX, start: win.start, end: win.end }; renderAll(); event.preventDefault(); }
function onPointerMove(event) { if (editor.drag) dragTimeline(event); if (editor.directionDrag) updateDirectionFromPointer(event); }
function scrubTimeline(event) { const ratio = THREE.MathUtils.clamp((event.clientX - editor.drag.rect.left) / Math.max(1, editor.drag.rect.width), 0, 1); editor.time = ratio * editor.duration; editor.playing = false; applyPose(); updatePlayButton(); }
function dragTimeline(event) { const drag = editor.drag; if (drag.type === "scrub") { scrubTimeline(event); return; } const win = selectedMove()?.hitWindows?.find((item) => item.id === drag.windowId); if (!win) return; const delta = ((event.clientX - drag.startX) / Math.max(1, drag.rect.width)) * editor.duration; const length = Math.max(0, drag.end - drag.start); if (drag.type === "start") win.start = THREE.MathUtils.clamp(drag.start + delta, 0, Math.min(win.end, editor.duration)); else if (drag.type === "end") win.end = THREE.MathUtils.clamp(drag.end + delta, win.start, editor.duration); else { win.start = THREE.MathUtils.clamp(drag.start + delta, 0, Math.max(0, editor.duration - length)); win.end = win.start + length; } markDirty(false); renderTimeline(); renderPropertyPanel(); rebuildAttackMeshes(); applyPose(); }
function onDirectionDown(event) { const move = selectedMove(); if (!move) return; ensureImpact(move); move.impact.knockback.customDirection = true; editor.directionDrag = true; updateDirectionFromPointer(event); event.preventDefault(); }
function updateDirectionFromPointer(event) { const move = selectedMove(); if (!move) return; const rect = refs.directionDial.getBoundingClientRect(); const deg = THREE.MathUtils.radToDeg(Math.atan2(event.clientX - (rect.left + rect.width / 2), -(event.clientY - (rect.top + rect.height / 2)))); updateImpact(move.id, "directionDegrees", Math.round(deg), false); updateDirectionDial(); updateKnockbackMarker(); }
function updateDirectionDial() { const move = selectedMove(); const custom = !!move?.impact?.knockback?.customDirection; const degrees = Number(move?.impact?.knockback?.directionDegrees) || 0; refs.directionDial.classList.toggle("active", custom); refs.directionPointer.style.transform = `translate(-50%, -100%) rotate(${degrees}deg)`; }
function selectMove(moveId) { const move = findMove(moveId); if (!move) return; editor.selectedMoveId = move.id; editor.selectedDirection = move.triggerDirection; editor.selectedHitWindowId = move.hitWindows?.[0]?.id || null; editor.time = 0; renderAll(); loadSelectedMovePreview(); }
function selectHitWindow(id) { editor.selectedHitWindowId = id; renderPropertyPanel(); renderTimeline(); rebuildAttackMeshes(); applyPose(); }
function ensureSelection(preferCurrentDirection = false) { const current = selectedMove(); if (current && (!preferCurrentDirection || current.triggerDirection === editor.selectedDirection)) { if (!current.hitWindows?.some((win) => win.id === editor.selectedHitWindowId)) editor.selectedHitWindowId = current.hitWindows?.[0]?.id || null; return; } const first = currentMoves()[0] || allMoves()[0] || null; editor.selectedMoveId = first?.id || null; editor.selectedHitWindowId = first?.hitWindows?.[0]?.id || null; if (!preferCurrentDirection && first) editor.selectedDirection = first.triggerDirection; }
function addMove() { const direction = editor.selectedDirection; const option = editor.actionOptions.find((item) => item.actionName.includes("combat_Att")) || editor.actionOptions[0]; const move = normalizeCombatMove({ id: `move-${direction}-${Date.now().toString(36)}`, name: "新招式", triggerDirection: direction, actionFile: option?.fileName || "", actionName: option?.actionName || "", weight: 10, strength: 1 }, direction); editor.manager.directions[direction].moves.push(move); editor.selectedMoveId = move.id; editor.selectedHitWindowId = null; markDirty(); loadSelectedMovePreview(); }
function deleteMove(id) { COMBAT_MOVE_DIRECTIONS.forEach((direction) => { const list = editor.manager.directions[direction.id].moves; const index = list.findIndex((move) => move.id === id); if (index >= 0) list.splice(index, 1); }); ensureSelection(true); markDirty(); loadSelectedMovePreview(); }
function updateMoveField(id, field, value) { const move = findMove(id); if (!move) return; if (field === "name") move.name = value; else if (field === "triggerDirection") { const next = normalizeCombatDirection(value); move.triggerDirection = next; COMBAT_MOVE_DIRECTIONS.forEach((direction) => { const list = editor.manager.directions[direction.id].moves; const index = list.findIndex((item) => item.id === move.id); if (index >= 0) list.splice(index, 1); }); editor.manager.directions[next].moves.push(move); editor.selectedDirection = next; } else if (field === "actionName") { move.actionName = value; const option = editor.actionOptions.find((item) => item.actionName === value); move.actionFile = option?.fileName || inferAnimationFileForActionName(value, editor.animationFiles, editor.motionConfig) || move.actionFile || ""; editor.time = 0; markDirty(); loadSelectedMovePreview(); return; } else if (field === "weight") move.weight = Math.max(0, Number(value) || 0); else if (field === "strength") move.strength = Math.max(0, Number(value) || 0); else if (field === "blockable") move.blockable = value !== false; markDirty(); }
function addHitWindow(moveId) { const move = findMove(moveId); if (!move) return; const win = createDefaultHitWindow(); const start = editor.duration > 0 ? THREE.MathUtils.clamp(editor.time, 0, Math.max(0, editor.duration - 0.05)) : 0; win.start = Number(start.toFixed(2)); win.end = Number((editor.duration > 0 ? Math.min(editor.duration, start + 0.2) : start + 0.2).toFixed(2)); move.hitWindows = move.hitWindows || []; move.hitWindows.push(win); editor.selectedHitWindowId = win.id; markDirty(); rebuildAttackMeshes(); }
function deleteHitWindow(moveId, winId) { const move = findMove(moveId); if (!move) return; move.hitWindows = (move.hitWindows || []).filter((win) => win.id !== winId); editor.selectedHitWindowId = move.hitWindows?.[0]?.id || null; markDirty(); rebuildAttackMeshes(); }
function updateHitWindowField(moveId, winId, field, value) { const win = findHitWindow(moveId, winId); if (!win) return; if (field === "name") win.name = value; if (field === "start") win.start = clampTime(Number(value) || 0); if (field === "end") win.end = clampTime(Number(value) || 0); if (win.end < win.start) win.end = win.start; markDirty(); rebuildAttackMeshes(); }
function getNextUnboundModelId(win) { const used = new Set((win?.modelBindings || []).map((binding) => binding.modelId).filter(Boolean)); if (editor.selectedModelId && !used.has(editor.selectedModelId)) return editor.selectedModelId; return Object.keys(editor.modelConfig.models || {}).find((modelId) => !used.has(modelId)) || editor.selectedModelId || ""; }
function addModelBinding(moveId, winId) { const win = findHitWindow(moveId, winId); if (!win) return; win.modelBindings = win.modelBindings || []; const modelId = getNextUnboundModelId(win); if (!modelId || win.modelBindings.some((binding) => binding.modelId === modelId)) { setStatus("该判定区间已绑定全部模型", editor.dirty ? "dirty" : "saved"); return; } win.modelBindings.push(createDefaultHitModelBinding(modelId)); markDirty(); rebuildAttackMeshes(); }
function deleteModelBinding(moveId, winId, index) { const win = findHitWindow(moveId, winId); if (!win) return; win.modelBindings.splice(index, 1); markDirty(); rebuildAttackMeshes(); }
function cacheModelBindingColliderSelection(binding) { if (!binding) return; const modelId = binding.modelId || ""; let cache = bindingColliderSelectionCache.get(binding); if (!cache) { cache = new Map(); bindingColliderSelectionCache.set(binding, cache); } cache.set(modelId, [...(binding.attackColliderIds || [])]); }
function getModelBindingColliderSelection(win, binding, modelId) { const cache = bindingColliderSelectionCache.get(binding); if (cache?.has(modelId)) return [...cache.get(modelId)]; const existing = win?.modelBindings?.find((item) => item !== binding && item.modelId === modelId && Array.isArray(item.attackColliderIds)); return existing ? [...existing.attackColliderIds] : []; }
function updateModelBindingModel(moveId, winId, index, modelId) { const win = findHitWindow(moveId, winId); const binding = win?.modelBindings?.[index]; if (!binding || binding.modelId === modelId) return; cacheModelBindingColliderSelection(binding); const existingIndex = (win.modelBindings || []).findIndex((item, itemIndex) => itemIndex !== index && item.modelId === modelId); if (existingIndex >= 0) { if (!(binding.attackColliderIds || []).length) win.modelBindings.splice(index, 1); markDirty(); rebuildAttackMeshes(); return; } if ((binding.attackColliderIds || []).length) { const next = createDefaultHitModelBinding(modelId); next.attackColliderIds = getModelBindingColliderSelection(win, next, modelId); win.modelBindings.splice(index + 1, 0, next); } else { binding.modelId = modelId; binding.attackColliderIds = getModelBindingColliderSelection(win, binding, modelId); cacheModelBindingColliderSelection(binding); } markDirty(); rebuildAttackMeshes(); }
function updateModelBindingCollider(moveId, winId, index, colliderId, enabled) { const binding = findModelBinding(moveId, winId, index); if (!binding) return; const ids = new Set(binding.attackColliderIds || []); if (enabled) ids.add(colliderId); else ids.delete(colliderId); binding.attackColliderIds = [...ids]; cacheModelBindingColliderSelection(binding); markDirty(); rebuildAttackMeshes(); }
function updateImpact(moveId, field, value, rerender = true) { const move = findMove(moveId); if (!move) return; ensureImpact(move); if (field === "customDirection") move.impact.knockback.customDirection = !!value; if (field === "directionDegrees") move.impact.knockback.directionDegrees = normalizeDegrees(Number(value) || 0); if (field === "hitstunEnabled") move.impact.hitstun.enabled = !!value; if (field === "hitstunDuration") move.impact.hitstun.duration = Math.max(0, Number(value) || 0); if (field === "hitActionName") move.impact.hitstun.hitActionName = String(value || ""); markDirty(rerender); updateDirectionDial(); updateKnockbackMarker(); }
function ensureImpact(move) { move.impact = move.impact || { knockback: {}, hitstun: {} }; move.impact.knockback = move.impact.knockback || {}; move.impact.hitstun = move.impact.hitstun || {}; if (!Number.isFinite(Number(move.impact.hitstun.duration))) move.impact.hitstun.duration = DEFAULT_HITSTUN_DURATION; }
function normalizeDegrees(value) { let next = value; while (next > 180) next -= 360; while (next < -180) next += 360; return Math.round(next); }
function clampTime(value) { const positive = Math.max(0, value); return editor.duration > 0 ? Math.min(editor.duration, positive) : positive; }
async function saveCombatMoveManager() { try { setStatus("保存中..."); editor.manager = normalizeCombatMoveManager(editor.manager); const moveId = editor.selectedMoveId; const winId = editor.selectedHitWindowId; const response = await fetch("/api/combat-move-manager", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editor.manager) }); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `${response.status} ${response.statusText}`); editor.selectedMoveId = moveId; editor.selectedHitWindowId = winId; editor.dirty = false; ensureSelection(); renderAll(); setStatus("已保存到 move_manager.json", "saved"); } catch (error) { console.error(error); setStatus(`保存失败：${error.message}`, "bad"); } }
function markDirty(render = true) { editor.dirty = true; setStatus("未保存", "dirty"); updateSaveButton(); if (render) renderAll(); }
function setStatus(text, kind = "") { refs.status.textContent = text; refs.status.classList.toggle("bad", kind === "bad"); refs.status.classList.toggle("saved", kind === "saved"); refs.status.classList.toggle("dirty", kind === "dirty"); }
function updateSaveButton() { refs.save.classList.toggle("dirty", editor.dirty); refs.save.textContent = editor.dirty ? "保存*" : "保存"; }
function previewShouldLoop() { return true; }
function preparePreviewAction() { if (!activeAction) return; activeAction.enabled = true; activeAction.paused = false; activeAction.timeScale = 1; activeAction.setLoop(previewShouldLoop() ? THREE.LoopRepeat : THREE.LoopOnce, previewShouldLoop() ? Infinity : 1); activeAction.clampWhenFinished = !previewShouldLoop(); activeAction.reset().play(); }
function togglePlayback() { editor.playing = !editor.playing; if (activeAction) { activeAction.enabled = true; activeAction.paused = false; if (!activeAction.isRunning()) activeAction.play(); if (editor.playing && editor.duration > 0 && editor.time >= editor.duration - 0.001) editor.time = 0; } updatePlayButton(); applyPose(); }
function stopPlayback() { editor.playing = false; editor.time = 0; if (activeAction) { activeAction.enabled = true; activeAction.paused = false; if (!activeAction.isRunning()) activeAction.play(); } applyPose(); updatePlayButton(); }
function updatePlayButton() { refs.play.textContent = editor.playing ? "暂停" : "播放"; }
function toggleLayer(layer) { if (layer === "ground") editor.showGround = !editor.showGround; if (layer === "grid") editor.showGrid = !editor.showGrid; if (layer === "skeleton") editor.showSkeleton = !editor.showSkeleton; if (layer === "attack") editor.showAttack = !editor.showAttack; updateToggles(); applyPose(); }
function updateToggles() { refs.toggleGround.classList.toggle("active", editor.showGround); refs.toggleGrid.classList.toggle("active", editor.showGrid); refs.toggleSkeleton.classList.toggle("active", editor.showSkeleton); refs.toggleAttack.classList.toggle("active", editor.showAttack); if (ground) ground.visible = editor.showGround; if (grid) grid.visible = editor.showGrid; characters.forEach((character) => { if (character.skeletonOverlay) character.skeletonOverlay.group.visible = character === activeCharacter && editor.showSkeleton; }); if (activeCharacter && editor.showSkeleton) updateSkeletonOverlay(activeCharacter); }
function update() { const delta = Math.min(clock.getDelta(), 0.05); controls?.update(); if (editor.playing && activeAction && editor.duration > 0) { editor.time += delta; const loop = previewShouldLoop(); if (!loop && editor.time >= editor.duration) { editor.time = editor.duration; editor.playing = false; updatePlayButton(); } else editor.time = normalizeTime(editor.time); applyPose(); } if (renderer && scene && camera) renderer.render(scene, camera); }
function resize() { if (!renderer || !camera) return; const w = Math.max(1, refs.viewport.clientWidth); const h = Math.max(1, refs.viewport.clientHeight); renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }
function applyPose() { if (!activeCharacter || !activeAction) { updateTimelineUi(); updateReadout(); return; } activeAction.enabled = true; activeAction.paused = false; if (!activeAction.isRunning()) activeAction.play(); activeCharacter.root.position.set(0, 0, 0); activeCharacter.root.rotation.set(0, PREVIEW_BASE_YAW, 0); activeCharacter.scene.rotation.y = activeCharacter.sceneRestRotationY + THREE.MathUtils.degToRad(currentConfig().visualYawOffsetDegrees ?? 0); activeCharacter.mixer.setTime(normalizeTime(editor.time)); activeCharacter.root.updateMatrixWorld(true); updateSkeletonOverlay(activeCharacter); updateToggles(); updateFacingMarker(); updateKnockbackMarker(); updateAttackVisibility(); updateTimelineUi(); updateReadout(); }
function updateFacingMarker() { activeCharacter.root.getWorldPosition(scratch); facingMarker.position.set(scratch.x, 0.07, scratch.z); facingMarker.rotation.set(0, activeCharacter.root.rotation.y, 0); facingMarker.visible = true; }
function createKnockbackMarker() { const group = new THREE.Group(); const material = new THREE.MeshBasicMaterial({ color: 0x26c6ff, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }); const shape = new THREE.Shape(); shape.moveTo(0, 1.1); shape.lineTo(0.22, 0.7); shape.lineTo(0.07, 0.74); shape.lineTo(0.07, -0.12); shape.lineTo(-0.07, -0.12); shape.lineTo(-0.07, 0.74); shape.lineTo(-0.22, 0.7); shape.lineTo(0, 1.1); const arrow = new THREE.Mesh(new THREE.ShapeGeometry(shape), material); arrow.rotation.x = Math.PI / 2; arrow.scale.setScalar(0.65); arrow.renderOrder = 13; group.add(arrow); group.userData.material = material; return group; }
function updateKnockbackMarker() { const move = selectedMove(); if (!move || !activeCharacter) return; activeCharacter.root.getWorldPosition(scratch); knockbackMarker.position.set(scratch.x, 0.1, scratch.z); const degrees = move.impact?.knockback?.customDirection ? Number(move.impact.knockback.directionDegrees) || 0 : 0; knockbackMarker.rotation.set(0, activeCharacter.root.rotation.y + THREE.MathUtils.degToRad(degrees), 0); knockbackMarker.visible = true; knockbackMarker.userData.material.opacity = move.impact?.knockback?.customDirection ? 0.9 : 0.34; }
function rebuildAttackMeshes() { characters.forEach(clearAttackMeshes); if (!activeCharacter || !editor.showAttack) return; const model = editor.modelConfig.models?.[activeCharacter.modelConfigId]; const colliders = combatCollision.getAttackCollidersForHitWindow(model, activeCharacter.modelConfigId, selectedHitWindow()); activeCharacter.attackMeshes = colliders.map((collider) => makeAttackMesh(activeCharacter, collider)).filter(Boolean); updateAttackVisibility(); }
function clearAttackMeshes(character) { character.attackMeshes?.forEach((mesh) => { if (mesh.parent) mesh.parent.remove(mesh); mesh.geometry?.dispose?.(); mesh.material?.dispose?.(); }); character.attackMeshes = []; }
function makeAttackMesh(character, collider) { const bone = character.scene.getObjectByName(collider.bone); if (!bone) return null; const box = new THREE.BoxGeometry(...collider.size); const edges = new THREE.EdgesGeometry(box); box.dispose(); const mesh = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x20b8ff, transparent: true, opacity: 0.9, depthTest: false })); mesh.position.fromArray(collider.offset); mesh.rotation.set(...collider.rotationDegrees.map((deg) => THREE.MathUtils.degToRad(deg))); mesh.renderOrder = 18; bone.add(mesh); return mesh; }
function updateAttackVisibility() { const active = isWindowActive(); characters.forEach((character) => character.attackMeshes?.forEach((mesh) => { mesh.visible = character === activeCharacter && editor.showAttack; mesh.material.color.setHex(active ? 0xff3048 : 0x20b8ff); mesh.material.opacity = active ? 1 : 0.72; })); }
function isWindowActive() { const win = selectedHitWindow(); return !!win && editor.time >= win.start && editor.time <= win.end; }
function updateReadout() { const move = selectedMove(); const win = selectedHitWindow(); const model = activeCharacter ? editor.modelConfig.models?.[activeCharacter.modelConfigId] : null; const count = combatCollision.getAttackCollidersForHitWindow(model, activeCharacter?.modelConfigId, win).length; refs.readout.innerHTML = move ? `<div><span>Action</span><b>${html(move.actionName || "-")}</b></div><div><span>Duration</span><b>${fmt(editor.duration)}s</b></div><div><span>Mode</span><b>${html(currentConfig().motionMode || "InPlace")}</b></div><div><span>Window</span><b>${win ? `${fmt(win.start)}-${fmt(win.end)}s` : "-"}</b></div><div><span>Attack Boxes</span><b>${count}</b></div><div><span>Strength</span><b>${fmt(move.strength)}</b></div>` : ""; }
function currentConfig() { return { motionMode: "InPlace", loop: false, ...(editor.motionConfig[selectedMove()?.actionName] || {}) }; }
function normalizeTime(time) { if (!editor.duration) return 0; if (!previewShouldLoop()) return THREE.MathUtils.clamp(time, 0, editor.duration); return ((time % editor.duration) + editor.duration) % editor.duration; }
function createSkeletonOverlay(model) {
  const bones = [];
  model.traverse((obj) => {
    if (obj.isBone || obj.type === "Bone") bones.push(obj);
  });
  const boneSet = new Set(bones);
  const edges = bones.filter((bone) => bone.parent && boneSet.has(bone.parent)).map((bone) => ({ parent: bone.parent, child: bone }));
  const group = new THREE.Group();
  group.name = "SkeletonOverlay";
  group.visible = false;
  const linePositions = new Float32Array(Math.max(edges.length * 2 * 3, 6));
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
  lineGeometry.setDrawRange(0, edges.length * 2);
  const line = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: 0xd7fff2, transparent: true, opacity: 0.88, depthTest: false }));
  line.renderOrder = 10;
  group.add(line);
  const jointGeometry = new THREE.SphereGeometry(0.028, 10, 8);
  const rootGeometry = new THREE.SphereGeometry(0.075, 16, 12);
  const jointMaterial = new THREE.MeshBasicMaterial({ color: 0x88e7ff, transparent: true, opacity: 0.88, depthTest: false });
  const rootMaterial = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 1, depthTest: false });
  const joints = bones.map((bone) => {
    const isRoot = bone.name === "Root";
    const joint = new THREE.Mesh(isRoot ? rootGeometry : jointGeometry, isRoot ? rootMaterial : jointMaterial);
    joint.name = isRoot ? "SkeletonRootJoint" : `SkeletonJoint_${bone.name}`;
    joint.renderOrder = isRoot ? 12 : 11;
    joint.userData.bone = bone;
    group.add(joint);
    return joint;
  });
  return { group, bones, edges, line, linePositions, joints };
}
function updateSkeletonOverlay(character) {
  if (!character?.skeletonOverlay) return;
  const overlay = character.skeletonOverlay;
  overlay.group.visible = character === activeCharacter && editor.showSkeleton;
  if (!overlay.group.visible) return;
  character.root.updateMatrixWorld(true);
  const parentPos = new THREE.Vector3();
  const childPos = new THREE.Vector3();
  overlay.edges.forEach((edge, index) => {
    edge.parent.getWorldPosition(parentPos);
    edge.child.getWorldPosition(childPos);
    const offset = index * 6;
    overlay.linePositions[offset] = parentPos.x;
    overlay.linePositions[offset + 1] = parentPos.y;
    overlay.linePositions[offset + 2] = parentPos.z;
    overlay.linePositions[offset + 3] = childPos.x;
    overlay.linePositions[offset + 4] = childPos.y;
    overlay.linePositions[offset + 5] = childPos.z;
  });
  overlay.line.geometry.attributes.position.needsUpdate = true;
  overlay.line.geometry.computeBoundingSphere();
  overlay.joints.forEach((joint) => {
    joint.userData.bone.getWorldPosition(joint.position);
  });
}
function currentMoves() { return editor.manager?.directions?.[editor.selectedDirection]?.moves || []; }
function allMoves() { return COMBAT_MOVE_DIRECTIONS.flatMap((direction) => editor.manager?.directions?.[direction.id]?.moves || []); }
function selectedMove() { return findMove(editor.selectedMoveId); }
function selectedHitWindow() { return selectedMove()?.hitWindows?.find((win) => win.id === editor.selectedHitWindowId) || null; }
function findMove(id) { for (const direction of COMBAT_MOVE_DIRECTIONS) { const move = editor.manager?.directions?.[direction.id]?.moves.find((item) => item.id === id); if (move) return move; } return null; }
function findHitWindow(moveId, winId) { return findMove(moveId)?.hitWindows?.find((win) => win.id === winId) || null; }
function findModelBinding(moveId, winId, index) { return findHitWindow(moveId, winId)?.modelBindings?.[index] || null; }
function fmt(value, digits = 2) { const number = Number(value); return Number.isFinite(number) ? number.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1") : "0"; }
function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function html(value) { return esc(value); }
function updateDebugState() { window.__MOVE_MANAGER_STATE = { selectedDirection: editor.selectedDirection, selectedMoveId: editor.selectedMoveId, selectedHitWindowId: editor.selectedHitWindowId, selectedModelId: editor.selectedModelId, time: editor.time, duration: editor.duration, dirty: editor.dirty, ready: window.__MOVE_MANAGER_READY, currentAction: selectedMove()?.actionName || null, currentMotionMode: currentConfig().motionMode || "InPlace", attackColliderCount: activeCharacter?.attackMeshes?.length || 0 }; }
