import {
  BEHAVIOR_NODE_TYPES,
  TRANSITION_CONDITION_TYPES,
  BRAIN_INPUT_ATTRIBUTES,
  BRAIN_OPERATORS,
  BRAIN_OUTPUT_TYPES,
} from "./character-attributes.js";
import "./behavior-editor.css";

const ENTRY_NODE_ID = "entry";

let uidCounter = 0;
function uid(prefix) {
  uidCounter++;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}`;
}

function getDefaultBehaviorTree(id, name) {
  return {
    id,
    name: name || id,
    version: 1,
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    normalState: { nodes: [], transitions: [] },
    combatState: { nodes: [], transitions: [] },
    brain: { rules: [] },
  };
}

const editor = {
  currentTreeId: null,
  dirty: false,
  behaviorTree: null,
  activeTree: "normal",
  selectedNodeId: null,
  selectedTransitionId: null,
  selectedBrainRuleId: null,
  expandedBrainRuleId: null,
  activeTab: "node",
  canvasOffset: { x: 100, y: 60 },
  canvasScale: 1,
  dragState: null,
  treeList: [],
};

const refs = {};

window.__BEHAVIOR_EDITOR_READY = false;
window.__BEHAVIOR_EDITOR_ERROR = null;

boot();

async function boot() {
  mountUI();
  bindUI();

  const params = new URLSearchParams(window.location.search);
  const autoTreeId = params.get("treeId");
  try {
    await loadTreeList(autoTreeId);
    window.__BEHAVIOR_EDITOR_READY = true;
  } catch (error) {
    console.error(error);
    window.__BEHAVIOR_EDITOR_ERROR = error.message;
    setStatus(`初始化失败: ${error.message}`, "bad");
  }
}

// ========= MOUNT UI =========
function mountUI() {
  const app = document.querySelector("#behavior-editor-app");
  app.innerHTML = `
    <div class="editor-shell">
      <aside class="behavior-rail">
        <div class="editor-brand">
          <strong>行为树编辑器</strong>
          <span>Behavior Tree Editor</span>
        </div>
        <div class="new-npc-row">
          <input data-new-tree-name type="text" placeholder="新建行为树名称..." />
          <button data-new-tree-btn type="button">新建</button>
        </div>
        <div class="section-header"><span>行为树配置列表</span></div>
        <div class="npc-list" data-tree-list></div>
      </aside>

      <main class="graph-column">
        <div class="graph-toolbar">
          <button class="tab-btn active" data-tab="normal" type="button">默认行为</button>
          <button class="tab-btn" data-tab="combat" type="button">战斗行为</button>
          <div class="spacer"></div>
          <span class="zoom-info" data-zoom-info>100%</span>
        </div>
        <div class="graph-canvas" data-graph-canvas>
          <div class="status-pill" data-status>选择或创建行为树开始编辑</div>
          <svg data-svg-layer></svg>
          <div class="graph-nodes" data-graph-nodes></div>
        </div>
        <div class="graph-footer">
          <span>右键画布: 添加节点 | 拖拽端口: 创建连线 | 滚轮: 缩放 | 中键拖拽: 平移</span>
        </div>
      </main>

      <aside class="property-panel">
        <div class="panel-head">
          <div class="panel-title">
            <h1 data-panel-title>属性面板</h1>
            <span data-panel-subtitle></span>
          </div>
          <button class="save-button" data-btn-save type="button">保存</button>
        </div>
        <div class="panel-tabs">
          <button class="panel-tab active" data-panel-tab="node" type="button">节点</button>
          <button class="panel-tab" data-panel-tab="transition" type="button">跳转</button>
          <button class="panel-tab" data-panel-tab="brain" type="button">大脑规则</button>
        </div>
        <div class="field-scroll" data-field-scroll></div>
      </aside>
    </div>`;

  refs.treeList = app.querySelector("[data-tree-list]");
  refs.status = app.querySelector("[data-status]");
  refs.graphCanvas = app.querySelector("[data-graph-canvas]");
  refs.svgLayer = app.querySelector("[data-svg-layer]");
  refs.graphNodes = app.querySelector("[data-graph-nodes]");
  refs.zoomInfo = app.querySelector("[data-zoom-info]");
  refs.panelTitle = app.querySelector("[data-panel-title]");
  refs.panelSubtitle = app.querySelector("[data-panel-subtitle]");
  refs.fieldScroll = app.querySelector("[data-field-scroll]");
  refs.btnSave = app.querySelector("[data-btn-save]");
  refs.tabBtns = app.querySelectorAll("[data-tab]");
  refs.panelTabs = app.querySelectorAll("[data-panel-tab]");
  refs.newTreeName = app.querySelector("[data-new-tree-name]");
  refs.newTreeBtn = app.querySelector("[data-new-tree-btn]");
}

// ========= BIND UI =========
function bindUI() {
  refs.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      editor.activeTree = btn.dataset.tab;
      editor.selectedNodeId = null;
      editor.selectedTransitionId = null;
      refs.tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === editor.activeTree));
      renderGraph();
      renderPropertyPanel();
    });
  });

  refs.panelTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      editor.activeTab = btn.dataset.panelTab;
      if (btn.dataset.panelTab === "node") {
        editor.selectedTransitionId = null;
        editor.selectedBrainRuleId = null;
      } else if (btn.dataset.panelTab === "transition") {
        editor.selectedNodeId = null;
        editor.selectedBrainRuleId = null;
      } else if (btn.dataset.panelTab === "brain") {
        editor.selectedNodeId = null;
        editor.selectedTransitionId = null;
      }
      refs.panelTabs.forEach((b) => b.classList.toggle("active", b.dataset.panelTab === editor.activeTab));
      renderGraph();
      renderPropertyPanel();
    });
  });

  refs.btnSave.addEventListener("click", () => saveBehaviorTree());

  refs.newTreeBtn.addEventListener("click", () => createTree());
  refs.newTreeName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createTree();
  });

  const canvas = refs.graphCanvas;
  canvas.addEventListener("mousedown", onCanvasMouseDown);
  canvas.addEventListener("mousemove", onCanvasMouseMove);
  canvas.addEventListener("mouseup", onCanvasMouseUp);
  canvas.addEventListener("wheel", onCanvasWheel, { passive: false });
  canvas.addEventListener("contextmenu", onCanvasContextMenu);

  document.addEventListener("mousemove", onDocumentMouseMove);
  document.addEventListener("mouseup", onDocumentMouseUp);
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeyDown);
}

// ========= TREE LIST =========
async function loadTreeList(autoSelectId) {
  try {
    const resp = await fetch("/api/behavior-trees");
    if (!resp.ok) throw new Error(`${resp.status}`);
    const data = await resp.json();
    editor.treeList = data.trees || [];
    renderTreeList();

    if (autoSelectId) {
      await selectTree(autoSelectId);
    } else if (editor.treeList.length > 0 && !editor.currentTreeId) {
      await selectTree(editor.treeList[0].id);
    } else {
      setStatus("就绪", "saved");
    }
  } catch (e) {
    setStatus(`加载列表失败: ${e.message}`, "bad");
  }
}

function renderTreeList() {
  refs.treeList.innerHTML = "";
  editor.treeList.forEach((t) => {
    const item = document.createElement("div");
    item.className = "npc-item";
    item.dataset.treeId = t.id;
    if (t.id === editor.currentTreeId) item.classList.add("active");

    const nameSpan = document.createElement("span");
    nameSpan.className = "npc-name";
    nameSpan.textContent = t.name || t.id;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-tree-button";
    deleteBtn.textContent = "删除";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteTree(t.id);
    });

    item.appendChild(nameSpan);
    item.appendChild(deleteBtn);
    item.addEventListener("click", () => selectTree(t.id));
    refs.treeList.appendChild(item);
  });
}

async function createTree() {
  const name = refs.newTreeName.value.trim();
  if (!name) { setStatus("请输入行为树名称", "bad"); return; }
  const treeId = "bt-" + Date.now().toString(36);
  const tree = getDefaultBehaviorTree(treeId, name);
  try {
    const resp = await fetch(`/api/behavior-trees/${encodeURIComponent(treeId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tree),
    });
    if (!resp.ok) throw new Error(`${resp.status}`);
    refs.newTreeName.value = "";
    editor.treeList.push({ id: treeId, name, created: tree.created, modified: tree.modified });
    renderTreeList();
    await selectTree(treeId);
    setStatus(`已创建 "${name}"`, "saved");
  } catch (e) {
    setStatus(`创建失败: ${e.message}`, "bad");
  }
}

