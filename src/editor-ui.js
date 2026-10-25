import createElement from "lucide/dist/esm/createElement.mjs";
import play from "lucide/dist/esm/icons/play.mjs";
import pause from "lucide/dist/esm/icons/pause.mjs";
import square from "lucide/dist/esm/icons/square.mjs";
import save from "lucide/dist/esm/icons/save.mjs";
import grid from "lucide/dist/esm/icons/grid-2x2.mjs";
import bone from "lucide/dist/esm/icons/bone.mjs";
import plus from "lucide/dist/esm/icons/plus.mjs";
import trash from "lucide/dist/esm/icons/trash.mjs";
import refreshIcon from "lucide/dist/esm/icons/refresh-cw.mjs";
import x from "lucide/dist/esm/icons/x.mjs";
import sun from "lucide/dist/esm/icons/sun.mjs";
import sunDim from "lucide/dist/esm/icons/sun-dim.mjs";
import mountain from "lucide/dist/esm/icons/mountain.mjs";
import paintbrush from "lucide/dist/esm/icons/paintbrush.mjs";
import pointer from "lucide/dist/esm/icons/mouse-pointer-2.mjs";
import arrowUp from "lucide/dist/esm/icons/arrow-up.mjs";
import arrowDown from "lucide/dist/esm/icons/arrow-down.mjs";
import equal from "lucide/dist/esm/icons/equal.mjs";
import eraser from "lucide/dist/esm/icons/eraser.mjs";
import rotateCcw from "lucide/dist/esm/icons/rotate-ccw.mjs";
import move from "lucide/dist/esm/icons/move.mjs";
import rotateCw from "lucide/dist/esm/icons/rotate-cw.mjs";
import scaling from "lucide/dist/esm/icons/scaling.mjs";
import undo from "lucide/dist/esm/icons/undo-2.mjs";
import redo from "lucide/dist/esm/icons/redo-2.mjs";
import zoomIn from "lucide/dist/esm/icons/zoom-in.mjs";
import zoomOut from "lucide/dist/esm/icons/zoom-out.mjs";
import box from "lucide/dist/esm/icons/box.mjs";
import alert from "lucide/dist/esm/icons/circle-alert.mjs";
import brain from "lucide/dist/esm/icons/brain.mjs";
import scan from "lucide/dist/esm/icons/scan.mjs";

const icons = {
  play, pause, square, save, "grid-2x2": grid, bone, plus, "trash-2": trash,
  "refresh-cw": refreshIcon, x, sun, "sun-dim": sunDim, mountain, paintbrush,
  "mouse-pointer-2": pointer, "arrow-up": arrowUp, "arrow-down": arrowDown,
  equal, eraser, "rotate-ccw": rotateCcw, move, "rotate-cw": rotateCw,
  scaling, "undo-2": undo, "redo-2": redo, "zoom-in": zoomIn,
  "zoom-out": zoomOut, box, "circle-alert": alert, brain, scan,
};

const tools = [
  ["[data-play]", "play", "播放"],
  ["[data-pause]", "pause", "暂停"],
  ["[data-stop]", "square", "归零"],
  ["[data-save], [data-btn-save], [data-save-scene2], .save-button", "save", "保存"],
  [".reset-button, [data-reset]", "rotate-ccw", "重置"],
  ["[data-add-action], [data-new-npc], [data-new-scene], [data-new-tree-btn]", "plus", "新建"],
  [".delete-action-button, .delete-npc-button, .delete-scene-button, .delete-tree-button, .delete-obj-button", "trash-2", "删除"],
  ["[data-toggle-ground]", "square", "地面"],
  ["[data-toggle-grid], [data-toggle-wireframe]", "grid-2x2", "网格"],
  ["[data-toggle-skeleton]", "bone", "骨骼"],
  ["[data-toggle-attack]", "box", "攻击盒"],
  ['[data-transform-mode="translate"]', "move", "移动"],
  ['[data-transform-mode="rotate"]', "rotate-cw", "旋转"],
  ['[data-transform-mode="scale"]', "scaling", "缩放"],
  ["[data-undo]", "undo-2", "撤销"],
  ["[data-redo]", "redo-2", "重做"],
  ["[data-zoom-in]", "zoom-in", "放大"],
  ["[data-zoom-out]", "zoom-out", "缩小"],
];
const simpleCommands = new Map([
  ["播放", "play"], ["暂停", "pause"], ["停止", "square"],
  ["保存", "save"], ["重置", "rotate-ccw"], ["Reset", "rotate-ccw"],
  ["新建", "plus"], ["新增", "plus"], ["添加", "plus"],
  ["删除", "trash-2"], ["删", "trash-2"], ["刷新", "refresh-cw"],
]);
const state = new WeakMap();
let observer;
let initialized = false;
let queued = false;
let tooltip;
let tooltipTarget;
let focusTarget;
let hoverTarget;

