import {
  COMBAT_MOVE_DIRECTIONS,
  cloneData,
  findActionNameForAnimationFile,
  normalizeCombatDirection,
  normalizeCombatMove,
  normalizeCombatMoveManager,
} from "./combat-move-manager.js";
import "./move-manager.css";

const ASSET_VERSION = "move-manager-20260603-01";
const assetUrl = (path) => `${path}?v=${ASSET_VERSION}`;

const editor = {
  manager: null,
  motionConfig: {},
  animationFiles: [],
  actionOptions: [],
  selectedDirection: "forward",
  dirty: false,
};

const refs = {};

window.__MOVE_MANAGER_READY = false;
window.__MOVE_MANAGER_ERROR = null;

boot();

async function boot() {
  mountUi();
  bindUi();

  try {
    setStatus("加载动作与招式配置...");
    const motionConfig = await loadMotionConfig();
    editor.motionConfig = motionConfig;
    const [animationFiles, manager] = await Promise.all([
      loadAnimationAssetFiles(motionConfig),
      loadCombatMoveManager(),
    ]);
    editor.animationFiles = animationFiles;
    editor.actionOptions = buildActionOptions(animationFiles, motionConfig);
    editor.manager = normalizeCombatMoveManager(manager);

    renderDirectionTabs();
    renderMoves();
    renderSummary();

    window.__MOVE_MANAGER_READY = true;
    setStatus("就绪", "saved");
  } catch (error) {
    console.error(error);
    window.__MOVE_MANAGER_ERROR = error.message;
    setStatus(`初始化失败：${error.message}`, "bad");
  }
}

function mountUi() {
  const app = document.querySelector("#move-manager-app");
  app.innerHTML = `
    <div class="move-shell">
      <aside class="move-sidebar">
        <div class="brand">
          <strong>招式管理器</strong>
          <span>Directional Move Pools</span>
        </div>
        <div class="direction-tabs" data-direction-tabs></div>
        <div class="manager-summary" data-summary></div>
      </aside>

      <main class="move-main">
        <header class="move-header">
          <div>
            <h1 data-heading>前向招式</h1>
            <p data-subheading>W 键触发的加权招式池</p>
          </div>
          <div class="header-actions">
            <button type="button" data-add-move>新增招式</button>
            <button type="button" data-save>保存</button>
          </div>
        </header>

        <section class="move-list" data-move-list></section>
      </main>

      <div class="status" data-status>启动中...</div>
    </div>
  `;

  refs.tabs = app.querySelector("[data-direction-tabs]");
  refs.summary = app.querySelector("[data-summary]");
  refs.heading = app.querySelector("[data-heading]");
  refs.subheading = app.querySelector("[data-subheading]");
  refs.list = app.querySelector("[data-move-list]");
  refs.status = app.querySelector("[data-status]");
  refs.addMove = app.querySelector("[data-add-move]");
  refs.save = app.querySelector("[data-save]");
}

function bindUi() {
  refs.addMove.addEventListener("click", () => {
    const direction = editor.selectedDirection;
    const option = editor.actionOptions.find((candidate) => candidate.actionName.includes("combat_Att"))
      || editor.actionOptions[0];
    const move = normalizeCombatMove({
      id: makeMoveId(direction),
      name: "新招式",
      triggerDirection: direction,
      actionFile: option?.fileName || "",
      actionName: option?.actionName || "",
      weight: 10,
      strength: 1,
    }, direction);
    editor.manager.directions[direction].moves.push(move);
    markDirty();
    renderMoves();
    renderSummary();
  });

  refs.save.addEventListener("click", saveCombatMoveManager);

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
    // Static builds do not expose the dev write API.
  }

  const response = await fetch(assetUrl("./assets/animations/motion_config.json"), { cache: "no-store" });
  if (!response.ok) throw new Error(`motion_config.json 加载失败：${response.status}`);
  return response.json();
}

async function loadAnimationAssetFiles(motionConfig = {}) {
  try {
    const response = await fetch("/api/animation-assets", { cache: "no-store" });
    if (response.ok) {
      const payload = await response.json();
      return Array.isArray(payload.files) ? payload.files : [];
    }
  } catch {
    // Static builds do not expose a directory listing.
  }

  return Object.keys(motionConfig || {})
    .filter((actionName) => actionName.startsWith("combat_Att"))
    .map((actionName) => `Anim_${actionName.charAt(0).toUpperCase()}${actionName.slice(1)}.glb`);
}

