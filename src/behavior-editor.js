import {
  BEHAVIOR_MODE_TYPES,
  BEHAVIOR_NODE_TYPES,
  BRAIN_DECISION_METRICS,
  BRAIN_INPUT_ATTRIBUTES,
  BRAIN_OPERATORS,
  BRAIN_SCORE_TARGET_TYPES,
  NODE_DATA_REQUIREMENTS,
  TARGET_SELECTOR_TYPES,
  TRANSITION_CONDITION_TYPES,
} from "./character-attributes.js";
import { evaluateNpcBrain } from "./npc-ai-runtime.js";
import "./behavior-editor.css";

const ENTRY_NODE_ID = "entry";
const BUILTIN_MODE_KEYS = new Set(BEHAVIOR_MODE_TYPES.map((mode) => mode.key));

let uidCounter = 0;
function uid(prefix) {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}`;
}

function nowIso() {
  return new Date().toISOString();
}

function createEmptyState() {
  return { nodes: [], transitions: [] };
}

function createModeDefinitions() {
  return BEHAVIOR_MODE_TYPES.map((mode) => ({ ...mode, builtin: true }));
}

function makeNode(type, label, x, y) {
  const typeDef = BEHAVIOR_NODE_TYPES.find((item) => item.key === type);
  const node = {
    id: uid("nd"),
    type,
    label: label || typeDef?.label || type,
    cooldown: type === "attack" ? 1500 : type === "run" ? 800 : type === "move" ? 500 : 0,
    cooldownModifiable: type === "attack" || type === "run" || type === "move",
    params: {},
    x,
    y,
  };
  ensureNodeBindings(node);
  return node;
}

function createDefaultBehaviorModes() {
  const defaultWalk = makeNode("walk", "随机走", 330, 210);
  const alertLook = makeNode("lookAt", "注视危险目标", 290, 160);
  const alertWalk = makeNode("walk", "警惕游走", 520, 160);
  const attackLook = makeNode("lookAt", "注视", 260, 150);
  const attackLock = makeNode("lockTarget", "锁定", 470, 150);
  const attack = makeNode("attack", "攻击", 680, 150);
  const flee = makeNode("run", "跑动逃离", 330, 210);

  return {
    default: {
      nodes: [defaultWalk],
      transitions: [{ id: uid("tr"), from: ENTRY_NODE_ID, to: defaultWalk.id, condition: { type: "always" } }],
    },
    alert: {
      nodes: [alertLook, alertWalk],
      transitions: [
        { id: uid("tr"), from: ENTRY_NODE_ID, to: alertLook.id, condition: { type: "always" } },
        { id: uid("tr"), from: alertLook.id, to: alertWalk.id, condition: { type: "always" } },
      ],
    },
    attack: {
      nodes: [attackLook, attackLock, attack],
      transitions: [
        { id: uid("tr"), from: ENTRY_NODE_ID, to: attackLook.id, condition: { type: "always" } },
        { id: uid("tr"), from: attackLook.id, to: attackLock.id, condition: { type: "always" } },
        { id: uid("tr"), from: attackLock.id, to: attack.id, condition: { type: "always" } },
      ],
    },
    flee: {
      nodes: [flee],
      transitions: [{ id: uid("tr"), from: ENTRY_NODE_ID, to: flee.id, condition: { type: "always" } }],
    },
  };
}

function createDefaultScoringRules() {
  return [
    {
      id: "score-hostile-faction",
      name: "阵营不一致",
      enabled: true,
      conditions: [{ attribute: "faction", operator: "neSelf", value: "" }],
      scoreTarget: "dangerScore",
      score: 5,
    },
    {
      id: "score-hostile-low-health",
      name: "敌方生命低",
      enabled: true,
      conditions: [
        { attribute: "faction", operator: "neSelf", value: "" },
        { attribute: "health", operator: "lte", value: 30 },
      ],
      scoreTarget: "dangerScore",
      score: 2,
    },
    {
      id: "score-hostile-strong",
      name: "敌方强壮",
      enabled: true,
      conditions: [
        { attribute: "faction", operator: "neSelf", value: "" },
        { attribute: "strength", operator: "gte", value: 60 },
      ],
      scoreTarget: "dangerScore",
      score: 3,
    },
    {
      id: "score-hostile-looking",
      name: "敌方注视我",
      enabled: true,
      conditions: [
        { attribute: "faction", operator: "neSelf", value: "" },
        { attribute: "attentionToMe", operator: "truthy", value: true },
      ],
      scoreTarget: "dangerScore",
      score: 10,
    },
    {
      id: "score-friendly-faction",
      name: "阵营一致",
      enabled: true,
      conditions: [{ attribute: "faction", operator: "eqSelf", value: "" }],
      scoreTarget: "safeScore",
      score: 5,
    },
    {
      id: "score-friendly-strong",
      name: "友方强壮",
      enabled: true,
      conditions: [
        { attribute: "faction", operator: "eqSelf", value: "" },
        { attribute: "strength", operator: "gte", value: 60 },
      ],
      scoreTarget: "safeScore",
      score: 10,
    },
    {
      id: "score-friendly-looking",
      name: "友方注视我",
      enabled: true,
      conditions: [
        { attribute: "faction", operator: "eqSelf", value: "" },
        { attribute: "attentionToMe", operator: "truthy", value: true },
      ],
      scoreTarget: "safeScore",
      score: 10,
    },
  ];
}

function createDefaultDecisionRules() {
  return [
    {
      id: "decision-flee-low-health",
      name: "低生命逃跑",
      enabled: true,
      priority: 10,
      conditions: [
        { metric: "selfHealth", operator: "lte", value: 20 },
        { metric: "dangerScore", operator: "gt", value: 0 },
      ],
      outputMode: "flee",
    },
    {
      id: "decision-flee-danger-ratio",
      name: "危险占比过高",
      enabled: true,
      priority: 20,
      conditions: [{ metric: "dangerRatio", operator: "gte", value: 0.7 }],
      outputMode: "flee",
    },
    {
      id: "decision-attack-danger",
      name: "进入攻击",
      enabled: true,
      priority: 30,
      conditions: [
        { metric: "dangerScore", operator: "gte", value: 10 },
        { metric: "dangerRatio", operator: "gte", value: 0.35 },
      ],
      outputMode: "attack",
    },
    {
      id: "decision-alert-cautious",
      name: "谨慎警惕",
      enabled: true,
      priority: 40,
      conditions: [
        { metric: "safeRatio", operator: "gte", value: 0.6 },
        { metric: "dangerScore", operator: "gt", value: 0 },
      ],
      outputMode: "alert",
    },
    {
      id: "decision-default-empty",
      name: "无可见目标",
      enabled: true,
      priority: 90,
      conditions: [{ metric: "visibleTargetCount", operator: "lte", value: 0 }],
      outputMode: "default",
    },
  ];
}

function createDefaultPreviewScenario() {
  return {
    self: {
      id: "self",
      name: "自己",
      faction: 1,
      health: 100,
      stamina: 100,
      strength: 45,
      agility: 10,
      reaction: 10,
      position: [0, 0, 0],
    },
    visibleTargets: [
      {
        id: "target-0",
        name: "目标0",
        faction: 0,
        health: 20,
        stamina: 100,
        strength: 70,
        agility: 10,
        reaction: 10,
        distance: 2,
        attentionToMe: true,
        position: [2, 0, 0],
      },
      {
        id: "target-1",
        name: "目标1",
        faction: 1,
        health: 80,
        stamina: 100,
        strength: 65,
        agility: 10,
        reaction: 10,
        distance: 3,
        attentionToMe: true,
        position: [-2, 0, 1],
      },
    ],
  };
}

function createDefaultBrain() {
  return {
    tickIntervalMs: 300,
    decisionCooldownMs: 1000,
    fallbackMode: "default",
    profileRefs: {
      brainProcessing: "",
      personality: "",
    },
    scoringRules: createDefaultScoringRules(),
    decisionRules: createDefaultDecisionRules(),
    blackboardSources: {
      highestDanger: { selector: "highestDanger" },
      weakestDanger: { selector: "weakestDanger" },
      lookTarget: { selector: "lookTarget" },
      lockedTarget: { selector: "lockedTarget" },
      randomPosition: { selector: "randomPosition", radius: 6 },
      fleeFromHighestDanger: { selector: "fleeFromHighestDanger", distance: 8 },
    },
    previewScenario: createDefaultPreviewScenario(),
    rules: [],
  };
}

function getDefaultBehaviorTree(id, name) {
  const created = nowIso();
  const behaviorModes = createDefaultBehaviorModes();
  const tree = {
    id,
    name: name || id,
    version: 2,
    created,
    modified: created,
    modeDefinitions: createModeDefinitions(),
    behaviorModes,
    brain: createDefaultBrain(),
  };
  syncLegacyStates(tree);
  return tree;
}

const editor = {
  currentTreeId: null,
  dirty: false,
  behaviorTree: null,
  activeTree: "default",
  selectedNodeId: null,
  selectedTransitionId: null,
  selectedBrainRuleId: null,
  expandedBrainRuleId: null,
  activeTab: "node",
  canvasOffset: { x: 430, y: 60 },
  canvasScale: 1,
  dragState: null,
  treeList: [],
  aiProfileLists: {
    brainProcessing: [],
    personality: [],
  },
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
    await loadAiProfileLists();
    await loadTreeList(autoTreeId);
    window.__BEHAVIOR_EDITOR_READY = true;
  } catch (error) {
    console.error(error);
    window.__BEHAVIOR_EDITOR_ERROR = error.message;
    setStatus(`初始化失败: ${error.message}`, "bad");
  }
}

function mountUI() {
  const app = document.querySelector("#behavior-editor-app");
  app.innerHTML = `
    <div class="editor-shell">
      <aside class="behavior-rail">
        <div class="editor-brand">
          <strong>行为树编辑器</strong>
          <span>NPC AI / Behavior Flow</span>
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
          <label class="mode-picker">
            <span>行为模式</span>
            <select data-mode-select></select>
          </label>
          <button class="mode-action" data-add-mode type="button">+ 模式</button>
          <button class="mode-action danger" data-delete-mode type="button">删除</button>
          <div class="spacer"></div>
          <span class="zoom-info" data-zoom-info>100%</span>
        </div>
        <div class="graph-canvas" data-graph-canvas>
          <aside class="brain-dock" data-brain-dock></aside>
          <div class="status-pill" data-status>选择或创建行为树开始编辑</div>
          <svg data-svg-layer></svg>
          <div class="graph-nodes" data-graph-nodes></div>
        </div>
        <div class="graph-footer">
          <span>右键画布: 添加节点 | 拖拽端口: 创建连线 | 滚轮: 缩放 | 中键或 Alt 拖拽: 平移</span>
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
          <button class="panel-tab" data-panel-tab="blackboard" type="button">黑板</button>
        </div>
        <div class="field-scroll" data-field-scroll></div>
      </aside>
    </div>`;

  refs.treeList = app.querySelector("[data-tree-list]");
  refs.status = app.querySelector("[data-status]");
  refs.brainDock = app.querySelector("[data-brain-dock]");
  refs.graphCanvas = app.querySelector("[data-graph-canvas]");
  refs.svgLayer = app.querySelector("[data-svg-layer]");
  refs.graphNodes = app.querySelector("[data-graph-nodes]");
  refs.zoomInfo = app.querySelector("[data-zoom-info]");
  refs.panelTitle = app.querySelector("[data-panel-title]");
  refs.panelSubtitle = app.querySelector("[data-panel-subtitle]");
  refs.fieldScroll = app.querySelector("[data-field-scroll]");
  refs.btnSave = app.querySelector("[data-btn-save]");
  refs.modeSelect = app.querySelector("[data-mode-select]");
  refs.addModeBtn = app.querySelector("[data-add-mode]");
  refs.deleteModeBtn = app.querySelector("[data-delete-mode]");
  refs.panelTabs = app.querySelectorAll("[data-panel-tab]");
  refs.newTreeName = app.querySelector("[data-new-tree-name]");
  refs.newTreeBtn = app.querySelector("[data-new-tree-btn]");
}

function bindUI() {
  refs.modeSelect.addEventListener("change", () => {
    editor.activeTree = refs.modeSelect.value;
    editor.selectedNodeId = null;
    editor.selectedTransitionId = null;
    renderModeSelect();
    renderGraph();
    renderPropertyPanel();
  });
  refs.addModeBtn.addEventListener("click", addBehaviorMode);
  refs.deleteModeBtn.addEventListener("click", deleteBehaviorMode);

  refs.panelTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      editor.activeTab = btn.dataset.panelTab;
      if (btn.dataset.panelTab === "node") {
        editor.selectedTransitionId = null;
        editor.selectedBrainRuleId = null;
      } else if (btn.dataset.panelTab === "transition") {
        editor.selectedNodeId = null;
        editor.selectedBrainRuleId = null;
      } else {
        editor.selectedNodeId = null;
        editor.selectedTransitionId = null;
      }
      refs.panelTabs.forEach((item) => item.classList.toggle("active", item.dataset.panelTab === editor.activeTab));
      renderGraph();
      renderPropertyPanel();
    });
  });

  refs.btnSave.addEventListener("click", () => saveBehaviorTree());
  refs.newTreeBtn.addEventListener("click", () => createTree());
  refs.newTreeName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") createTree();
  });

  const canvas = refs.graphCanvas;
  refs.brainDock.addEventListener("pointerdown", stopBrainDockEvent, true);
  refs.brainDock.addEventListener("mousedown", stopBrainDockEvent, true);
  refs.brainDock.addEventListener("mouseup", stopBrainDockEvent, true);
  refs.brainDock.addEventListener("click", onBrainDockClick, true);
  refs.brainDock.addEventListener("click", stopBrainDockEvent);
  refs.brainDock.addEventListener("dblclick", stopBrainDockEvent, true);
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

function stopBrainDockEvent(event) {
  event.stopPropagation();
}

function onBrainDockClick(event) {
  const actionButton = event.target.closest("[data-preview-action]");
  if (!actionButton || !refs.brainDock.contains(actionButton)) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  syncPreviewScenarioFromDock();
  const scenario = getPreviewScenario();
  const action = actionButton.dataset.previewAction;

  if (action === "add-target") {
    scenario.visibleTargets.push(createPreviewTarget(scenario.visibleTargets.length + 1));
    setDirty();
  } else if (action === "remove-target") {
    const index = Number(actionButton.dataset.targetIndex);
    if (Number.isInteger(index) && scenario.visibleTargets[index]) {
      scenario.visibleTargets.splice(index, 1);
      setDirty();
    }
  }

  renderPropertyPanel();
  renderGraph();
}

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
      renderModeSelect();
      renderPropertyPanel();
      setStatus("就绪", "saved");
    }
  } catch (error) {
    setStatus(`加载列表失败: ${error.message}`, "bad");
  }
}

async function loadAiProfileLists() {
  const [brainProcessing, personality] = await Promise.all([
    fetchAiProfileList("brain-processing"),
    fetchAiProfileList("personality"),
  ]);
  editor.aiProfileLists.brainProcessing = brainProcessing;
  editor.aiProfileLists.personality = personality;
}

async function fetchAiProfileList(type) {
  try {
    const resp = await fetch(`/api/ai-profiles/${type}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.profiles || [];
  } catch {
    return [];
  }
}