function setAttribute(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function decorate(element, fallbackIcon, fallbackLabel) {
  const previous = state.get(element);
  const text = element.textContent.trim();
  let name = element.dataset.icon || previous?.name || fallbackIcon;
  if (element.matches("[data-play]") && text) {
    if (text === "暂停" || text === "Pause") name = "pause";
    if (text === "播放" || text === "Play") name = "play";
  }
  if (!icons[name]) return;
  const ariaLabel = element.getAttribute("aria-label");
  const externalLabel = ariaLabel !== previous?.label ? ariaLabel : "";
  const label = element.dataset.label || externalLabel || text || previous?.baseLabel || fallbackLabel || name;
  const dirty = name === "save" && (element.classList.contains("dirty") || element.dataset.dirty === "true" || text.includes("*"));
  const accessibleLabel = dirty && !/[＊*未]/.test(label) ? `${label} *` : label;
  const isButton = element.tagName === "BUTTON";
  if (isButton) element.classList.add("editor-icon-button");
  setAttribute(element, "aria-label", accessibleLabel);
  const title = previous && element.title === previous.title ? accessibleLabel : (element.title || accessibleLabel);
  setAttribute(element, "title", title);
  setAttribute(element, "data-tooltip", title);
  if (isButton && (element.matches(".toggle-button, [data-transform-mode], [data-terrain-tool], [data-color-tool], [data-edit-mode]") || element.hasAttribute("aria-pressed"))) {
    setAttribute(element, "aria-pressed", String(element.classList.contains("active") || element.classList.contains("active-tool")));
  }
  const rendered = element.firstElementChild;
  if (!previous || previous.name !== name || element.childNodes.length !== 1 || rendered?.getAttribute("data-editor-icon") !== name) {
    const svg = createElement(icons[name], {
      width: 18, height: 18, "aria-hidden": "true", focusable: "false",
      class: "lucide editor-ui-icon", "data-editor-icon": name,
      style: "pointer-events:none",
    });
    element.replaceChildren(svg);
  }
  state.set(element, { name, label: accessibleLabel, baseLabel: label, title });
}

function refresh() {
  // Disconnect during decoration so our SVG and accessibility writes never feed back.
  observer?.disconnect();
  try {
    document.querySelectorAll("button, [data-icon]").forEach((element) => {
      if (element.closest("svg, #editor-ui-tooltip")) return;
      if (element.dataset.icon) {
        decorate(element);
        return;
      }
      const tool = tools.find(([selector]) => element.matches(selector));
      if (tool) decorate(element, tool[1], tool[2]);
      else if (state.has(element)) decorate(element);
      else if (element.tagName === "BUTTON" && element.children.length === 0) {
        const text = element.textContent.trim();
        if (simpleCommands.has(text)) decorate(element, simpleCommands.get(text), text);
      }
    });
    if (tooltipTarget && (!tooltipTarget.isConnected || tooltipTarget.disabled)) hideTooltip();
    else if (tooltipTarget && !tooltip.hidden && tooltip.textContent !== tooltipTarget.dataset.tooltip) showTooltip(tooltipTarget);
  } finally {
    observer?.observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["class", "data-icon", "data-label", "data-dirty", "aria-label", "aria-pressed", "disabled"],
    });
  }
}