async function deleteTree(treeId) {
  if (!confirm(`确定删除行为树 "${treeId}"？此操作不可撤销。`)) return;
  try {
    const resp = await fetch(`/api/behavior-trees/${encodeURIComponent(treeId)}`, { method: "DELETE" });
    if (!resp.ok) throw new Error(`${resp.status}`);
    editor.treeList = editor.treeList.filter((t) => t.id !== treeId);
    if (editor.currentTreeId === treeId) {
      editor.currentTreeId = null;
      editor.behaviorTree = null;
      editor.selectedNodeId = null;
      editor.selectedTransitionId = null;
      editor.selectedBrainRuleId = null;
      editor.expandedBrainRuleId = null;
      editor.dirty = false;
      updateSaveButton();
      renderGraph();
      renderPropertyPanel();
    }
    renderTreeList();
    setStatus(`已删除`, "saved");
  } catch (e) {
    setStatus(`删除失败: ${e.message}`, "bad");
  }
}

async function selectTree(treeId) {
  if (editor.dirty && !confirm("当前行为树未保存，确定切换？")) return;

  editor.currentTreeId = treeId;
  editor.dirty = false;
  editor.selectedNodeId = null;
  editor.selectedTransitionId = null;
  editor.selectedBrainRuleId = null;
  editor.expandedBrainRuleId = null;

  renderTreeList();

  try {
    const resp = await fetch(`/api/behavior-trees/${encodeURIComponent(treeId)}`);
    if (resp.ok) {
      editor.behaviorTree = await resp.json();
      setStatus(`已加载 "${editor.behaviorTree.name || treeId}"`, "saved");
    } else {
      editor.behaviorTree = getDefaultBehaviorTree(treeId, treeId);
      setStatus(`已创建空白行为树`, "saved");
    }
  } catch (e) {
    editor.behaviorTree = getDefaultBehaviorTree(treeId, treeId);
    setStatus(`加载失败，已创建空白行为树`, "saved");
  }

  updateSaveButton();
  renderGraph();
  renderPropertyPanel();
}