async function fetchAiProfile(type, profileId) {
  const resp = await fetch(`/api/ai-profiles/${type}/${encodeURIComponent(profileId)}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `${resp.status}`);
  }
  return resp.json();
}

async function saveAiProfile(type, profile) {
  const resp = await fetch(`/api/ai-profiles/${type}/${encodeURIComponent(profile.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `${resp.status}`);
  }
}

function renderTreeList() {
  refs.treeList.innerHTML = "";
  editor.treeList.forEach((tree) => {
    const item = document.createElement("div");
    item.className = "npc-item";
    item.dataset.treeId = tree.id;
    if (tree.id === editor.currentTreeId) item.classList.add("active");

    const nameSpan = document.createElement("span");
    nameSpan.className = "npc-name";
    nameSpan.textContent = tree.name || tree.id;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-tree-button";
    deleteBtn.textContent = "删除";
    deleteBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteTree(tree.id);
    });

    item.appendChild(nameSpan);
    item.appendChild(deleteBtn);
    item.addEventListener("click", () => selectTree(tree.id));
    refs.treeList.appendChild(item);
  });
}

async function createTree() {
  const name = refs.newTreeName.value.trim();
  if (!name) {
    setStatus("请输入行为树名称", "bad");
    return;
  }
  const treeId = `bt-${Date.now().toString(36)}`;
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
  } catch (error) {
    setStatus(`创建失败: ${error.message}`, "bad");
  }
}

