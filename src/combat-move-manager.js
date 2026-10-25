export const COMBAT_MOVE_DIRECTIONS = [
  { id: "forward", label: "前向", key: "W", inputCode: "KeyW" },
  { id: "leftForward", label: "左前", key: "W+A" },
  { id: "left", label: "左向", key: "A", inputCode: "KeyA" },
  { id: "leftBack", label: "左后", key: "S+A" },
  { id: "back", label: "后向", key: "S", inputCode: "KeyS" },
  { id: "rightBack", label: "右后", key: "S+D" },
  { id: "right", label: "右向", key: "D", inputCode: "KeyD" },
  { id: "rightForward", label: "右前", key: "W+D" },
];

export const DEFAULT_HITSTUN_DURATION = 0.3;
export const COMBAT_MOVE_DIRECTION_IDS = COMBAT_MOVE_DIRECTIONS.map((direction) => direction.id);

export const DEFAULT_COMBAT_MOVE_MANAGER = {
  version: 1,
  directions: {
    forward: {
      id: "forward",
      label: "前向",
      key: "W",
      moves: [
        {
          id: "move-forward-hand-1",
          name: "前向手击一式",
          triggerDirection: "forward",
          actionFile: "Anim_Combat_Att_F_Hand_1.glb",
          actionName: "combat_Att_F_Hand_1",
          weight: 60,
          strength: 1,
          hitWindows: [],
          impact: createDefaultMoveImpact(),
        },
        {
          id: "move-forward-hand-1-ro",
          name: "前向回身手击",
          triggerDirection: "forward",
          actionFile: "Anim_Combat_Att_F_Hand_1_Ro.glb",
          actionName: "combat_Att_F_Hand_1_Ro",
          weight: 25,
          strength: 1.15,
          hitWindows: [],
          impact: createDefaultMoveImpact(),
        },
        {
          id: "move-forward-hand-2",
          name: "前向手击二式",
          triggerDirection: "forward",
          actionFile: "Anim_Combat_Att_F_Hand_2.glb",
          actionName: "combat_Att_F_Hand_2",
          weight: 15,
          strength: 1.3,
          hitWindows: [],
          impact: createDefaultMoveImpact(),
        },
      ],
    },
    left: {
      id: "left",
      label: "左向",
      key: "A",
      moves: [
        {
          id: "move-left-back-hand-0",
          name: "左向手击",
          triggerDirection: "left",
          actionFile: "Anim_Combat_Att_LB_Hand_0.glb",
          actionName: "combat_Att_LB_Hand_0",
          weight: 100,
          strength: 1,
          hitWindows: [],
          impact: createDefaultMoveImpact(),
        },
      ],
    },
    right: {
      id: "right",
      label: "右向",
      key: "D",
      moves: [
        {
          id: "move-right-back-hand-0",
          name: "右向手击",
          triggerDirection: "right",
          actionFile: "Anim_Combat_Att_RB_Hand_0.glb",
          actionName: "combat_Att_RB_Hand_0",
          weight: 100,
          strength: 1,
          hitWindows: [],
          impact: createDefaultMoveImpact(),
        },
      ],
    },
  },
};

let uidCounter = 0;