async function saveBehaviorTree() {
  if (!editor.currentTreeId || !editor.behaviorTree) return;
  setStatus("保存中...");
  try {
    editor.behaviorTree.id = editor.currentTreeId;
    editor.behaviorTree.modified = new Date().toISOString();
    editor.behaviorTree.created = editor.behaviorTree.created || editor.behaviorTree.modified;
    if (!editor.behaviorTree.name) editor.behaviorTree.name = editor.currentTreeId;

    const checkResp = await fetch(`/api/behavior-trees/${encodeURIComponent(editor.currentTreeId)}`);
    if (checkResp.ok) {
      const existing = await checkResp.json();
      editor.behaviorTree.created = existing.created || editor.behaviorTree.created;
    }

    const resp = await fetch(`/api/behavior-trees/${encodeURIComponent(editor.currentTreeId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editor.behaviorTree),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `${resp.status}`);
    }

    editor.dirty = false;
    updateSaveButton();

    // update tree list name
    const entry = editor.treeList.find((t) => t.id === editor.currentTreeId);
    if (entry) entry.name = editor.behaviorTree.name;
    renderTreeList();

    setStatus(`已保存`, "saved");
  } catch (e) {
    setStatus(`保存失败: ${e.message}`, "bad");
  }
}

// ========= GRAPH RENDERING =========
function getCurrentState() {
  if (!editor.behaviorTree) return null;
  return editor.activeTree === "normal" ? editor.behaviorTree.normalState : editor.behaviorTree.combatState;
}

function renderGraph() {
  const state = getCurrentState();
  refs.graphNodes.innerHTML = "";
  refs.svgLayer.innerHTML = "";
  if (!state) return;

  createEntryNode();
  state.nodes.forEach((node) => createNodeElement(node));
  renderGraphNodesTransform();
}

function createEntryNode() {
  const wrapper = refs.graphNodes;
  const div = document.createElement("div");
  div.className = "behavior-node type-entry";
  div.dataset.nodeId = ENTRY_NODE_ID;
  div.style.left = "80px";
  div.style.top = "200px";
  div.style.width = "120px";
  div.innerHTML = `
    <div class="node-header">入口</div>
    <div class="node-body">
      <div>${editor.activeTree === "normal" ? "默认行为" : "战斗行为"}</div>
      <div class="node-ports">
        <div></div>
        <div class="node-port port-out" data-port="out" data-node-id="${ENTRY_NODE_ID}"></div>
      </div>
    </div>`;
  const portOut = div.querySelector(".port-out");
  portOut.addEventListener("mousedown", (e) => onPortMouseDown(e, ENTRY_NODE_ID, "out"));
  wrapper.appendChild(div);
}

function createNodeElement(node) {
  const wrapper = refs.graphNodes;
  const typeDef = BEHAVIOR_NODE_TYPES.find((t) => t.key === node.type) || { label: node.type, icon: "" };
  const x = node.x || 200;
  const y = node.y || 200;
  const div = document.createElement("div");
  div.className = `behavior-node type-${node.type}`;
  div.dataset.nodeId = node.id;
  div.style.left = `${x}px`;
  div.style.top = `${y}px`;
  div.style.width = "140px";

  const cdText = node.cooldown > 0 ? `冷却: ${node.cooldown}ms` : "";
  const cdMod = node.cooldownModifiable ? " (可调)" : "";

  div.innerHTML = `
    <div class="node-header">${typeDef.icon || ""} ${node.label || typeDef.label}</div>
    <div class="node-body">
      <div>${typeDef.label}</div>
      ${cdText ? `<div class="cooldown-info">${cdText}${cdMod}</div>` : ""}
      <div class="node-ports">
        <div class="node-port port-in" data-port="in" data-node-id="${node.id}"></div>
        <div class="node-port port-out" data-port="out" data-node-id="${node.id}"></div>
      </div>
    </div>`;

  if (node.id === editor.selectedNodeId) div.classList.add("selected");

  div.addEventListener("mousedown", (e) => onNodeMouseDown(e, node.id));

  const portIn = div.querySelector(".port-in");
  const portOut = div.querySelector(".port-out");
  portIn.addEventListener("mousedown", (e) => onPortMouseDown(e, node.id, "in"));
  portOut.addEventListener("mousedown", (e) => onPortMouseDown(e, node.id, "out"));
  portIn.addEventListener("mouseup", (e) => onPortMouseUp(e, node.id, "in"));
  portOut.addEventListener("mouseup", (e) => onPortMouseUp(e, node.id, "out"));

  wrapper.appendChild(div);
}

function getPortCenter(nodeId, portType) {
  const canvas = refs.graphCanvas;
  const wrapper = refs.graphNodes;
  const canvasRect = canvas.getBoundingClientRect();
  let el;
  if (nodeId === ENTRY_NODE_ID) {
    el = wrapper.querySelector(`[data-node-id="${ENTRY_NODE_ID}"] .port-${portType}`);
  } else {
    const nodeEl = wrapper.querySelector(`[data-node-id="${nodeId}"]`);
    if (!nodeEl) return null;
    el = nodeEl.querySelector(`.port-${portType}`);
  }
  if (!el) return null;
  const elRect = el.getBoundingClientRect();
  const cx = (elRect.left + elRect.right) / 2 - canvasRect.left - editor.canvasOffset.x;
  const cy = (elRect.top + elRect.bottom) / 2 - canvasRect.top - editor.canvasOffset.y;
  return { x: cx / editor.canvasScale, y: cy / editor.canvasScale };
}

function drawConnection(transition) {
  const svg = refs.svgLayer;
  const fromPort = transition.from === ENTRY_NODE_ID ? getPortCenter(ENTRY_NODE_ID, "out") : getPortCenter(transition.from, "out");
  const toPort = getPortCenter(transition.to, "in");
  if (!fromPort || !toPort) return;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.dataset.transitionId = transition.id;
  const dx = Math.abs(toPort.x - fromPort.x) * 0.5;
  const d = `M ${fromPort.x} ${fromPort.y} C ${fromPort.x + dx} ${fromPort.y}, ${toPort.x - dx} ${toPort.y}, ${toPort.x} ${toPort.y}`;
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", transition.id === editor.selectedTransitionId ? "#79d2c0" : "rgba(244,239,230,0.25)");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-dasharray", transition.condition?.type === "always" ? "none" : "6 3");
  path.style.pointerEvents = "stroke";
  path.addEventListener("click", (e) => { e.stopPropagation(); selectTransition(transition.id); });
  if (transition.id === editor.selectedTransitionId) path.classList.add("selected");

  // arrow marker
  const arrowId = `arrow-${transition.id}`;
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.prepend(defs);
  }
  const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.setAttribute("id", arrowId);
  marker.setAttribute("markerWidth", "8");
  marker.setAttribute("markerHeight", "8");
  marker.setAttribute("refX", "4");
  marker.setAttribute("refY", "4");
  marker.setAttribute("orient", "auto");
  marker.innerHTML = '<polygon points="0,0 8,4 0,8" fill="rgba(244,239,230,0.25)" />';
  defs.appendChild(marker);
  path.setAttribute("marker-end", `url(#${arrowId})`);
  svg.appendChild(path);
}

function renderAllConnections() {
  const svg = refs.svgLayer;
  svg.innerHTML = "";
  const state = getCurrentState();
  if (!state) return;
  state.transitions.forEach((t) => drawConnection(t));
}

// ========= CANVAS INTERACTIONS =========
function canvasToGraph(clientX, clientY) {
  const canvas = refs.graphCanvas;
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - editor.canvasOffset.x) / editor.canvasScale,
    y: (clientY - rect.top - editor.canvasOffset.y) / editor.canvasScale,
  };
}

function onCanvasMouseDown(e) {
  if (e.target === refs.graphCanvas || e.target === refs.svgLayer) {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      editor.dragState = { type: "pan", startX: e.clientX, startY: e.clientY, origX: editor.canvasOffset.x, origY: editor.canvasOffset.y };
      refs.graphCanvas.classList.add("dragging");
    } else if (e.button === 0) {
      editor.selectedNodeId = null;
      editor.selectedTransitionId = null;
      editor.activeTab = "node";
      refs.panelTabs.forEach((b) => b.classList.toggle("active", b.dataset.panelTab === "node"));
      renderGraph();
      renderPropertyPanel();
    }
  }
}