async function deleteTree(treeId) {
  if (!confirm(`确定删除行为树 "${treeId}"？此操作不可撤销。`)) return;
  try {
    const resp = await fetch(`/api/behavior-trees/${encodeURIComponent(treeId)}`, { method: "DELETE" });
    if (!resp.ok) throw new Error(`${resp.status}`);
    editor.treeList = editor.treeList.filter((tree) => tree.id !== treeId);
    if (editor.currentTreeId === treeId) {
      editor.currentTreeId = null;
      editor.behaviorTree = null;
      editor.selectedNodeId = null;
      editor.selectedTransitionId = null;
      editor.selectedBrainRuleId = null;
      editor.expandedBrainRuleId = null;
      editor.dirty = false;
      renderModeSelect();
      updateSaveButton();
      renderGraph();
      renderPropertyPanel();
    }
    renderTreeList();
    setStatus("已删除", "saved");
  } catch (error) {
    setStatus(`删除失败: ${error.message}`, "bad");
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
  editor.activeTree = "default";

  renderTreeList();

  try {
    const resp = await fetch(`/api/behavior-trees/${encodeURIComponent(treeId)}`);
    if (resp.ok) {
      const data = await resp.json();
      editor.behaviorTree = normalizeBehaviorTree(data);
      setStatus(`已加载 "${editor.behaviorTree.name || treeId}"`, "saved");
    } else {
      editor.behaviorTree = getDefaultBehaviorTree(treeId, treeId);
      setStatus("已创建空白行为树", "saved");
    }
  } catch (error) {
    editor.behaviorTree = getDefaultBehaviorTree(treeId, treeId);
    setStatus(`加载失败，已创建空白行为树: ${error.message}`, "saved");
  }

  renderModeSelect();
  updateSaveButton();
  renderGraph();
  renderPropertyPanel();
}

async function saveBehaviorTree() {
  if (!editor.currentTreeId || !editor.behaviorTree) return;
  setStatus("保存中...");
  try {
    editor.behaviorTree.id = editor.currentTreeId;
    editor.behaviorTree.version = 2;
    editor.behaviorTree.modified = nowIso();
    editor.behaviorTree.created = editor.behaviorTree.created || editor.behaviorTree.modified;
    if (!editor.behaviorTree.name) editor.behaviorTree.name = editor.currentTreeId;
    syncLegacyStates(editor.behaviorTree);

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
    const entry = editor.treeList.find((tree) => tree.id === editor.currentTreeId);
    if (entry) entry.name = editor.behaviorTree.name;
    renderTreeList();
    setStatus("已保存", "saved");
  } catch (error) {
    setStatus(`保存失败: ${error.message}`, "bad");
  }
}

function normalizeBehaviorTree(input) {
  const tree = input && typeof input === "object" ? input : getDefaultBehaviorTree("unknown", "unknown");
  tree.version = 2;
  tree.modeDefinitions = Array.isArray(tree.modeDefinitions) && tree.modeDefinitions.length
    ? tree.modeDefinitions
    : createModeDefinitions();

  const defaultModes = createDefaultBehaviorModes();
  if (!tree.behaviorModes || typeof tree.behaviorModes !== "object") {
    tree.behaviorModes = {
      default: normalizeState(tree.normalState || defaultModes.default),
      alert: normalizeState(defaultModes.alert),
      attack: normalizeState(tree.combatState || defaultModes.attack),
      flee: normalizeState(defaultModes.flee),
    };
  }

  for (const modeDef of createModeDefinitions()) {
    if (!tree.modeDefinitions.some((item) => item.key === modeDef.key)) {
      tree.modeDefinitions.push(modeDef);
    }
    if (!tree.behaviorModes[modeDef.key]) {
      tree.behaviorModes[modeDef.key] = normalizeState(defaultModes[modeDef.key] || createEmptyState());
    }
  }

  for (const key of Object.keys(tree.behaviorModes)) {
    tree.behaviorModes[key] = normalizeState(tree.behaviorModes[key]);
  }

  tree.brain = normalizeBrain(tree.brain);
  syncLegacyStates(tree);
  return tree;
}

function normalizeState(state) {
  return {
    nodes: Array.isArray(state?.nodes) ? state.nodes.map(normalizeNode) : [],
    transitions: Array.isArray(state?.transitions) ? state.transitions.map(normalizeTransition) : [],
  };
}

function normalizeNode(node) {
  const normalized = {
    id: node.id || uid("nd"),
    type: node.type || "walk",
    label: node.label || getNodeTypeLabel(node.type || "walk"),
    cooldown: Number.isFinite(Number(node.cooldown)) ? Number(node.cooldown) : 0,
    cooldownModifiable: !!node.cooldownModifiable,
    params: node.params && typeof node.params === "object" ? node.params : {},
    x: Number.isFinite(Number(node.x)) ? Number(node.x) : 250,
    y: Number.isFinite(Number(node.y)) ? Number(node.y) : 200,
  };
  ensureNodeBindings(normalized);
  return normalized;
}

function normalizeTransition(transition) {
  return {
    id: transition.id || uid("tr"),
    from: transition.from || ENTRY_NODE_ID,
    to: transition.to,
    condition: transition.condition || { type: "always" },
  };
}

function normalizeBrain(brain) {
  const defaults = createDefaultBrain();
  const normalized = brain && typeof brain === "object" ? brain : {};
  normalized.tickIntervalMs = asInt(normalized.tickIntervalMs, defaults.tickIntervalMs);
  normalized.decisionCooldownMs = asInt(normalized.decisionCooldownMs, defaults.decisionCooldownMs);
  normalized.fallbackMode = normalized.fallbackMode || defaults.fallbackMode;
  normalized.profileRefs = {
    ...defaults.profileRefs,
    ...(normalized.profileRefs || {}),
  };
  normalized.scoringRules = Array.isArray(normalized.scoringRules) && normalized.scoringRules.length
    ? normalized.scoringRules.map(normalizeScoringRule)
    : defaults.scoringRules;
  normalized.decisionRules = Array.isArray(normalized.decisionRules) && normalized.decisionRules.length
    ? normalized.decisionRules.map(normalizeDecisionRule)
    : defaults.decisionRules;
  normalized.blackboardSources = {
    ...defaults.blackboardSources,
    ...(normalized.blackboardSources || {}),
  };
  normalized.previewScenario = normalizePreviewScenario(normalized.previewScenario || defaults.previewScenario);
  normalized.rules = Array.isArray(normalized.rules) ? normalized.rules : [];
  return normalized;
}

function normalizePreviewScenario(scenario) {
  const defaults = createDefaultPreviewScenario();
  return {
    self: normalizePreviewNpc(scenario?.self || defaults.self, defaults.self),
    visibleTargets: Array.isArray(scenario?.visibleTargets)
      ? scenario.visibleTargets.map((npc, index) => normalizePreviewNpc(npc, defaults.visibleTargets[index] || createPreviewTarget(index)))
      : defaults.visibleTargets,
  };
}

function normalizePreviewNpc(npc, fallback) {
  return {
    id: npc.id || fallback.id || uid("preview-npc"),
    name: npc.name || fallback.name || npc.id || "NPC",
    faction: asInt(npc.faction ?? fallback.faction, 0),
    health: asInt(npc.health ?? fallback.health, 100),
    stamina: asInt(npc.stamina ?? fallback.stamina, 100),
    strength: asInt(npc.strength ?? fallback.strength, 10),
    agility: asInt(npc.agility ?? fallback.agility, 10),
    reaction: asInt(npc.reaction ?? fallback.reaction, 10),
    distance: Number.isFinite(Number(npc.distance ?? fallback.distance)) ? Number(npc.distance ?? fallback.distance) : 2,
    attentionToMe: !!(npc.attentionToMe ?? fallback.attentionToMe),
    position: Array.isArray(npc.position) && npc.position.length >= 3
      ? [Number(npc.position[0]) || 0, Number(npc.position[1]) || 0, Number(npc.position[2]) || 0]
      : cloneData(fallback.position || [2, 0, 0]),
  };
}

function createPreviewTarget(index = 0) {
  const distance = 2 + index;
  return {
    id: `target-${Date.now().toString(36)}-${index}`,
    name: `目标${index}`,
    faction: 0,
    health: 100,
    stamina: 100,
    strength: 30,
    agility: 10,
    reaction: 10,
    distance,
    attentionToMe: false,
    position: [distance, 0, index % 2 === 0 ? 0 : 1],
  };
}

function normalizeScoringRule(rule) {
  return {
    id: rule.id || uid("score"),
    name: rule.name || "评分规则",
    enabled: rule.enabled !== false,
    conditions: normalizeScoreConditions(rule.conditions, rule),
    scoreTarget: rule.scoreTarget || "dangerScore",
    score: asInt(rule.score, 1),
  };
}

function normalizeScoreConditions(conditions, fallback) {
  if (Array.isArray(conditions) && conditions.length) {
    return conditions.map((condition) => ({
      attribute: condition.attribute || "faction",
      operator: condition.operator || "eq",
      value: condition.value ?? "",
    }));
  }
  return [{
    attribute: fallback.attribute || "faction",
    operator: fallback.operator || "eq",
    value: fallback.value ?? "",
  }];
}

function normalizeDecisionRule(rule) {
  return {
    id: rule.id || uid("decision"),
    name: rule.name || "决策规则",
    enabled: rule.enabled !== false,
    priority: asInt(rule.priority, 50),
    conditions: normalizeDecisionConditions(rule.conditions, rule),
    outputMode: rule.outputMode || rule.mode || "default",
  };
}

function normalizeDecisionConditions(conditions, fallback) {
  if (Array.isArray(conditions) && conditions.length) {
    return conditions.map((condition) => ({
      metric: condition.metric || "dangerRatio",
      operator: condition.operator || "gte",
      value: condition.value ?? 0,
    }));
  }
  return [{
    metric: fallback.metric || "dangerRatio",
    operator: fallback.operator || "gte",
    value: fallback.value ?? 0,
  }];
}

function syncLegacyStates(tree) {
  if (!tree.behaviorModes) return;
  tree.normalState = tree.behaviorModes.default || createEmptyState();
  tree.combatState = tree.behaviorModes.attack || createEmptyState();
}

function renderModeSelect() {
  refs.modeSelect.innerHTML = "";
  if (!editor.behaviorTree) {
    refs.modeSelect.disabled = true;
    refs.addModeBtn.disabled = true;
    refs.deleteModeBtn.disabled = true;
    return;
  }

  refs.modeSelect.disabled = false;
  refs.addModeBtn.disabled = false;
  const modes = getModeDefinitions();
  for (const mode of modes) {
    const option = document.createElement("option");
    option.value = mode.key;
    option.textContent = mode.label || mode.key;
    refs.modeSelect.appendChild(option);
  }
  if (!editor.behaviorTree.behaviorModes[editor.activeTree]) {
    editor.activeTree = modes[0]?.key || "default";
  }
  refs.modeSelect.value = editor.activeTree;
  refs.deleteModeBtn.disabled = BUILTIN_MODE_KEYS.has(editor.activeTree);
}

function addBehaviorMode() {
  if (!editor.behaviorTree) return;
  const label = prompt("请输入新行为模式名称:");
  if (!label) return;
  const key = `custom-${Date.now().toString(36)}`;
  editor.behaviorTree.modeDefinitions.push({ key, label, description: "", builtin: false });
  editor.behaviorTree.behaviorModes[key] = createEmptyState();
  editor.activeTree = key;
  setDirty();
  renderModeSelect();
  renderGraph();
  renderPropertyPanel();
}

function deleteBehaviorMode() {
  if (!editor.behaviorTree || BUILTIN_MODE_KEYS.has(editor.activeTree)) return;
  const modeLabel = getModeLabel(editor.activeTree);
  if (!confirm(`确定删除行为模式 "${modeLabel}"？`)) return;
  delete editor.behaviorTree.behaviorModes[editor.activeTree];
  editor.behaviorTree.modeDefinitions = editor.behaviorTree.modeDefinitions.filter((mode) => mode.key !== editor.activeTree);
  editor.activeTree = "default";
  editor.selectedNodeId = null;
  editor.selectedTransitionId = null;
  setDirty();
  renderModeSelect();
  renderGraph();
  renderPropertyPanel();
}

function getModeDefinitions() {
  return editor.behaviorTree?.modeDefinitions || createModeDefinitions();
}

function getModeLabel(key) {
  return getModeDefinitions().find((mode) => mode.key === key)?.label || key;
}

function getProfileName(refKey, profileId) {
  if (!profileId) return "";
  const list = refKey === "brainProcessing"
    ? editor.aiProfileLists.brainProcessing
    : editor.aiProfileLists.personality;
  return list.find((profile) => profile.id === profileId)?.name || profileId;
}

function getPreviewScenario() {
  const brain = editor.behaviorTree.brain;
  brain.previewScenario = normalizePreviewScenario(brain.previewScenario);
  return brain.previewScenario;
}

function getPreviewContext() {
  const scenario = getPreviewScenario();
  return {
    self: previewNpcToRuntimeEntity(scenario.self, 0),
    visibleTargets: scenario.visibleTargets.map((target, index) => previewNpcToRuntimeEntity(target, index + 1)),
  };
}

function previewNpcToRuntimeEntity(npc, index) {
  const distance = Number(npc.distance) || 0;
  return {
    ...npc,
    id: npc.id || npc.name || `npc-${index}`,
    attributes: {
      name: npc.name,
      health: Number(npc.health) || 0,
      stamina: Number(npc.stamina) || 0,
      strength: Number(npc.strength) || 0,
      agility: Number(npc.agility) || 0,
      reaction: Number(npc.reaction) || 0,
    },
    faction: Number(npc.faction) || 0,
    health: Number(npc.health) || 0,
    stamina: Number(npc.stamina) || 0,
    strength: Number(npc.strength) || 0,
    agility: Number(npc.agility) || 0,
    reaction: Number(npc.reaction) || 0,
    distance,
    attentionToMe: !!npc.attentionToMe,
    position: Array.isArray(npc.position) && npc.position.length >= 3
      ? npc.position
      : [distance, 0, index % 2 === 0 ? 1 : -1],
  };
}

function getCurrentState() {
  if (!editor.behaviorTree) return null;
  if (!editor.behaviorTree.behaviorModes[editor.activeTree]) {
    editor.behaviorTree.behaviorModes[editor.activeTree] = createEmptyState();
  }
  return editor.behaviorTree.behaviorModes[editor.activeTree];
}

function renderGraph() {
  refs.graphNodes.innerHTML = "";
  refs.svgLayer.innerHTML = "";
  refs.graphCanvas.classList.remove("brain-view");
  refs.graphNodes.classList.remove("brain-mode");
  refs.svgLayer.classList.remove("brain-mode");
  refs.zoomInfo.textContent = `${Math.round(editor.canvasScale * 100)}%`;
  const state = getCurrentState();
  if (!state) return;

  createEntryNode();
  state.nodes.forEach((node) => createNodeElement(node));
  renderGraphNodesTransform();
}

function createEntryNode() {
  const div = document.createElement("div");
  div.className = "behavior-node type-entry";
  div.dataset.nodeId = ENTRY_NODE_ID;
  div.style.left = "80px";
  div.style.top = "200px";
  div.style.width = "120px";
  div.innerHTML = `
    <div class="node-header">入口</div>
    <div class="node-body">
      <div>${escapeHtml(getModeLabel(editor.activeTree))}</div>
      <div class="node-ports">
        <div></div>
        <div class="node-port port-out" data-port="out" data-node-id="${ENTRY_NODE_ID}"></div>
      </div>
    </div>`;
  div.querySelector(".port-out").addEventListener("mousedown", (event) => onPortMouseDown(event, ENTRY_NODE_ID, "out"));
  refs.graphNodes.appendChild(div);
}

function createNodeElement(node) {
  const typeDef = BEHAVIOR_NODE_TYPES.find((type) => type.key === node.type) || { label: node.type, icon: "" };
  const div = document.createElement("div");
  div.className = `behavior-node type-${node.type}`;
  div.dataset.nodeId = node.id;
  div.style.left = `${node.x || 200}px`;
  div.style.top = `${node.y || 200}px`;
  div.style.width = "160px";

  const cooldownText = node.cooldown > 0 ? `<div class="cooldown-info">冷却: ${node.cooldown}ms${node.cooldownModifiable ? " (可调)" : ""}</div>` : "";
  const bindingLines = getNodeBindingSummary(node)
    .map((line) => `<div class="binding-info">${escapeHtml(line)}</div>`)
    .join("");

  div.innerHTML = `
    <div class="node-header">${typeDef.icon ? `${escapeHtml(typeDef.icon)} ` : ""}${escapeHtml(node.label || typeDef.label)}</div>
    <div class="node-body">
      <div>${escapeHtml(typeDef.label)}</div>
      ${cooldownText}
      ${bindingLines}
      <div class="node-ports">
        <div class="node-port port-in" data-port="in" data-node-id="${node.id}"></div>
        <div class="node-port port-out" data-port="out" data-node-id="${node.id}"></div>
      </div>
    </div>`;

  if (node.id === editor.selectedNodeId) div.classList.add("selected");
  div.addEventListener("mousedown", (event) => onNodeMouseDown(event, node.id));
  div.querySelector(".port-in").addEventListener("mousedown", (event) => onPortMouseDown(event, node.id, "in"));
  div.querySelector(".port-out").addEventListener("mousedown", (event) => onPortMouseDown(event, node.id, "out"));
  div.querySelector(".port-in").addEventListener("mouseup", (event) => onPortMouseUp(event, node.id, "in"));
  div.querySelector(".port-out").addEventListener("mouseup", (event) => onPortMouseUp(event, node.id, "out"));
  refs.graphNodes.appendChild(div);
}

function getPortCenter(nodeId, portType) {
  const canvasRect = refs.graphCanvas.getBoundingClientRect();
  const nodeEl = nodeId === ENTRY_NODE_ID
    ? refs.graphNodes.querySelector(`[data-node-id="${ENTRY_NODE_ID}"]`)
    : refs.graphNodes.querySelector(`[data-node-id="${nodeId}"]`);
  const portEl = nodeEl?.querySelector(`.port-${portType}`);
  if (!portEl) return null;
  const rect = portEl.getBoundingClientRect();
  const cx = (rect.left + rect.right) / 2 - canvasRect.left - editor.canvasOffset.x;
  const cy = (rect.top + rect.bottom) / 2 - canvasRect.top - editor.canvasOffset.y;
  return { x: cx / editor.canvasScale, y: cy / editor.canvasScale };
}

function drawConnection(transition) {
  const fromPort = getPortCenter(transition.from, "out");
  const toPort = getPortCenter(transition.to, "in");
  if (!fromPort || !toPort) return;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.dataset.transitionId = transition.id;
  const dx = Math.abs(toPort.x - fromPort.x) * 0.5;
  path.setAttribute("d", `M ${fromPort.x} ${fromPort.y} C ${fromPort.x + dx} ${fromPort.y}, ${toPort.x - dx} ${toPort.y}, ${toPort.x} ${toPort.y}`);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", transition.id === editor.selectedTransitionId ? "#79d2c0" : "rgba(244,239,230,0.25)");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-dasharray", transition.condition?.type === "always" ? "none" : "6 3");
  path.style.pointerEvents = "stroke";
  path.addEventListener("click", (event) => {
    event.stopPropagation();
    selectTransition(transition.id);
  });
  if (transition.id === editor.selectedTransitionId) path.classList.add("selected");

  const arrowId = `arrow-${transition.id}`;
  let defs = refs.svgLayer.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    refs.svgLayer.prepend(defs);
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
  refs.svgLayer.appendChild(path);
}

function renderAllConnections() {
  refs.svgLayer.innerHTML = "";
  const state = getCurrentState();
  if (!state) return;
  state.transitions.forEach((transition) => drawConnection(transition));
}

function canvasToGraph(clientX, clientY) {
  const rect = refs.graphCanvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - editor.canvasOffset.x) / editor.canvasScale,
    y: (clientY - rect.top - editor.canvasOffset.y) / editor.canvasScale,
  };
}