async function loadCombatMoveManager() {
  try {
    const response = await fetch("/api/combat-move-manager", { cache: "no-store" });
    if (response.ok) return response.json();
  } catch {
    // Static builds use the public JSON file.
  }

  const response = await fetch(assetUrl("./assets/combat/move_manager.json"), { cache: "no-store" });
  if (!response.ok) throw new Error(`move_manager.json 加载失败：${response.status}`);
  return response.json();
}

function buildActionOptions(animationFiles, motionConfig) {
  const options = animationFiles
    .filter((fileName) => fileName.toLowerCase().endsWith(".glb"))
    .map((fileName) => {
      const actionName = findActionNameForAnimationFile(fileName, motionConfig);
      return { actionName, fileName };
    });

  Object.keys(motionConfig)
    .filter((actionName) => !options.some((option) => option.actionName === actionName))
    .forEach((actionName) => {
      if (actionName.startsWith("combat_Att")) {
        options.push({
          actionName,
          fileName: `Anim_${actionName.charAt(0).toUpperCase()}${actionName.slice(1)}.glb`,
        });
      }
    });

  return options
    .filter((option) => option.actionName)
    .sort((a, b) => a.actionName.localeCompare(b.actionName));
}

function renderDirectionTabs() {
  refs.tabs.innerHTML = "";
  COMBAT_MOVE_DIRECTIONS.forEach((direction) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "direction-tab";
    button.dataset.direction = direction.id;
    button.classList.toggle("active", editor.selectedDirection === direction.id);
    button.innerHTML = `
      <span>${direction.label}</span>
      <strong>${direction.key}</strong>
    `;
    button.addEventListener("click", () => {
      editor.selectedDirection = direction.id;
      renderDirectionTabs();
      renderMoves();
    });
    refs.tabs.appendChild(button);
  });
}

function renderMoves() {
  const definition = getDirectionDefinition(editor.selectedDirection);
  const group = editor.manager.directions[editor.selectedDirection];
  refs.heading.textContent = `${definition.label}招式`;
  refs.subheading.textContent = `${definition.key} 键触发的加权招式池`;
  refs.list.innerHTML = "";

  if (!group.moves.length) {
    refs.list.innerHTML = `<div class="empty">当前方向没有可触发招式。</div>`;
    return;
  }

  group.moves.forEach((move, index) => {
    refs.list.appendChild(createMoveRow(move, index));
  });
}

function createMoveRow(move, index) {
  const row = document.createElement("article");
  row.className = "move-row";
  row.dataset.moveId = move.id;
  row.innerHTML = `
    <div class="move-index">${index + 1}</div>
    <label>
      <span>招式名称</span>
      <input data-field="name" type="text" value="${escapeAttr(move.name)}" />
    </label>
    <label>
      <span>触发方向</span>
      <select data-field="triggerDirection">
        ${COMBAT_MOVE_DIRECTIONS.map((direction) => `
          <option value="${direction.id}" ${move.triggerDirection === direction.id ? "selected" : ""}>
            ${direction.label} (${direction.key})
          </option>
        `).join("")}
      </select>
    </label>
    <label class="action-select">
      <span>动作</span>
      <select data-field="actionName">
        ${renderActionOptions(move.actionName)}
      </select>
    </label>
    <label class="number-field">
      <span>权重值</span>
      <input data-field="weight" type="number" min="0" step="1" value="${move.weight}" />
    </label>
    <label class="number-field">
      <span>强度</span>
      <input data-field="strength" type="number" min="0" step="0.05" value="${move.strength}" />
    </label>
    <button type="button" class="delete-btn" data-delete>删除</button>
  `;

  row.querySelectorAll("[data-field]").forEach((input) => {
    input.addEventListener("change", () => updateMoveField(move.id, input.dataset.field, input.value));
    input.addEventListener("input", () => {
      if (input.dataset.field === "name") updateMoveField(move.id, input.dataset.field, input.value, { rerender: false });
    });
  });
  row.querySelector("[data-delete]").addEventListener("click", () => deleteMove(move.id));

  return row;
}