function onCanvasMouseMove(e) {
  if (editor.dragState?.type === "pan") {
    editor.canvasOffset.x = editor.dragState.origX + (e.clientX - editor.dragState.startX);
    editor.canvasOffset.y = editor.dragState.origY + (e.clientY - editor.dragState.startY);
    renderGraphNodesTransform();
  } else if (editor.dragState?.type === "node") {
    const pos = canvasToGraph(e.clientX, e.clientY);
    moveNodeOnCanvas(editor.dragState.nodeId, pos.x - editor.dragState.offsetX, pos.y - editor.dragState.offsetY);
  }
}

function onCanvasMouseUp() {
  if (editor.dragState?.type === "pan") refs.graphCanvas.classList.remove("dragging");
  if (editor.dragState?.type === "node") finalizeNodeMove();
  if (editor.dragState?.type === "wire") removeDragWire();
  editor.dragState = null;
}

function onDocumentMouseMove(e) {
  if (editor.dragState?.type === "wire") updateDragWire(e.clientX, e.clientY);
}

function onDocumentMouseUp() {
  if (editor.dragState?.type === "wire") { removeDragWire(); editor.dragState = null; }
}

function onDocumentClick(e) {
  const menu = document.querySelector(".context-menu");
  if (menu && !menu.contains(e.target)) menu.remove();
}

function onKeyDown(e) {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "Delete" || e.key === "Backspace") {
    if (editor.selectedNodeId && editor.selectedNodeId !== ENTRY_NODE_ID) deleteNode(editor.selectedNodeId);
    else if (editor.selectedTransitionId) deleteTransition(editor.selectedTransitionId);
    else if (editor.selectedBrainRuleId) deleteBrainRule(editor.selectedBrainRuleId);
  }
}

function onCanvasWheel(e) {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const newScale = Math.max(0.3, Math.min(2, editor.canvasScale * delta));
  const rect = refs.graphCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const worldX = (mx - editor.canvasOffset.x) / editor.canvasScale;
  const worldY = (my - editor.canvasOffset.y) / editor.canvasScale;
  editor.canvasOffset.x = mx - worldX * newScale;
  editor.canvasOffset.y = my - worldY * newScale;
  editor.canvasScale = newScale;
  renderGraphNodesTransform();
  refs.zoomInfo.textContent = `${Math.round(editor.canvasScale * 100)}%`;
}

function renderGraphNodesTransform() {
  const transform = `translate(${editor.canvasOffset.x}px, ${editor.canvasOffset.y}px) scale(${editor.canvasScale})`;
  refs.graphNodes.style.transform = transform;
  refs.svgLayer.style.transform = transform;
  refs.svgLayer.style.transformOrigin = "0 0";
  renderAllConnections();
}

// ========= NODE DRAG =========
function onNodeMouseDown(e, nodeId) {
  if (e.button !== 0) return;
  if (e.target.classList.contains("node-port")) return;
  e.stopPropagation();
  e.preventDefault();
  selectNode(nodeId);
  const pos = canvasToGraph(e.clientX, e.clientY);
  const node = getCurrentState()?.nodes?.find((n) => n.id === nodeId);
  editor.dragState = {
    type: "node", nodeId,
    offsetX: pos.x - (node?.x || 0),
    offsetY: pos.y - (node?.y || 0),
    origX: node?.x || 0, origY: node?.y || 0,
  };
}

function moveNodeOnCanvas(nodeId, x, y) {
  const state = getCurrentState();
  if (!state) return;
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  node.x = Math.round(x);
  node.y = Math.round(y);
  setDirty();
  const el = refs.graphNodes.querySelector(`[data-node-id="${nodeId}"]`);
  if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; }
  renderAllConnections();
}

function finalizeNodeMove() { renderAllConnections(); }

// ========= PORT / WIRE DRAG =========
function onPortMouseDown(e, nodeId, portType) {
  e.stopPropagation();
  e.preventDefault();
  if (portType === "out") {
    const pos = canvasToGraph(e.clientX, e.clientY);
    editor.dragState = { type: "wire", fromNodeId: nodeId, fromPort: portType, startX: pos.x, startY: pos.y };
    e.target.classList.add("drag-active");
    createDragWire(pos.x, pos.y);
  }
}