function onCanvasMouseDown(event) {
  if (event.target.closest?.("[data-brain-dock]")) return;
  if (event.target === refs.graphCanvas || event.target === refs.svgLayer) {
    if (event.button === 1 || (event.button === 0 && event.altKey)) {
      event.preventDefault();
      editor.dragState = {
        type: "pan",
        startX: event.clientX,
        startY: event.clientY,
        origX: editor.canvasOffset.x,
        origY: editor.canvasOffset.y,
      };
      refs.graphCanvas.classList.add("dragging");
    } else if (event.button === 0) {
      editor.selectedNodeId = null;
      editor.selectedTransitionId = null;
      editor.activeTab = "node";
      refs.panelTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.panelTab === "node"));
      renderGraph();
      renderPropertyPanel();
    }
  }
}

function onCanvasMouseMove(event) {
  if (editor.dragState?.type === "pan") {
    editor.canvasOffset.x = editor.dragState.origX + (event.clientX - editor.dragState.startX);
    editor.canvasOffset.y = editor.dragState.origY + (event.clientY - editor.dragState.startY);
    renderGraphNodesTransform();
  } else if (editor.dragState?.type === "node") {
    const pos = canvasToGraph(event.clientX, event.clientY);
    moveNodeOnCanvas(editor.dragState.nodeId, pos.x - editor.dragState.offsetX, pos.y - editor.dragState.offsetY);
  }
}

function onCanvasMouseUp() {
  if (editor.dragState?.type === "pan") refs.graphCanvas.classList.remove("dragging");
  if (editor.dragState?.type === "node") renderAllConnections();
  if (editor.dragState?.type === "wire") removeDragWire();
  editor.dragState = null;
}

function onDocumentMouseMove(event) {
  if (editor.dragState?.type === "wire") updateDragWire(event.clientX, event.clientY);
}

function onDocumentMouseUp() {
  if (editor.dragState?.type === "wire") {
    removeDragWire();
    editor.dragState = null;
  }
}

function onDocumentClick(event) {
  const menu = document.querySelector(".context-menu");
  if (menu && !menu.contains(event.target)) menu.remove();
}

function onKeyDown(event) {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) return;
  if (event.key === "Delete" || event.key === "Backspace") {
    if (editor.selectedNodeId && editor.selectedNodeId !== ENTRY_NODE_ID) deleteNode(editor.selectedNodeId);
    else if (editor.selectedTransitionId) deleteTransition(editor.selectedTransitionId);
    else if (editor.selectedBrainRuleId) deleteBrainRule(editor.selectedBrainRuleId);
  }
}

function onCanvasWheel(event) {
  if (event.target.closest?.("[data-brain-dock]")) {
    return;
  }
  event.preventDefault();
  const delta = event.deltaY > 0 ? 0.9 : 1.1;
  const newScale = Math.max(0.3, Math.min(2, editor.canvasScale * delta));
  const rect = refs.graphCanvas.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;
  const worldX = (mx - editor.canvasOffset.x) / editor.canvasScale;
  const worldY = (my - editor.canvasOffset.y) / editor.canvasScale;
  editor.canvasOffset.x = mx - worldX * newScale;
  editor.canvasOffset.y = my - worldY * newScale;
  editor.canvasScale = newScale;
  refs.zoomInfo.textContent = `${Math.round(editor.canvasScale * 100)}%`;
  renderGraphNodesTransform();
}

function renderGraphNodesTransform() {
  const transform = `translate(${editor.canvasOffset.x}px, ${editor.canvasOffset.y}px) scale(${editor.canvasScale})`;
  refs.graphNodes.style.transform = transform;
  refs.svgLayer.style.transform = transform;
  refs.svgLayer.style.transformOrigin = "0 0";
  renderAllConnections();
}

function onNodeMouseDown(event, nodeId) {
  if (event.button !== 0) return;
  if (event.target.classList.contains("node-port")) return;
  event.stopPropagation();
  event.preventDefault();
  selectNode(nodeId);
  const pos = canvasToGraph(event.clientX, event.clientY);
  const node = getCurrentState()?.nodes?.find((item) => item.id === nodeId);
  editor.dragState = {
    type: "node",
    nodeId,
    offsetX: pos.x - (node?.x || 0),
    offsetY: pos.y - (node?.y || 0),
  };
}

function moveNodeOnCanvas(nodeId, x, y) {
  const state = getCurrentState();
  const node = state?.nodes.find((item) => item.id === nodeId);
  if (!node) return;
  node.x = Math.round(x);
  node.y = Math.round(y);
  setDirty();
  const el = refs.graphNodes.querySelector(`[data-node-id="${nodeId}"]`);
  if (el) {
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
  }
  renderAllConnections();
}

function onPortMouseDown(event, nodeId, portType) {
  event.stopPropagation();
  event.preventDefault();
  if (portType !== "out") return;
  const pos = canvasToGraph(event.clientX, event.clientY);
  editor.dragState = { type: "wire", fromNodeId: nodeId, startX: pos.x, startY: pos.y };
  event.target.classList.add("drag-active");
  createDragWire(pos.x, pos.y);
}