export function uid(prefix = "move") {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}`;
}

export function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeCombatMoveManager(value = {}) {
  const sourceDirections = value?.directions && typeof value.directions === "object"
    ? value.directions
    : {};
  const normalized = {
    version: 2,
    directions: {},
  };

  COMBAT_MOVE_DIRECTIONS.forEach((definition) => {
    const source = sourceDirections[definition.id] || {};
    const moves = Array.isArray(source.moves) ? source.moves : [];
    normalized.directions[definition.id] = {
      id: definition.id,
      label: source.label || definition.label,
      key: source.key || definition.key,
      defaultMoveId: String(source.defaultMoveId || ""),
      moves: moves.map((move, index) => normalizeCombatMove(move, definition.id, index)),
    };
  });

  return normalized;
}

export function normalizeCombatMove(move = {}, fallbackDirection = "forward", index = 0) {
  const direction = normalizeCombatDirection(move.triggerDirection || fallbackDirection);
  const actionName = String(move.actionName || "").trim();
  const actionFile = String(move.actionFile || "").trim();
  return {
    id: String(move.id || uid(`move-${direction}`)),
    name: String(move.name || `招式 ${index + 1}`),
    triggerDirection: direction,
    actionFile,
    actionName,
    weight: normalizePositiveNumber(move.weight, 1),
    strength: normalizePositiveNumber(move.strength, 1),
    blockable: move.blockable !== false,
    hitWindows: normalizeHitWindows(move.hitWindows),
    impact: normalizeMoveImpact(move.impact),
  };
}

export function createDefaultMoveImpact() {
  return {
    knockback: {
      customDirection: false,
      directionDegrees: 0,
    },
    hitstun: {
      enabled: false,
      hitActionName: "",
      duration: DEFAULT_HITSTUN_DURATION,
    },
  };
}

export function createDefaultHitWindow() {
  return {
    id: uid("hit-window"),
    name: "攻击判定",
    start: 0,
    end: 0.2,
    modelBindings: [],
  };
}

export function createDefaultHitModelBinding(modelId = "") {
  return {
    modelId,
    attackColliderIds: [],
  };
}

export function normalizeHitWindows(value) {
  const windows = Array.isArray(value) ? value : [];
  return windows.map((window, index) => normalizeHitWindow(window, index)).filter(Boolean);
}

export function normalizeHitWindow(value = {}, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const start = normalizePositiveNumber(value.start, 0);
  const end = normalizePositiveNumber(value.end, start);
  return {
    id: String(value.id || uid("hit-window")),
    name: String(value.name || `攻击判定 ${index + 1}`),
    start: Math.min(start, end),
    end: Math.max(start, end),
    modelBindings: normalizeHitModelBindings(value.modelBindings),
  };
}

export function normalizeHitModelBindings(value) {
  const bindings = Array.isArray(value) ? value : [];
  return bindings.map((binding) => normalizeHitModelBinding(binding)).filter(Boolean);
}

export function normalizeHitModelBinding(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const modelId = String(value.modelId || "").trim();
  return {
    modelId,
    attackColliderIds: Array.isArray(value.attackColliderIds)
      ? [...new Set(value.attackColliderIds.map((id) => String(id || "").trim()).filter(Boolean))]
      : [],
  };
}

export function normalizeMoveImpact(value = {}) {
  const knockback = value?.knockback || {};
  const hitstun = value?.hitstun || {};
  return {
    knockback: {
      customDirection: !!knockback.customDirection,
      directionDegrees: normalizeSignedNumber(knockback.directionDegrees, 0),
    },
    hitstun: {
      enabled: !!hitstun.enabled,
      hitActionName: String(hitstun.hitActionName || ""),
      duration: normalizePositiveNumber(hitstun.duration, DEFAULT_HITSTUN_DURATION),
    },
  };
}

export function normalizeCombatDirection(value) {
  if (COMBAT_MOVE_DIRECTION_IDS.includes(value)) return value;
  return "forward";
}

export function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function normalizeSignedNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function getCombatMovesForDirection(manager, direction) {
  const normalizedDirection = normalizeCombatDirection(direction);
  const normalized = normalizeCombatMoveManager(manager);
  return Object.values(normalized.directions)
    .flatMap((group) => group.moves)
    .filter((move) => move.triggerDirection === normalizedDirection && move.actionName);
}

export function getAllCombatMoves(manager) {
  const normalized = normalizeCombatMoveManager(manager);
  return Object.values(normalized.directions).flatMap((group) => group.moves);
}

export function getCombatMoveActionNames(manager) {
  return [...new Set(getAllCombatMoves(manager).map((move) => move.actionName).filter(Boolean))];
}

export function chooseWeightedCombatMove(moves, random = Math.random) {
  const candidates = moves.filter((move) => move.actionName && move.weight > 0);
  if (!candidates.length) return null;

  const totalWeight = candidates.reduce((sum, move) => sum + move.weight, 0);
  let roll = random() * totalWeight;
  for (const move of candidates) {
    roll -= move.weight;
    if (roll <= 0) return move;
  }
  return candidates[candidates.length - 1] ?? null;
}

export function selectCombatMove(manager, direction, available, preferredMove = null, random = Math.random) {
  const moves = getCombatMovesForDirection(manager, direction).filter(available);
  const weighted = chooseWeightedCombatMove(moves, random);
  if (weighted) return weighted;
  const defaultId = manager?.directions?.[direction]?.defaultMoveId;
  return moves.find((move) => move.id === defaultId)
    || moves.find((move) => move.id === preferredMove?.id) || moves[0] || null;
}

export function actionNameFromAnimationFile(fileName) {
  const baseName = String(fileName || "").replace(/\.glb$/i, "");
  const withoutPrefix = baseName.replace(/^Anim[_-]?/i, "");
  return normalizeActionName(withoutPrefix);
}

export function normalizeActionName(value) {
  const words = String(value || "")
    .replace(/\.glb$/i, "")
    .replace(/^Anim[_-]?/i, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (!words.length) return "";

  return words
    .map((word, index) => {
      if (index === 0) return word.charAt(0).toLowerCase() + word.slice(1);
      if (/^\d+$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join("_");
}

export function canonicalActionKey(value) {
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

export function findActionNameForAnimationFile(fileName, motionConfig = {}) {
  const derivedName = actionNameFromAnimationFile(fileName);
  if (motionConfig[derivedName]) return derivedName;

  const derivedKey = canonicalActionKey(derivedName);
  return Object.keys(motionConfig).find((actionName) => canonicalActionKey(actionName) === derivedKey)
    || derivedName;
}

export function inferAnimationFileForActionName(actionName, availableFiles = [], motionConfig = {}) {
  const actionKey = canonicalActionKey(actionName);
  const exactFile = availableFiles.find((fileName) => {
    const candidate = findActionNameForAnimationFile(fileName, motionConfig);
    return canonicalActionKey(candidate) === actionKey;
  });
  if (exactFile) return exactFile;

  if (/^combat[_A-Z0-9]/i.test(actionName)) {
    const animationName = actionName.charAt(0).toUpperCase() + actionName.slice(1);
    return `Anim_${animationName}.glb`;
  }

  return null;
}