function onPortMouseUp(e, nodeId, portType) {
  if (editor.dragState?.type === "wire" && portType === "in") {
    createTransition(editor.dragState.fromNodeId, nodeId);
    removeDragWire();
    editor.dragState = null;
  }
  e.stopPropagation();
}

function createDragWire(x, y) {
  removeDragWire();
  const canvas = refs.graphCanvas;
  const wire = document.createElement("div");
  wire.className = "drag-wire";
  wire.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;z-index:50;pointer-events:none;";
  wire.dataset.dragWire = "true";
  const sx = x * editor.canvasScale + editor.canvasOffset.x;
  const sy = y * editor.canvasScale + editor.canvasOffset.y;
  wire.innerHTML = `<svg width="100%" height="100%" style="position:absolute;top:0;left:0;pointer-events:none;">
    <path d="M ${sx} ${sy} L ${sx} ${sy}"
          fill="none" stroke="#f6bd60" stroke-width="2" stroke-dasharray="6 3" /></svg>`;
  canvas.appendChild(wire);
}

function updateDragWire(clientX, clientY) {
  const wire = refs.graphCanvas.querySelector("[data-drag-wire]");
  if (!wire) return;
  const pos = canvasToGraph(clientX, clientY);
  const sx = editor.dragState.startX * editor.canvasScale + editor.canvasOffset.x;
  const sy = editor.dragState.startY * editor.canvasScale + editor.canvasOffset.y;
  const ex = pos.x * editor.canvasScale + editor.canvasOffset.x;
  const ey = pos.y * editor.canvasScale + editor.canvasOffset.y;
  const path = wire.querySelector("path");
  if (path) {
    const dx = Math.abs(ex - sx) * 0.5;
    path.setAttribute("d", `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`);
  }
}

function removeDragWire() {
  const wire = refs.graphCanvas.querySelector("[data-drag-wire]");
  if (wire) wire.remove();
  const activePort = refs.graphNodes.querySelector(".node-port.drag-active");
  if (activePort) activePort.classList.remove("drag-active");
}

function createTransition(fromNodeId, toNodeId) {
  if (fromNodeId === toNodeId) return;
  const state = getCurrentState();
  if (!state) return;
  if (state.transitions.find((t) => t.from === fromNodeId && t.to === toNodeId)) return;
  const t = { id: uid("tr"), from: fromNodeId, to: toNodeId, condition: { type: "always" } };
  state.transitions.push(t);
  setDirty();
  renderAllConnections();
  selectTransition(t.id);
  renderPropertyPanel();
}

// ========= SELECTION =========
function selectNode(nodeId) {
  editor.selectedNodeId = nodeId;
  editor.selectedTransitionId = null;
  editor.activeTab = "node";
  refs.panelTabs.forEach((b) => b.classList.toggle("active", b.dataset.panelTab === "node"));
  renderGraph();
  renderPropertyPanel();
}

function selectTransition(transitionId) {
  editor.selectedTransitionId = transitionId;
  editor.selectedNodeId = null;
  editor.activeTab = "transition";
  refs.panelTabs.forEach((b) => b.classList.toggle("active", b.dataset.panelTab === "transition"));
  renderGraph();
  renderPropertyPanel();
}

// ========= NODE CRUD =========
function addNode(nodeType) {
  const state = getCurrentState();
  if (!state) return;
  const typeDef = BEHAVIOR_NODE_TYPES.find((t) => t.key === nodeType);
  const node = {
    id: uid("nd"), type: nodeType,
    label: typeDef?.label || nodeType,
    cooldown: nodeType === "attack" ? 1500 : nodeType === "move" ? 2000 : nodeType === "stateTransition" ? 500 : 0,
    cooldownModifiable: nodeType === "attack" || nodeType === "move",
    params: {},
    x: 250 + state.nodes.length * 30,
    y: 200 + state.nodes.length * 40,
  };
  state.nodes.push(node);
  setDirty();
  selectNode(node.id);
  renderGraph();
  renderPropertyPanel();
}

function deleteNode(nodeId) {
  const state = getCurrentState();
  if (!state || !confirm("确定删除此节点？关联的连线也将被删除。")) return;
  state.nodes = state.nodes.filter((n) => n.id !== nodeId);
  state.transitions = state.transitions.filter((t) => t.from !== nodeId && t.to !== nodeId);
  editor.selectedNodeId = null;
  editor.selectedTransitionId = null;
  setDirty();
  renderGraph();
  renderPropertyPanel();
}

function deleteTransition(transitionId) {
  const state = getCurrentState();
  if (!state) return;
  state.transitions = state.transitions.filter((t) => t.id !== transitionId);
  editor.selectedTransitionId = null;
  setDirty();
  renderGraph();
  renderPropertyPanel();
}

// ========= CONTEXT MENU =========
function onCanvasContextMenu(e) {
  if (!editor.behaviorTree) return;
  e.preventDefault();
  const existing = document.querySelector(".context-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  BEHAVIOR_NODE_TYPES.forEach((typeDef) => {
    const item = document.createElement("div");
    item.className = "context-menu-item";
    item.innerHTML = `<span class="icon">${typeDef.icon}</span>添加${typeDef.label}`;
    item.addEventListener("click", () => { menu.remove(); addNode(typeDef.key); });
    menu.appendChild(item);
  });

  document.body.appendChild(menu);
  const menuRect = menu.getBoundingClientRect();
  if (menuRect.right > window.innerWidth) menu.style.left = `${e.clientX - menuRect.width}px`;
  if (menuRect.bottom > window.innerHeight) menu.style.top = `${e.clientY - menuRect.height}px`;
}