function onPortMouseUp(event, nodeId, portType) {
  if (editor.dragState?.type === "wire" && portType === "in") {
    createTransition(editor.dragState.fromNodeId, nodeId);
    removeDragWire();
    editor.dragState = null;
  }
  event.stopPropagation();
}

function createDragWire(x, y) {
  removeDragWire();
  const wire = document.createElement("div");
  wire.className = "drag-wire";
  wire.dataset.dragWire = "true";
  const sx = x * editor.canvasScale + editor.canvasOffset.x;
  const sy = y * editor.canvasScale + editor.canvasOffset.y;
  wire.innerHTML = `<svg width="100%" height="100%" style="position:absolute;top:0;left:0;pointer-events:none;">
    <path d="M ${sx} ${sy} L ${sx} ${sy}" fill="none" stroke="#f6bd60" stroke-width="2" stroke-dasharray="6 3" /></svg>`;
  refs.graphCanvas.appendChild(wire);
}

function updateDragWire(clientX, clientY) {
  const wire = refs.graphCanvas.querySelector("[data-drag-wire]");
  if (!wire) return;
  const pos = canvasToGraph(clientX, clientY);
  const sx = editor.dragState.startX * editor.canvasScale + editor.canvasOffset.x;
  const sy = editor.dragState.startY * editor.canvasScale + editor.canvasOffset.y;
  const ex = pos.x * editor.canvasScale + editor.canvasOffset.x;
  const ey = pos.y * editor.canvasScale + editor.canvasOffset.y;
  const dx = Math.abs(ex - sx) * 0.5;
  wire.querySelector("path")?.setAttribute("d", `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`);
}

function removeDragWire() {
  refs.graphCanvas.querySelector("[data-drag-wire]")?.remove();
  refs.graphNodes.querySelector(".node-port.drag-active")?.classList.remove("drag-active");
}

function createTransition(fromNodeId, toNodeId) {
  if (fromNodeId === toNodeId) return;
  const state = getCurrentState();
  if (!state) return;
  if (state.transitions.some((transition) => transition.from === fromNodeId && transition.to === toNodeId)) return;
  const transition = { id: uid("tr"), from: fromNodeId, to: toNodeId, condition: { type: "always" } };
  state.transitions.push(transition);
  setDirty();
  renderAllConnections();
  selectTransition(transition.id);
}

function selectNode(nodeId) {
  editor.selectedNodeId = nodeId;
  editor.selectedTransitionId = null;
  editor.activeTab = "node";
  refs.panelTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.panelTab === "node"));
  renderGraph();
  renderPropertyPanel();
}

function selectTransition(transitionId) {
  editor.selectedTransitionId = transitionId;
  editor.selectedNodeId = null;
  editor.activeTab = "transition";
  refs.panelTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.panelTab === "transition"));
  renderGraph();
  renderPropertyPanel();
}

function addNode(nodeType) {
  const state = getCurrentState();
  if (!state) return;
  const node = makeNode(nodeType, "", 250 + state.nodes.length * 50, 200 + state.nodes.length * 40);
  state.nodes.push(node);
  setDirty();
  selectNode(node.id);
  renderGraph();
}

function deleteNode(nodeId) {
  const state = getCurrentState();
  if (!state || !confirm("确定删除此节点？关联连线也会删除。")) return;
  state.nodes = state.nodes.filter((node) => node.id !== nodeId);
  state.transitions = state.transitions.filter((transition) => transition.from !== nodeId && transition.to !== nodeId);
  editor.selectedNodeId = null;
  editor.selectedTransitionId = null;
  setDirty();
  renderGraph();
  renderPropertyPanel();
}

function deleteTransition(transitionId) {
  const state = getCurrentState();
  if (!state) return;
  state.transitions = state.transitions.filter((transition) => transition.id !== transitionId);
  editor.selectedTransitionId = null;
  setDirty();
  renderGraph();
  renderPropertyPanel();
}

function onCanvasContextMenu(event) {
  if (!editor.behaviorTree) return;
  if (event.target.closest?.("[data-brain-dock]")) return;
  event.preventDefault();
  document.querySelector(".context-menu")?.remove();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  BEHAVIOR_NODE_TYPES.forEach((typeDef) => {
    const item = document.createElement("div");
    item.className = "context-menu-item";
    item.textContent = `添加${typeDef.label}`;
    item.addEventListener("click", () => {
      menu.remove();
      addNode(typeDef.key);
    });
    menu.appendChild(item);
  });

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${event.clientX - rect.width}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${event.clientY - rect.height}px`;
}

function renderPropertyPanel() {
  refs.fieldScroll.innerHTML = "";
  renderBrainDock();

  if (!editor.behaviorTree || !editor.currentTreeId) {
    refs.panelTitle.textContent = "属性面板";
    refs.panelSubtitle.textContent = "请先选择或创建行为树";
    return;
  }

  refs.panelTitle.textContent = editor.behaviorTree.name || editor.currentTreeId;
  refs.panelSubtitle.textContent = `${getModeLabel(editor.activeTree)}行为模式`;
  if (editor.activeTab === "brain") editor.activeTab = "node";

  renderTreeNameSection(refs.fieldScroll);
  if (editor.activeTab === "node") renderNodeProperties(refs.fieldScroll);
  else if (editor.activeTab === "transition") renderTransitionProperties(refs.fieldScroll);
  else if (editor.activeTab === "blackboard") renderBlackboardProperties(refs.fieldScroll);
}

function renderBrainDock() {
  if (!refs.brainDock) return;
  refs.brainDock.innerHTML = "";
  if (!editor.behaviorTree || !editor.currentTreeId) {
    const empty = document.createElement("div");
    empty.className = "brain-dock-empty";
    empty.innerHTML = `<strong>大脑配置</strong><span>选择或创建行为树后在这里配置大脑处理、性格处理和模拟槽位。</span>`;
    refs.brainDock.appendChild(empty);
    return;
  }

  const head = document.createElement("div");
  head.className = "brain-dock-head";
  head.innerHTML = `<strong>大脑配置</strong><span>常驻配置区</span>`;
  refs.brainDock.appendChild(head);
  renderBrainProperties(refs.brainDock);
}

function renderTreeNameSection(scroll) {
  const group = createFieldGroup("行为树名称");
  const row = createControlRow("名称");
  const input = createTextInput(editor.behaviorTree.name || "", (value) => {
    editor.behaviorTree.name = value;
    refs.panelTitle.textContent = value || editor.currentTreeId;
    setDirty();
  });
  row.appendChild(input);
  group.appendChild(row);
  scroll.appendChild(group);
}

function renderNodeProperties(scroll) {
  const selectedNodeId = editor.selectedNodeId;
  if (!selectedNodeId) {
    appendHint(scroll, "在画布中选择节点查看属性，或右键画布添加新节点。");
    return;
  }

  if (selectedNodeId === ENTRY_NODE_ID) {
    appendHint(scroll, "入口节点代表当前行为模式的起点。拖拽输出端口到其他节点来创建执行链。");
    return;
  }

  const state = getCurrentState();
  const node = state?.nodes.find((item) => item.id === selectedNodeId);
  if (!node) return;
  ensureNodeBindings(node);

  const typeGroup = createFieldGroup("节点类型");
  typeGroup.appendChild(createInlineText("类型", getNodeTypeLabel(node.type)));
  scroll.appendChild(typeGroup);

  const basicGroup = createFieldGroup("基本信息");
  const labelRow = createControlRow("标签");
  labelRow.appendChild(createTextInput(node.label || "", (value) => {
    node.label = value;
    setDirty();
    renderGraph();
  }));
  basicGroup.appendChild(labelRow);
  scroll.appendChild(basicGroup);

  const cooldownGroup = createFieldGroup("冷却时间");
  const cooldownRow = createControlRow("冷却 (ms)");
  cooldownRow.appendChild(createNumberInput(node.cooldown || 0, { min: 0, max: 60000, step: 100 }, (value) => {
    node.cooldown = asInt(value, 0);
    setDirty();
    renderGraph();
  }));
  cooldownGroup.appendChild(cooldownRow);
  cooldownGroup.appendChild(createCheckboxRow("允许大脑模块调整冷却时间", node.cooldownModifiable || false, (checked) => {
    node.cooldownModifiable = checked;
    setDirty();
  }));
  scroll.appendChild(cooldownGroup);

  const requirements = NODE_DATA_REQUIREMENTS[node.type] || [];
  if (requirements.length) {
    const dataGroup = createFieldGroup("所需数据");
    for (const requirement of requirements) {
      const row = createControlRow(requirement.label);
      const select = createSelect(TARGET_SELECTOR_TYPES, node.params.bindings[requirement.key] || requirement.defaultSource, (value) => {
        node.params.bindings[requirement.key] = value;
        setDirty();
        renderGraph();
      });
      row.appendChild(select);
      dataGroup.appendChild(row);
    }
    scroll.appendChild(dataGroup);
  }

  const actionGroup = createFieldGroup("操作");
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-delete";
  deleteBtn.textContent = "删除节点";
  deleteBtn.addEventListener("click", () => deleteNode(node.id));
  actionGroup.appendChild(deleteBtn);
  scroll.appendChild(actionGroup);
}

function renderTransitionProperties(scroll) {
  const selectedId = editor.selectedTransitionId;
  if (!selectedId) {
    appendHint(scroll, "点击画布中的连线查看跳转条件。");
    return;
  }

  const state = getCurrentState();
  const transition = state?.transitions.find((item) => item.id === selectedId);
  if (!transition) return;
  if (!transition.condition) transition.condition = { type: "always" };

  const group = createFieldGroup("跳转条件");
  const fromNode = transition.from === ENTRY_NODE_ID ? { label: "入口" } : state.nodes.find((node) => node.id === transition.from);
  const toNode = state.nodes.find((node) => node.id === transition.to);
  group.appendChild(createInlineText("跳转", `${fromNode?.label || transition.from} -> ${toNode?.label || transition.to}`));

  const condRow = createControlRow("条件类型");
  condRow.appendChild(createSelect(TRANSITION_CONDITION_TYPES, transition.condition.type || "always", (value) => {
    transition.condition = { type: value, params: {} };
    setDirty();
    renderGraph();
    renderPropertyPanel();
  }));
  group.appendChild(condRow);

  if (transition.condition.type === "targetDistance") {
    const distRow = createControlRow("最大距离");
    distRow.appendChild(createNumberInput(transition.condition.params?.distance || 50, { min: 1, max: 500, step: 1 }, (value) => {
      transition.condition.params = transition.condition.params || {};
      transition.condition.params.distance = asInt(value, 50);
      setDirty();
    }));
    group.appendChild(distRow);
  }

  if (transition.condition.type === "targetStrengthChange") {
    const thresholdRow = createControlRow("强壮度变化阈值");
    thresholdRow.appendChild(createNumberInput(transition.condition.params?.threshold || 20, { min: 1, max: 100, step: 1 }, (value) => {
      transition.condition.params = transition.condition.params || {};
      transition.condition.params.threshold = asInt(value, 20);
      setDirty();
    }));
    group.appendChild(thresholdRow);
  }
  scroll.appendChild(group);

  const actionGroup = createFieldGroup("操作");
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-delete";
  deleteBtn.textContent = "删除连线";
  deleteBtn.addEventListener("click", () => deleteTransition(transition.id));
  actionGroup.appendChild(deleteBtn);
  scroll.appendChild(actionGroup);
}

function renderBrainProperties(scroll) {
  const brain = editor.behaviorTree.brain;
  renderAiProfileControls(scroll, brain);

  const generalGroup = createFieldGroup("大脑节奏");
  const tickRow = createControlRow("计算间隔 (ms)");
  tickRow.appendChild(createNumberInput(brain.tickIntervalMs, { min: 50, max: 5000, step: 50 }, (value) => {
    brain.tickIntervalMs = asInt(value, 300);
    setDirty();
  }));
  generalGroup.appendChild(tickRow);
  const cooldownRow = createControlRow("决策冷却 (ms)");
  cooldownRow.appendChild(createNumberInput(brain.decisionCooldownMs, { min: 0, max: 10000, step: 100 }, (value) => {
    brain.decisionCooldownMs = asInt(value, 1000);
    setDirty();
  }));
  generalGroup.appendChild(cooldownRow);
  const fallbackRow = createControlRow("默认输出");
  fallbackRow.appendChild(createSelect(getModeDefinitions(), brain.fallbackMode || "default", (value) => {
    brain.fallbackMode = value;
    setDirty();
  }));
  generalGroup.appendChild(fallbackRow);
  scroll.appendChild(generalGroup);

  renderScoringRules(scroll, brain);
  renderDecisionRules(scroll, brain);
  renderBrainPreview(scroll);
}

function renderAiProfileControls(scroll, brain) {
  const group = createFieldGroup("可复用模板");
  group.appendChild(createProfileRow({
    title: "大脑处理判断",
    description: "保存/复用目标安全分与危险分的计算规则，例如动物型、人类型、僧侣型。",
    type: "brain-processing",
    refKey: "brainProcessing",
    profiles: editor.aiProfileLists.brainProcessing,
    currentId: brain.profileRefs?.brainProcessing || "",
  }));
  group.appendChild(createProfileRow({
    title: "性格处理",
    description: "保存/复用根据分值选择行为模式的规则，例如谨慎型、反社会型、勇猛型。",
    type: "personality",
    refKey: "personality",
    profiles: editor.aiProfileLists.personality,
    currentId: brain.profileRefs?.personality || "",
  }));
  scroll.appendChild(group);
}

function createProfileRow({ title, description, type, refKey, profiles, currentId }) {
  const wrapper = document.createElement("div");
  wrapper.className = "profile-box";

  const head = document.createElement("div");
  head.className = "profile-head";
  head.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span>`;
  wrapper.appendChild(head);

  const controls = document.createElement("div");
  controls.className = "profile-controls";

  const select = document.createElement("select");
  const emptyOpt = document.createElement("option");
  emptyOpt.value = "";
  emptyOpt.textContent = "-- 选择模板 --";
  select.appendChild(emptyOpt);
  profiles.forEach((profile) => {
    const opt = document.createElement("option");
    opt.value = profile.id;
    opt.textContent = profile.name || profile.id;
    if (profile.id === currentId) opt.selected = true;
    select.appendChild(opt);
  });
  select.value = currentId || "";
  select.addEventListener("change", () => {
    editor.behaviorTree.brain.profileRefs[refKey] = select.value;
    setDirty();
  });

  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "btn-add";
  applyBtn.textContent = "套用";
  applyBtn.addEventListener("click", () => applyAiProfile(type, select.value));

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn-add";
  saveBtn.textContent = "另存当前";
  saveBtn.addEventListener("click", () => saveCurrentAiProfile(type));

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "btn-add";
  refreshBtn.textContent = "刷新";
  refreshBtn.addEventListener("click", async () => {
    await loadAiProfileLists();
    renderPropertyPanel();
  });

  controls.appendChild(select);
  controls.appendChild(applyBtn);
  controls.appendChild(saveBtn);
  controls.appendChild(refreshBtn);
  wrapper.appendChild(controls);
  return wrapper;
}