function hideTooltip() {
  if (!tooltip) return;
  tooltip.hidden = true;
  if (tooltipTarget) {
    const ids = (tooltipTarget.getAttribute("aria-describedby") || "").split(/\s+/).filter((id) => id && id !== tooltip.id);
    if (ids.length) tooltipTarget.setAttribute("aria-describedby", ids.join(" "));
    else tooltipTarget.removeAttribute("aria-describedby");
  }
  tooltipTarget = null;
}

function showTooltip(element) {
  hideTooltip();
  if (!element || element.disabled || !element.dataset.tooltip) return;
  tooltipTarget = element;
  tooltip.textContent = element.dataset.tooltip;
  tooltip.hidden = false;
  const rect = element.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const margin = 8;
  const left = Math.max(margin, Math.min(rect.left + (rect.width - width) / 2, window.innerWidth - width - margin));
  let top = rect.bottom + margin;
  if (top + height > window.innerHeight - margin) top = rect.top - height - margin;
  if (top < margin) {
    top = margin;
    const side = rect.right + margin;
    tooltip.style.left = `${side + width <= window.innerWidth - margin ? side : Math.max(margin, rect.left - width - margin)}px`;
  } else tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  const ids = new Set((element.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
  ids.add(tooltip.id);
  element.setAttribute("aria-describedby", [...ids].join(" "));
}

function syncTooltip() {
  const target = focusTarget || hoverTarget;
  if (target === tooltipTarget && !tooltip.hidden) return;
  showTooltip(target);
}

export function iconButton(button, iconName, label) {
  if (iconName) button.dataset.icon = iconName;
  if (label) button.dataset.label = label;
  decorate(button);
  return button;
}

export function initializeEditorUi() {
  document.body.dataset.editorTheme = "codex";
  if (initialized) {
    refresh();
    return;
  }
  initialized = true;
  tooltip = document.getElementById("editor-ui-tooltip") || document.createElement("div");
  tooltip.id = "editor-ui-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  tooltip.style.position = "fixed";
  tooltip.style.pointerEvents = "none";
  document.body.append(tooltip);
  observer = new MutationObserver((records) => {
    if (tooltipTarget && !tooltipTarget.isConnected) hideTooltip();
    if (focusTarget && !focusTarget.isConnected) focusTarget = null;
    if (hoverTarget && !hoverTarget.isConnected) hoverTarget = null;
    if (queued) return;
    const affectsTools = records.some((record) => {
      if (tooltip.contains(record.target)) return false;
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (target?.closest("button, [data-icon]")) return true;
      if (record.type !== "childList") return false;
      return [...record.addedNodes, ...record.removedNodes].some((node) =>
        node.nodeType === 1 && (node.matches("button, [data-icon]") || node.querySelector("button, [data-icon]")));
    });
    if (!affectsTools) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      refresh();
    });
  });
  document.addEventListener("pointerover", (event) => {
    hoverTarget = event.target.closest?.("[data-tooltip]");
    syncTooltip();
  });
  document.addEventListener("pointerout", (event) => {
    hoverTarget = event.relatedTarget?.closest?.("[data-tooltip]");
    syncTooltip();
  });
  document.addEventListener("focusin", (event) => {
    focusTarget = event.target.closest?.("[data-tooltip]");
    syncTooltip();
  });
  document.addEventListener("focusout", (event) => {
    focusTarget = event.relatedTarget?.closest?.("[data-tooltip]");
    syncTooltip();
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hideTooltip(); });
  document.addEventListener("scroll", hideTooltip, true);
  window.addEventListener("resize", hideTooltip);
  refresh();
}