// ========= PROPERTY PANEL =========
function renderPropertyPanel() {
  const scroll = refs.fieldScroll;
  scroll.innerHTML = "";

  if (!editor.behaviorTree || !editor.currentTreeId) {
    refs.panelTitle.textContent = "属性面板";
    refs.panelSubtitle.textContent = "请先选择或创建一个行为树";
    return;
  }

  refs.panelTitle.textContent = editor.behaviorTree.name || editor.currentTreeId;
  refs.panelSubtitle.textContent = editor.activeTree === "normal" ? "默认状态行为树" : "战斗状态行为树";

  // tree name editable
  const nameGroup = document.createElement("section");
  nameGroup.className = "field-group";
  nameGroup.innerHTML = `<h2>行为树名称</h2>`;
  const nameRow = document.createElement("div");
  nameRow.className = "control-row";
  nameRow.innerHTML = `<label><span>名称</span></label>`;
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = editor.behaviorTree.name || "";
  nameInput.addEventListener("input", () => {
    editor.behaviorTree.name = nameInput.value;
    setDirty();
    refs.panelTitle.textContent = editor.behaviorTree.name || editor.currentTreeId;
  });
  nameRow.appendChild(nameInput);
  nameGroup.appendChild(nameRow);
  scroll.appendChild(nameGroup);

  if (editor.activeTab === "node") renderNodeProperties(scroll);
  else if (editor.activeTab === "transition") renderTransitionProperties(scroll);
  else if (editor.activeTab === "brain") renderBrainProperties(scroll);
}

function renderNodeProperties(scroll) {
  const selectedNodeId = editor.selectedNodeId;
  if (!selectedNodeId) {
    const info = document.createElement("div");
    info.className = "field-group";
    info.innerHTML = "<p style='color:#8fa79e;padding:20px 0;'>在画布中选择一个节点查看属性，或右键画布添加新节点</p>";
    scroll.appendChild(info);
    return;
  }

  const state = getCurrentState();
  if (!state) return;

  if (selectedNodeId === ENTRY_NODE_ID) {
    const group = document.createElement("section");
    group.className = "field-group";
    group.innerHTML = `<h2>入口节点</h2>
      <p style="color:#8fa79e;font-size:12px;">入口节点代表行为树的起点。拖拽其输出端口到其他节点创建连线。</p>`;
    scroll.appendChild(group);
    return;
  }

  const node = state.nodes.find((n) => n.id === selectedNodeId);
  if (!node) return;
  const typeDef = BEHAVIOR_NODE_TYPES.find((t) => t.key === node.type);

  const typeGroup = document.createElement("section");
  typeGroup.className = "field-group";
  typeGroup.innerHTML = `<h2>节点类型</h2>`;
  const typeRow = document.createElement("div");
  typeRow.className = "control-row";
  typeRow.innerHTML = `<label><span>类型</span></label><span style="color:#79d2c0;padding:5px 0;">${typeDef?.icon || ""} ${typeDef?.label || node.type}</span>`;
  typeGroup.appendChild(typeRow);
  scroll.appendChild(typeGroup);

  const labelGroup = document.createElement("section");
  labelGroup.className = "field-group";
  labelGroup.innerHTML = `<h2>基本信息</h2>`;
  const labelRow = document.createElement("div");
  labelRow.className = "control-row";
  labelRow.innerHTML = `<label><span>标签</span></label>`;
  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.value = node.label || "";
  labelInput.addEventListener("input", () => { node.label = labelInput.value; setDirty(); renderGraph(); });
  labelRow.appendChild(labelInput);
  labelGroup.appendChild(labelRow);
  scroll.appendChild(labelGroup);

  const cdGroup = document.createElement("section");
  cdGroup.className = "field-group";
  cdGroup.innerHTML = `<h2>冷却时间</h2>`;
  const cdRow = document.createElement("div");
  cdRow.className = "control-row";
  cdRow.innerHTML = `<label><span>冷却 (ms)</span></label>`;
  const cdInput = document.createElement("input");
  cdInput.type = "number";
  cdInput.min = 0; cdInput.max = 60000; cdInput.step = 100;
  cdInput.value = node.cooldown || 0;
  cdInput.addEventListener("input", () => { node.cooldown = parseInt(cdInput.value) || 0; setDirty(); renderGraph(); });
  cdRow.appendChild(cdInput);
  cdGroup.appendChild(cdRow);

  const cdModRow = document.createElement("div");
  cdModRow.className = "check-row";
  const cdModCheck = document.createElement("input");
  cdModCheck.type = "checkbox";
  cdModCheck.checked = node.cooldownModifiable || false;
  cdModCheck.addEventListener("change", () => { node.cooldownModifiable = cdModCheck.checked; setDirty(); });
  const cdModLabel = document.createElement("label");
  cdModLabel.textContent = "允许大脑模块调整冷却时间";
  cdModRow.appendChild(cdModCheck);
  cdModRow.appendChild(cdModLabel);
  cdGroup.appendChild(cdModRow);
  scroll.appendChild(cdGroup);

  const delGroup = document.createElement("section");
  delGroup.className = "field-group";
  delGroup.innerHTML = `<h2>操作</h2>`;
  const delBtn = document.createElement("button");
  delBtn.className = "btn-delete";
  delBtn.textContent = "删除节点";
  delBtn.addEventListener("click", () => deleteNode(node.id));
  delGroup.appendChild(delBtn);
  scroll.appendChild(delGroup);
}