async function applyAiProfile(type, profileId) {
  if (!profileId) {
    setStatus("请先选择模板", "bad");
    return;
  }
  try {
    const profile = await fetchAiProfile(type, profileId);
    const brain = editor.behaviorTree.brain;
    if (type === "brain-processing") {
      brain.scoringRules = cloneData(profile.scoringRules || []);
      brain.profileRefs.brainProcessing = profile.id;
      if (profile.blackboardSources) {
        brain.blackboardSources = {
          ...brain.blackboardSources,
          ...cloneData(profile.blackboardSources),
        };
      }
    } else if (type === "personality") {
      brain.decisionRules = cloneData(profile.decisionRules || []);
      brain.profileRefs.personality = profile.id;
      brain.fallbackMode = profile.fallbackMode || brain.fallbackMode || "default";
      brain.decisionCooldownMs = profile.decisionCooldownMs ?? brain.decisionCooldownMs;
    }
    setDirty();
    renderPropertyPanel();
    setStatus(`已套用模板 "${profile.name || profile.id}"`, "saved");
  } catch (error) {
    setStatus(`套用模板失败: ${error.message}`, "bad");
  }
}

async function saveCurrentAiProfile(type) {
  const name = prompt(type === "brain-processing" ? "请输入大脑处理模板名称:" : "请输入性格模板名称:");
  if (!name) return;
  const id = slugify(name);
  const description = prompt("模板说明（可留空）:") || "";
  const brain = editor.behaviorTree.brain;
  const profile = type === "brain-processing"
    ? {
        id,
        name,
        description,
        scoringRules: cloneData(brain.scoringRules || []),
        blackboardSources: cloneData(brain.blackboardSources || {}),
      }
    : {
        id,
        name,
        description,
        decisionRules: cloneData(brain.decisionRules || []),
        fallbackMode: brain.fallbackMode || "default",
        decisionCooldownMs: brain.decisionCooldownMs ?? 1000,
      };

  try {
    await saveAiProfile(type, profile);
    await loadAiProfileLists();
    if (type === "brain-processing") {
      brain.profileRefs.brainProcessing = id;
    } else {
      brain.profileRefs.personality = id;
    }
    setDirty();
    renderPropertyPanel();
    setStatus(`已保存模板 "${name}"`, "saved");
  } catch (error) {
    setStatus(`保存模板失败: ${error.message}`, "bad");
  }
}

function renderScoringRules(scroll, brain) {
  const group = createFieldGroup("目标评分规则");
  const addBtn = document.createElement("button");
  addBtn.className = "btn-add";
  addBtn.textContent = "+ 添加评分规则";
  addBtn.addEventListener("click", () => {
    const rule = normalizeScoringRule({
      id: uid("score"),
      name: "新评分规则",
      conditions: [{ attribute: "faction", operator: "neSelf", value: "" }],
      scoreTarget: "dangerScore",
      score: 1,
    });
    brain.scoringRules.push(rule);
    editor.selectedBrainRuleId = rule.id;
    editor.expandedBrainRuleId = rule.id;
    setDirty();
    renderPropertyPanel();
  });
  group.appendChild(addBtn);
  scroll.appendChild(group);
  brain.scoringRules.forEach((rule) => renderScoringRuleCard(scroll, brain, rule));
}

function renderScoringRuleCard(scroll, brain, rule) {
  const card = createRuleCard(rule, `${rule.name || "未命名评分"} -> ${getScoreTargetLabel(rule.scoreTarget)} +${rule.score}`);
  const body = card.querySelector(".rule-card-body");
  body.appendChild(createCheckboxRow("启用", rule.enabled !== false, (checked) => {
    rule.enabled = checked;
    setDirty();
  }));

  const nameRow = createControlRow("名称");
  nameRow.appendChild(createTextInput(rule.name || "", (value) => {
    rule.name = value;
    setDirty();
    renderPropertyPanel();
  }));
  body.appendChild(nameRow);

  const scoreRow = document.createElement("div");
  scoreRow.className = "two-col-row";
  const targetRow = createControlRow("加分目标");
  targetRow.appendChild(createSelect(BRAIN_SCORE_TARGET_TYPES, rule.scoreTarget || "dangerScore", (value) => {
    rule.scoreTarget = value;
    setDirty();
    renderPropertyPanel();
  }));
  const valueRow = createControlRow("分值");
  valueRow.appendChild(createNumberInput(rule.score ?? 1, { min: -100, max: 100, step: 1 }, (value) => {
    rule.score = asInt(value, 0);
    setDirty();
    renderPropertyPanel();
  }));
  scoreRow.appendChild(targetRow);
  scoreRow.appendChild(valueRow);
  body.appendChild(scoreRow);

  appendSubhead(body, "条件");
  rule.conditions.forEach((condition, index) => {
    body.appendChild(createScoreConditionRow(rule, condition, index));
  });
  const addCondition = document.createElement("button");
  addCondition.className = "btn-add";
  addCondition.textContent = "+ 条件";
  addCondition.addEventListener("click", () => {
    rule.conditions.push({ attribute: "health", operator: "lte", value: 30 });
    setDirty();
    renderPropertyPanel();
  });
  body.appendChild(addCondition);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-delete";
  deleteBtn.textContent = "删除评分规则";
  deleteBtn.addEventListener("click", () => {
    brain.scoringRules = brain.scoringRules.filter((item) => item.id !== rule.id);
    deleteBrainRule(rule.id, false);
  });
  body.appendChild(deleteBtn);
  scroll.appendChild(card);
}