function renderActionOptions(selectedActionName) {
  const hasSelected = editor.actionOptions.some((option) => option.actionName === selectedActionName);
  const options = hasSelected
    ? editor.actionOptions
    : [{ actionName: selectedActionName, fileName: "未在动作文件列表中找到" }, ...editor.actionOptions];

  return options.map((option) => `
    <option value="${escapeAttr(option.actionName)}" ${option.actionName === selectedActionName ? "selected" : ""}>
      ${option.actionName} · ${option.fileName}
    </option>
  `).join("");
}

function updateMoveField(moveId, field, value, { rerender = true } = {}) {
  const move = findMove(moveId);
  if (!move) return;

  if (field === "name") {
    move.name = value;
  } else if (field === "triggerDirection") {
    const nextDirection = normalizeCombatDirection(value);
    move.triggerDirection = nextDirection;
    moveMoveToDirection(move, nextDirection);
  } else if (field === "actionName") {
    move.actionName = value;
    const option = editor.actionOptions.find((candidate) => candidate.actionName === value);
    move.actionFile = option?.fileName || move.actionFile || "";
  } else if (field === "weight") {
    move.weight = Math.max(0, Number(value) || 0);
  } else if (field === "strength") {
    move.strength = Math.max(0, Number(value) || 0);
  }

  markDirty();
  renderSummary();
  if (rerender) {
    renderDirectionTabs();
    renderMoves();
  }
}

function moveMoveToDirection(move, nextDirection) {
  COMBAT_MOVE_DIRECTIONS.forEach((direction) => {
    const moves = editor.manager.directions[direction.id].moves;
    const index = moves.findIndex((candidate) => candidate.id === move.id);
    if (index >= 0) moves.splice(index, 1);
  });
  editor.manager.directions[nextDirection].moves.push(move);
  editor.selectedDirection = nextDirection;
}

function deleteMove(moveId) {
  COMBAT_MOVE_DIRECTIONS.forEach((direction) => {
    const moves = editor.manager.directions[direction.id].moves;
    const index = moves.findIndex((move) => move.id === moveId);
    if (index >= 0) moves.splice(index, 1);
  });
  markDirty();
  renderMoves();
  renderSummary();
}

function findMove(moveId) {
  for (const direction of COMBAT_MOVE_DIRECTIONS) {
    const move = editor.manager.directions[direction.id].moves.find((candidate) => candidate.id === moveId);
    if (move) return move;
  }
  return null;
}

function renderSummary() {
  refs.summary.innerHTML = COMBAT_MOVE_DIRECTIONS.map((direction) => {
    const moves = editor.manager?.directions?.[direction.id]?.moves || [];
    const weight = moves.reduce((sum, move) => sum + (Number(move.weight) || 0), 0);
    return `
      <div>
        <span>${direction.label}</span>
        <strong>${moves.length} 招 / ${weight} 权重</strong>
      </div>
    `;
  }).join("");
}

async function saveCombatMoveManager() {
  try {
    setStatus("保存中...");
    editor.manager = normalizeCombatMoveManager(editor.manager);
    const response = await fetch("/api/combat-move-manager", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editor.manager),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `${response.status} ${response.statusText}`);
    }
    editor.dirty = false;
    renderDirectionTabs();
    renderMoves();
    renderSummary();
    setStatus("已保存到 move_manager.json", "saved");
  } catch (error) {
    console.error(error);
    setStatus(`保存失败：${error.message}`, "bad");
  }
}

function markDirty() {
  editor.dirty = true;
  setStatus("未保存", "dirty");
}

function setStatus(text, variant = "") {
  refs.status.textContent = text;
  refs.status.dataset.variant = variant;
}

function getDirectionDefinition(directionId) {
  return COMBAT_MOVE_DIRECTIONS.find((direction) => direction.id === directionId)
    || COMBAT_MOVE_DIRECTIONS[0];
}

function makeMoveId(direction) {
  const moves = editor.manager?.directions?.[direction]?.moves || [];
  return `move-${direction}-${Date.now().toString(36)}-${moves.length + 1}`;
}

function escapeAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