function renderTransitionProperties(scroll) {
  const selectedId = editor.selectedTransitionId;
  if (!selectedId) {
    const info = document.createElement("div");
    info.className = "field-group";
    info.innerHTML = "<p style='color:#8fa79e;padding:20px 0;'>点击画布中的连线查看跳转条件</p>";
    scroll.appendChild(info);
    return;
  }

  const state = getCurrentState();
  if (!state) return;
  const t = state.transitions.find((tr) => tr.id === selectedId);
  if (!t) return;

  const group = document.createElement("section");
  group.className = "field-group";
  group.innerHTML = `<h2>跳转条件</h2>`;

  const fromNode = t.from === ENTRY_NODE_ID ? { id: ENTRY_NODE_ID, label: "入口" } : state.nodes.find((n) => n.id === t.from);
  const toNode = t.to === ENTRY_NODE_ID ? { id: ENTRY_NODE_ID, label: "入口" } : state.nodes.find((n) => n.id === t.to);

  const infoRow = document.createElement("div");
  infoRow.className = "control-row";
  infoRow.innerHTML = `<label><span>跳转</span></label><span style="color:#8fa79e;font-size:12px;padding:5px 0;">${fromNode?.label || t.from} → ${toNode?.label || t.to}</span>`;
  group.appendChild(infoRow);

  const condRow = document.createElement("div");
  condRow.className = "control-row";
  condRow.innerHTML = `<label><span>条件类型</span></label>`;
  const condSelect = document.createElement("select");
  TRANSITION_CONDITION_TYPES.forEach((ct) => {
    const opt = document.createElement("option");
    opt.value = ct.key; opt.textContent = ct.label;
    if (t.condition?.type === ct.key) opt.selected = true;
    condSelect.appendChild(opt);
  });
  condSelect.addEventListener("change", () => { t.condition = { type: condSelect.value }; setDirty(); renderGraph(); });
  condRow.appendChild(condSelect);
  group.appendChild(condRow);

  if (t.condition?.type === "targetDistance") {
    const distRow = document.createElement("div");
    distRow.className = "control-row";
    distRow.innerHTML = `<label><span>最大距离</span></label>`;
    const distInput = document.createElement("input");
    distInput.type = "number"; distInput.min = 1; distInput.max = 500;
    distInput.value = t.condition.params?.distance || 50;
    distInput.addEventListener("input", () => {
      if (!t.condition.params) t.condition.params = {};
      t.condition.params.distance = parseInt(distInput.value) || 50;
      setDirty();
    });
    distRow.appendChild(distInput);
    group.appendChild(distRow);
  }

  if (t.condition?.type === "targetStrengthChange") {
    const thrRow = document.createElement("div");
    thrRow.className = "control-row";
    thrRow.innerHTML = `<label><span>实力提升阈值</span></label>`;
    const thrInput = document.createElement("input");
    thrInput.type = "number"; thrInput.min = 1; thrInput.max = 100;
    thrInput.value = t.condition.params?.threshold || 20;
    thrInput.addEventListener("input", () => {
      if (!t.condition.params) t.condition.params = {};
      t.condition.params.threshold = parseInt(thrInput.value) || 20;
      setDirty();
    });
    thrRow.appendChild(thrInput);
    group.appendChild(thrRow);
  }

  scroll.appendChild(group);

  const delGroup = document.createElement("section");
  delGroup.className = "field-group";
  const delBtn = document.createElement("button");
  delBtn.className = "btn-delete";
  delBtn.textContent = "删除连线";
  delBtn.addEventListener("click", () => deleteTransition(t.id));
  delGroup.appendChild(delBtn);
  scroll.appendChild(delGroup);
}

function renderBrainProperties(scroll) {
  if (!editor.behaviorTree) return;
  if (!editor.behaviorTree.brain) editor.behaviorTree.brain = { rules: [] };

  const addGroup = document.createElement("section");
  addGroup.className = "field-group";
  addGroup.innerHTML = `<h2>大脑规则</h2>`;
  const addBtn = document.createElement("button");
  addBtn.className = "btn-add";
  addBtn.textContent = "+ 添加规则";
  addBtn.addEventListener("click", () => {
    const rule = { id: uid("rule"), name: "新规则", conditions: [], outputs: [] };
    editor.behaviorTree.brain.rules.push(rule);
    editor.selectedBrainRuleId = rule.id;
    editor.expandedBrainRuleId = rule.id;
    setDirty();
    renderPropertyPanel();
  });
  addGroup.appendChild(addBtn);
  scroll.appendChild(addGroup);

  const rules = editor.behaviorTree.brain.rules || [];
  rules.forEach((rule) => renderBrainRuleCard(scroll, rule));
}