function createScoreConditionRow(rule, condition, index) {
  const row = document.createElement("div");
  row.className = "condition-row wide";
  row.appendChild(createSelect(BRAIN_INPUT_ATTRIBUTES, condition.attribute || "faction", (value) => {
    condition.attribute = value;
    setDirty();
  }));
  row.appendChild(createSelect(BRAIN_OPERATORS, condition.operator || "eq", (value) => {
    condition.operator = value;
    setDirty();
    renderPropertyPanel();
  }));
  const valueInput = createTextInput(condition.value ?? "", (value) => {
    condition.value = parseInputValue(value);
    setDirty();
  });
  valueInput.disabled = operatorHasNoValue(condition.operator);
  valueInput.placeholder = valueInput.disabled ? "自动" : "值";
  row.appendChild(valueInput);
  const removeBtn = createRemoveButton(() => {
    rule.conditions.splice(index, 1);
    if (!rule.conditions.length) rule.conditions.push({ attribute: "faction", operator: "neSelf", value: "" });
    setDirty();
    renderPropertyPanel();
  });
  row.appendChild(removeBtn);
  return row;
}

function renderDecisionRules(scroll, brain) {
  const group = createFieldGroup("性格/决策规则");
  const addBtn = document.createElement("button");
  addBtn.className = "btn-add";
  addBtn.textContent = "+ 添加决策规则";
  addBtn.addEventListener("click", () => {
    const rule = normalizeDecisionRule({
      id: uid("decision"),
      name: "新决策规则",
      priority: 50,
      conditions: [{ metric: "dangerRatio", operator: "gte", value: 0.5 }],
      outputMode: "alert",
    });
    brain.decisionRules.push(rule);
    editor.selectedBrainRuleId = rule.id;
    editor.expandedBrainRuleId = rule.id;
    setDirty();
    renderPropertyPanel();
  });
  group.appendChild(addBtn);
  scroll.appendChild(group);
  brain.decisionRules.forEach((rule) => renderDecisionRuleCard(scroll, brain, rule));
}

function renderDecisionRuleCard(scroll, brain, rule) {
  const card = createRuleCard(rule, `${rule.name || "未命名决策"} -> ${getModeLabel(rule.outputMode)}`);
  const body = card.querySelector(".rule-card-body");
  body.appendChild(createCheckboxRow("启用", rule.enabled !== false, (checked) => {
    rule.enabled = checked;
    setDirty();
  }));

  const nameRow = createControlRow("名称");
  nameRow.appendChild(createTextInput(rule.name || "", (value) => {
    rule.name = value;
    setDirty();
    renderPropertyPanel();
  }));
  body.appendChild(nameRow);

  const modeRow = document.createElement("div");
  modeRow.className = "two-col-row";
  const priorityRow = createControlRow("优先级");
  priorityRow.appendChild(createNumberInput(rule.priority ?? 50, { min: 0, max: 999, step: 1 }, (value) => {
    rule.priority = asInt(value, 50);
    setDirty();
    renderPropertyPanel();
  }));
  const outputRow = createControlRow("输出模式");
  outputRow.appendChild(createSelect(getModeDefinitions(), rule.outputMode || "default", (value) => {
    rule.outputMode = value;
    setDirty();
    renderPropertyPanel();
  }));
  modeRow.appendChild(priorityRow);
  modeRow.appendChild(outputRow);
  body.appendChild(modeRow);

  appendSubhead(body, "条件");
  rule.conditions.forEach((condition, index) => {
    body.appendChild(createDecisionConditionRow(rule, condition, index));
  });
  const addCondition = document.createElement("button");
  addCondition.className = "btn-add";
  addCondition.textContent = "+ 条件";
  addCondition.addEventListener("click", () => {
    rule.conditions.push({ metric: "dangerScore", operator: "gt", value: 0 });
    setDirty();
    renderPropertyPanel();
  });
  body.appendChild(addCondition);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-delete";
  deleteBtn.textContent = "删除决策规则";
  deleteBtn.addEventListener("click", () => {
    brain.decisionRules = brain.decisionRules.filter((item) => item.id !== rule.id);
    deleteBrainRule(rule.id, false);
  });
  body.appendChild(deleteBtn);
  scroll.appendChild(card);
}

function createDecisionConditionRow(rule, condition, index) {
  const row = document.createElement("div");
  row.className = "condition-row wide";
  row.appendChild(createSelect(BRAIN_DECISION_METRICS, condition.metric || "dangerRatio", (value) => {
    condition.metric = value;
    setDirty();
  }));
  row.appendChild(createSelect(BRAIN_OPERATORS.filter((operator) => !["eqSelf", "neSelf", "truthy", "falsy"].includes(operator.key)), condition.operator || "gte", (value) => {
    condition.operator = value;
    setDirty();
  }));
  row.appendChild(createTextInput(condition.value ?? 0, (value) => {
    condition.value = parseInputValue(value);
    setDirty();
  }));
  row.appendChild(createRemoveButton(() => {
    rule.conditions.splice(index, 1);
    if (!rule.conditions.length) rule.conditions.push({ metric: "dangerRatio", operator: "gte", value: 0.5 });
    setDirty();
    renderPropertyPanel();
  }));
  return row;
}

function renderBrainPreview(scroll) {
  const scenario = getPreviewScenario();
  const preview = evaluateNpcBrain(editor.behaviorTree, getPreviewContext());

  const group = createFieldGroup("示例预览");
  const grid = document.createElement("div");
  grid.className = "preview-grid";
  grid.innerHTML = `
    <div><span>安全总分</span><strong>${preview.aggregate.safeScore}</strong></div>
    <div><span>危险总分</span><strong>${preview.aggregate.dangerScore}</strong></div>
    <div><span>安全占比</span><strong>${Math.round(preview.aggregate.safeRatio * 100)}%</strong></div>
    <div><span>危险占比</span><strong>${Math.round(preview.aggregate.dangerRatio * 100)}%</strong></div>
    <div><span>危险目标</span><strong>${preview.aggregate.dangerTargetCount}</strong></div>
    <div><span>输出模式</span><strong>${escapeHtml(getModeLabel(preview.mode))}</strong></div>
  `;
  group.appendChild(grid);

  const hitLine = document.createElement("p");
  hitLine.className = "mini-note";
  hitLine.textContent = `命中决策: ${preview.decisionRule?.name || "fallback"}；他人槽位数量: ${scenario.visibleTargets.length}`;
  group.appendChild(hitLine);

  const slots = document.createElement("div");
  slots.className = "preview-slots";
  slots.appendChild(createPreviewNpcSlot({
    title: "代表自己的 NPC 数据",
    npc: scenario.self,
    removable: false,
    role: "self",
    onRemove: null,
    onChange: () => refreshBrainPreview(),
  }));

  scenario.visibleTargets.forEach((target, index) => {
    const targetScore = preview.targetScores[index];
    slots.appendChild(createPreviewNpcSlot({
      title: `代表他人的 NPC 数据 #${index + 1}`,
      npc: target,
      removable: true,
      role: "target",
      targetIndex: index,
      scoreText: targetScore ? `安全 ${targetScore.safeScore} / 危险 ${targetScore.dangerScore}` : "",
      onRemove: () => {
        scenario.visibleTargets.splice(index, 1);
        setDirty();
        renderPropertyPanel();
        renderGraph();
      },
      onChange: () => refreshBrainPreview(),
    }));
  });
  group.appendChild(slots);

  const actions = document.createElement("div");
  actions.className = "btn-row";
  const addBtn = document.createElement("button");
  addBtn.className = "btn-add";
  addBtn.type = "button";
  addBtn.dataset.previewAction = "add-target";
  addBtn.textContent = "+ 增加他人槽位";
  addBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    scenario.visibleTargets.push(createPreviewTarget(scenario.visibleTargets.length));
    setDirty();
    renderPropertyPanel();
    renderGraph();
  });
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "btn-add";
  refreshBtn.type = "button";
  refreshBtn.dataset.previewAction = "refresh-score";
  refreshBtn.textContent = "刷新评分";
  refreshBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    syncPreviewScenarioFromDock();
    renderPropertyPanel();
    renderGraph();
  });
  actions.appendChild(addBtn);
  actions.appendChild(refreshBtn);
  group.appendChild(actions);

  const note = document.createElement("p");
  note.className = "mini-note";
  note.textContent = "这些槽位只用于模拟 NPC 在不同人群中的评分，不会直接生成场景角色。保存行为树后会保留当前模拟数据。";
  group.appendChild(note);
  scroll.appendChild(group);
}