function renderBrainRuleCard(scroll, rule) {
  const card = document.createElement("div");
  card.className = `rule-card${rule.id === editor.selectedBrainRuleId ? " selected" : ""}`;

  const header = document.createElement("div");
  header.className = "rule-card-header";
  header.innerHTML = `<span class="rule-name">${rule.name || "未命名规则"}</span><span class="rule-toggle${rule.id === editor.expandedBrainRuleId ? " open" : ""}">▶</span>`;
  header.addEventListener("click", () => {
    editor.selectedBrainRuleId = rule.id;
    editor.expandedBrainRuleId = editor.expandedBrainRuleId === rule.id ? null : rule.id;
    renderPropertyPanel();
  });

  const body = document.createElement("div");
  body.className = `rule-card-body${rule.id === editor.expandedBrainRuleId ? " open" : ""}`;

  const nameRow = document.createElement("div");
  nameRow.className = "control-row";
  nameRow.style.marginBottom = "10px";
  nameRow.innerHTML = `<label><span>名称</span></label>`;
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = rule.name || "";
  nameInput.addEventListener("input", () => { rule.name = nameInput.value; setDirty(); header.querySelector(".rule-name").textContent = rule.name || "未命名规则"; });
  nameRow.appendChild(nameInput);
  body.appendChild(nameRow);

  const condHeader = document.createElement("h3");
  condHeader.textContent = "评价条件";
  body.appendChild(condHeader);

  (rule.conditions || []).forEach((cond, ci) => {
    const row = document.createElement("div");
    row.className = "condition-row";

    const attrSelect = document.createElement("select");
    BRAIN_INPUT_ATTRIBUTES.forEach((a) => {
      const opt = document.createElement("option");
      opt.value = a.key; opt.textContent = a.label;
      if (cond.attribute === a.key) opt.selected = true;
      attrSelect.appendChild(opt);
    });
    attrSelect.addEventListener("change", () => { cond.attribute = attrSelect.value; setDirty(); });

    const opSelect = document.createElement("select");
    BRAIN_OPERATORS.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.key; opt.textContent = o.label;
      if (cond.operator === o.key) opt.selected = true;
      opSelect.appendChild(opt);
    });
    opSelect.addEventListener("change", () => { cond.operator = opSelect.value; setDirty(); });

    const valInput = document.createElement("input");
    valInput.type = "text"; valInput.value = cond.value ?? "";
    valInput.addEventListener("input", () => { cond.value = valInput.value; setDirty(); });

    const scoreInput = document.createElement("input");
    scoreInput.type = "number"; scoreInput.min = -100; scoreInput.max = 100;
    scoreInput.value = cond.score ?? 1; scoreInput.style.width = "40px";
    scoreInput.addEventListener("input", () => { cond.score = parseInt(scoreInput.value) || 0; setDirty(); });

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove"; removeBtn.innerHTML = "×";
    removeBtn.addEventListener("click", () => { rule.conditions.splice(ci, 1); setDirty(); renderPropertyPanel(); });

    row.appendChild(attrSelect); row.appendChild(opSelect); row.appendChild(valInput);
    row.appendChild(scoreInput); row.appendChild(removeBtn);
    body.appendChild(row);
  });

  const addCondBtn = document.createElement("button");
  addCondBtn.className = "btn-add"; addCondBtn.textContent = "+ 条件";
  addCondBtn.style.marginBottom = "10px";
  addCondBtn.addEventListener("click", () => {
    if (!rule.conditions) rule.conditions = [];
    rule.conditions.push({ attribute: "faction", operator: "eq", value: 0, score: 1 });
    setDirty(); renderPropertyPanel();
  });
  body.appendChild(addCondBtn);

  const outHeader = document.createElement("h3");
  outHeader.textContent = "输出动作";
  body.appendChild(outHeader);

  (rule.outputs || []).forEach((out, oi) => {
    const row = document.createElement("div");
    row.className = "output-row";

    const typeSelect = document.createElement("select");
    BRAIN_OUTPUT_TYPES.forEach((ot) => {
      const opt = document.createElement("option");
      opt.value = ot.key; opt.textContent = ot.label;
      if (out.type === ot.key) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    typeSelect.addEventListener("change", () => { out.type = typeSelect.value; out.params = {}; setDirty(); renderPropertyPanel(); });

    const paramsEl = document.createElement("div");
    paramsEl.style.cssText = "display:flex;gap:4px;";

    if (out.type === "switchState") {
      const stateSelect = document.createElement("select");
      ["combat", "normal"].forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s; opt.textContent = s === "combat" ? "战斗" : "默认";
        if (out.params?.state === s) opt.selected = true;
        stateSelect.appendChild(opt);
      });
      stateSelect.addEventListener("change", () => { out.params = { state: stateSelect.value }; setDirty(); });
      paramsEl.appendChild(stateSelect);
    } else if (out.type === "modifyCooldown") {
      const nodeIdInput = document.createElement("input");
      nodeIdInput.type = "text"; nodeIdInput.value = out.params?.nodeId || ""; nodeIdInput.placeholder = "节点ID";
      nodeIdInput.addEventListener("input", () => { if (!out.params) out.params = {}; out.params.nodeId = nodeIdInput.value; setDirty(); });
      const cdInput = document.createElement("input");
      cdInput.type = "number"; cdInput.min = 0; cdInput.value = out.params?.cooldown || 0; cdInput.placeholder = "冷却ms";
      cdInput.addEventListener("input", () => { if (!out.params) out.params = {}; out.params.cooldown = parseInt(cdInput.value) || 0; setDirty(); });
      paramsEl.appendChild(nodeIdInput); paramsEl.appendChild(cdInput);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove"; removeBtn.innerHTML = "×";
    removeBtn.addEventListener("click", () => { rule.outputs.splice(oi, 1); setDirty(); renderPropertyPanel(); });

    row.appendChild(typeSelect); row.appendChild(paramsEl); row.appendChild(removeBtn);
    body.appendChild(row);
  });

  const addOutBtn = document.createElement("button");
  addOutBtn.className = "btn-add"; addOutBtn.textContent = "+ 输出";
  addOutBtn.style.marginBottom = "6px";
  addOutBtn.addEventListener("click", () => {
    if (!rule.outputs) rule.outputs = [];
    rule.outputs.push({ type: "switchState", params: { state: "combat" } });
    setDirty(); renderPropertyPanel();
  });
  body.appendChild(addOutBtn);

  const delBtn = document.createElement("button");
  delBtn.className = "btn-delete"; delBtn.textContent = "删除规则";
  delBtn.style.marginTop = "8px";
  delBtn.addEventListener("click", () => deleteBrainRule(rule.id));
  body.appendChild(delBtn);

  card.appendChild(header); card.appendChild(body);
  scroll.appendChild(card);
}

function deleteBrainRule(ruleId) {
  if (!confirm("确定删除此大脑规则？")) return;
  if (!editor.behaviorTree?.brain) return;
  editor.behaviorTree.brain.rules = editor.behaviorTree.brain.rules.filter((r) => r.id !== ruleId);
  editor.selectedBrainRuleId = null;
  editor.expandedBrainRuleId = null;
  setDirty();
  renderPropertyPanel();
}

// ========= UTILITIES =========
function setDirty() { editor.dirty = true; updateSaveButton(); }

function updateSaveButton() {
  if (editor.dirty) { refs.btnSave.textContent = "保存 *"; refs.btnSave.classList.add("dirty"); }
  else { refs.btnSave.textContent = "保存"; refs.btnSave.classList.remove("dirty"); }
}

function setStatus(msg, type) {
  const el = refs.status;
  if (el) { el.textContent = msg; el.className = `status-pill${type ? ` ${type}` : ""}`; }
}