function createPreviewNpcSlot({ title, npc, removable, role, targetIndex = null, scoreText = "", onRemove, onChange }) {
  const slot = document.createElement("div");
  slot.className = `preview-slot${removable ? " compact" : ""}`;
  const slotRole = role || (removable ? "target" : "self");
  const isSelfSlot = slotRole === "self";
  slot.dataset.previewRole = slotRole;
  if (targetIndex !== null) slot.dataset.targetIndex = String(targetIndex);
  const header = document.createElement("div");
  header.className = "preview-slot-header";
  header.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(scoreText)}</span>`;
  if (removable) {
    const removeBtn = createRemoveButton(onRemove);
    removeBtn.dataset.previewAction = "remove-target";
    removeBtn.dataset.targetIndex = String(targetIndex);
    header.appendChild(removeBtn);
  }
  slot.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "slot-grid";
  grid.appendChild(createPreviewField("名称", createPreviewTextInput(npc.name || "", (value) => {
    npc.name = value;
    npc.id = npc.id || value;
    onChange();
  }), "name"));
  grid.appendChild(createPreviewField("阵营", createPreviewNumberInput(npc.faction, { min: 0, max: 99, step: 1 }, (value) => {
    npc.faction = asInt(value, 0);
    onChange();
  }), "faction"));
  grid.appendChild(createPreviewField("生命", createPreviewNumberInput(npc.health, { min: 0, max: 9999, step: 1 }, (value) => {
    npc.health = asInt(value, 100);
    onChange();
  }), "health"));
  grid.appendChild(createPreviewField("强壮度", createPreviewNumberInput(npc.strength, { min: 0, max: 100, step: 1 }, (value) => {
    npc.strength = asInt(value, 10);
    onChange();
  }), "strength"));
  grid.appendChild(createPreviewField("距离", createPreviewNumberInput(npc.distance ?? 0, { min: 0, max: 999, step: 0.5 }, (value) => {
    npc.distance = Number(value) || 0;
    npc.position = [npc.distance, 0, 0];
    onChange();
  }), "distance"));
  grid.appendChild(createPreviewField("注视我", createPreviewCheckbox(npc.attentionToMe || false, (checked) => {
    npc.attentionToMe = checked;
    onChange();
  }), "attentionToMe"));
  if (isSelfSlot) {
    grid.querySelector('[data-preview-field="name"]')?.closest(".preview-field")?.remove();
    grid.querySelector('[data-preview-field="attentionToMe"]')?.closest(".preview-field")?.remove();
  }
  slot.appendChild(grid);
  return slot;
}

function createPreviewField(label, input, fieldKey) {
  const field = document.createElement("label");
  field.className = "preview-field";
  if (fieldKey) input.dataset.previewField = fieldKey;
  const span = document.createElement("span");
  span.textContent = label;
  field.appendChild(span);
  field.appendChild(input);
  return field;
}

function createPreviewTextInput(value, onChange) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value ?? "";
  input.addEventListener("input", () => {
    onChange(input.value);
    setDirty();
  });
  return input;
}

function createPreviewNumberInput(value, attrs, onChange) {
  const input = document.createElement("input");
  input.type = "number";
  input.min = attrs.min;
  input.max = attrs.max;
  input.step = attrs.step;
  input.value = value ?? 0;
  input.addEventListener("input", () => {
    onChange(input.value);
    setDirty();
  });
  return input;
}

function createPreviewCheckbox(checked, onChange) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => {
    onChange(input.checked);
    setDirty();
  });
  return input;
}

function syncPreviewScenarioFromDock() {
  if (!editor.behaviorTree || !refs.brainDock) return;
  const scenario = getPreviewScenario();
  const selfSlot = refs.brainDock.querySelector('[data-preview-role="self"]');
  if (selfSlot) readPreviewSlotIntoNpc(selfSlot, scenario.self);

  refs.brainDock.querySelectorAll('[data-preview-role="target"]').forEach((slot) => {
    const index = Number(slot.dataset.targetIndex);
    if (Number.isInteger(index) && scenario.visibleTargets[index]) {
      readPreviewSlotIntoNpc(slot, scenario.visibleTargets[index]);
    }
  });
}

function readPreviewSlotIntoNpc(slot, npc) {
  if (!npc) return;
  const nameInput = slot.querySelector('[data-preview-field="name"]');
  const factionInput = slot.querySelector('[data-preview-field="faction"]');
  const healthInput = slot.querySelector('[data-preview-field="health"]');
  const strengthInput = slot.querySelector('[data-preview-field="strength"]');
  const distanceInput = slot.querySelector('[data-preview-field="distance"]');
  const attentionInput = slot.querySelector('[data-preview-field="attentionToMe"]');

  if (nameInput) {
    npc.name = nameInput.value;
    npc.id = npc.id || nameInput.value;
  }
  if (factionInput) npc.faction = asInt(factionInput.value, 0);
  if (healthInput) npc.health = asInt(healthInput.value, 100);
  if (strengthInput) npc.strength = asInt(strengthInput.value, 10);
  if (distanceInput) {
    npc.distance = Number(distanceInput.value) || 0;
    npc.position = [npc.distance, 0, 0];
  }
  if (attentionInput) npc.attentionToMe = attentionInput.checked;
}

function refreshBrainPreview() {
  syncPreviewScenarioFromDock();
  renderGraph();
}

function renderBlackboardProperties(scroll) {
  const brain = editor.behaviorTree.brain;
  const modeGroup = createFieldGroup("行为模式管理");
  getModeDefinitions().forEach((mode) => {
    const line = document.createElement("div");
    line.className = "readonly-line";
    line.innerHTML = `<span>${escapeHtml(mode.label || mode.key)}</span><em>${escapeHtml(mode.description || (mode.builtin ? "内置模式" : "自定义模式"))}</em>`;
    modeGroup.appendChild(line);
  });
  scroll.appendChild(modeGroup);

  const sourceGroup = createFieldGroup("黑板数据源");
  sourceGroup.appendChild(createInlineText("危险值最高者", "从评分结果中自动选取 dangerScore 最高目标"));
  sourceGroup.appendChild(createInlineText("危险弱者", "dangerScore > 0 且 strength 最低目标"));
  sourceGroup.appendChild(createInlineText("注视目标", "优先使用黑板缓存，否则回退危险最高者"));
  sourceGroup.appendChild(createInlineText("锁定目标", "优先使用锁定缓存，否则回退注视目标/危险弱者"));

  const randomRow = createControlRow("Random Pos 半径");
  randomRow.appendChild(createNumberInput(brain.blackboardSources.randomPosition?.radius ?? 6, { min: 1, max: 50, step: 1 }, (value) => {
    brain.blackboardSources.randomPosition = brain.blackboardSources.randomPosition || { selector: "randomPosition" };
    brain.blackboardSources.randomPosition.radius = asInt(value, 6);
    setDirty();
  }));
  sourceGroup.appendChild(randomRow);

  const fleeRow = createControlRow("逃跑距离");
  fleeRow.appendChild(createNumberInput(brain.blackboardSources.fleeFromHighestDanger?.distance ?? 8, { min: 1, max: 50, step: 1 }, (value) => {
    brain.blackboardSources.fleeFromHighestDanger = brain.blackboardSources.fleeFromHighestDanger || { selector: "fleeFromHighestDanger" };
    brain.blackboardSources.fleeFromHighestDanger.distance = asInt(value, 8);
    setDirty();
  }));
  sourceGroup.appendChild(fleeRow);
  scroll.appendChild(sourceGroup);
}

function createRuleCard(rule, title) {
  const card = document.createElement("div");
  card.className = `rule-card${rule.id === editor.selectedBrainRuleId ? " selected" : ""}`;
  const header = document.createElement("div");
  header.className = "rule-card-header";
  header.innerHTML = `<span class="rule-name">${escapeHtml(title)}</span><span class="rule-toggle${rule.id === editor.expandedBrainRuleId ? " open" : ""}">›</span>`;
  header.addEventListener("click", () => {
    editor.selectedBrainRuleId = rule.id;
    editor.expandedBrainRuleId = editor.expandedBrainRuleId === rule.id ? null : rule.id;
    renderPropertyPanel();
  });
  const body = document.createElement("div");
  body.className = `rule-card-body${rule.id === editor.expandedBrainRuleId ? " open" : ""}`;
  card.appendChild(header);
  card.appendChild(body);
  return card;
}

function deleteBrainRule(ruleId, rerender = true) {
  if (rerender && !confirm("确定删除此大脑规则？")) return;
  const brain = editor.behaviorTree?.brain;
  if (!brain) return;
  brain.scoringRules = brain.scoringRules.filter((rule) => rule.id !== ruleId);
  brain.decisionRules = brain.decisionRules.filter((rule) => rule.id !== ruleId);
  brain.rules = (brain.rules || []).filter((rule) => rule.id !== ruleId);
  editor.selectedBrainRuleId = null;
  editor.expandedBrainRuleId = null;
  setDirty();
  if (rerender) renderPropertyPanel();
}

function ensureNodeBindings(node) {
  node.params = node.params && typeof node.params === "object" ? node.params : {};
  node.params.bindings = node.params.bindings && typeof node.params.bindings === "object" ? node.params.bindings : {};
  const requirements = NODE_DATA_REQUIREMENTS[node.type] || [];
  for (const requirement of requirements) {
    if (!node.params.bindings[requirement.key]) {
      node.params.bindings[requirement.key] = requirement.defaultSource;
    }
  }
}

function getNodeBindingSummary(node) {
  ensureNodeBindings(node);
  const requirements = NODE_DATA_REQUIREMENTS[node.type] || [];
  return requirements.map((requirement) => {
    const source = node.params.bindings[requirement.key] || requirement.defaultSource;
    return `${requirement.label}: ${getSelectorLabel(source)}`;
  });
}

function getNodeTypeLabel(type) {
  return BEHAVIOR_NODE_TYPES.find((item) => item.key === type)?.label || type;
}

function getSelectorLabel(key) {
  return TARGET_SELECTOR_TYPES.find((item) => item.key === key)?.label || key;
}

function getScoreTargetLabel(key) {
  return BRAIN_SCORE_TARGET_TYPES.find((item) => item.key === key)?.label || key;
}

function createFieldGroup(title) {
  const group = document.createElement("section");
  group.className = "field-group";
  const h2 = document.createElement("h2");
  h2.textContent = title;
  group.appendChild(h2);
  return group;
}

function createControlRow(labelText) {
  const row = document.createElement("div");
  row.className = "control-row";
  const label = document.createElement("label");
  const span = document.createElement("span");
  span.textContent = labelText;
  label.appendChild(span);
  row.appendChild(label);
  return row;
}

function createInlineText(label, value) {
  const row = document.createElement("div");
  row.className = "inline-row";
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  const valueEl = document.createElement("strong");
  valueEl.textContent = value;
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  return row;
}

function createTextInput(value, onInput) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value ?? "";
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

function createNumberInput(value, attrs, onInput) {
  const input = document.createElement("input");
  input.type = "number";
  input.min = attrs.min;
  input.max = attrs.max;
  input.step = attrs.step;
  input.value = value ?? 0;
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

function createSelect(options, value, onChange) {
  const select = document.createElement("select");
  options.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.key;
    option.textContent = item.label || item.key;
    if (item.key === value) option.selected = true;
    select.appendChild(option);
  });
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function createCheckboxRow(label, checked, onChange) {
  const row = document.createElement("div");
  row.className = "check-row";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  const labelEl = document.createElement("label");
  labelEl.textContent = label;
  input.addEventListener("change", () => onChange(input.checked));
  row.appendChild(input);
  row.appendChild(labelEl);
  return row;
}

function createRemoveButton(onClick) {
  const button = document.createElement("button");
  button.className = "btn-remove";
  button.type = "button";
  button.textContent = "x";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick?.(event);
  });
  return button;
}

function appendSubhead(parent, text) {
  const h3 = document.createElement("h3");
  h3.textContent = text;
  parent.appendChild(h3);
}

function appendHint(scroll, text) {
  const group = createFieldGroup("提示");
  const p = document.createElement("p");
  p.className = "mini-note";
  p.textContent = text;
  group.appendChild(p);
  scroll.appendChild(group);
}

function parseInputValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

function operatorHasNoValue(operator) {
  return ["eqSelf", "neSelf", "truthy", "falsy"].includes(operator);
}

function asInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : fallback;
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function slugify(value) {
  const ascii = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || `profile-${Date.now().toString(36)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setDirty() {
  editor.dirty = true;
  updateSaveButton();
}

function updateSaveButton() {
  refs.btnSave.classList.toggle("dirty", editor.dirty);
  refs.btnSave.textContent = editor.dirty ? "保存 *" : "保存";
}

function setStatus(message, type) {
  if (!refs.status) return;
  refs.status.textContent = message;
  refs.status.className = `status-pill${type ? ` ${type}` : ""}`;
}
