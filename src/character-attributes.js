export const ATTRIBUTE_DEFS = [
  { key: "name", label: "名字", type: "string", default: "", min: 0, max: 0 },
  { key: "willpower", label: "意志力", type: "number", default: 10, min: 0, max: 100 },
  { key: "health", label: "生命值", type: "number", default: 100, min: 1, max: 9999 },
  { key: "stamina", label: "体力", type: "number", default: 100, min: 0, max: 9999 },
  { key: "strength", label: "强壮度", type: "number", default: 10, min: 0, max: 100 },
  { key: "agility", label: "敏捷", type: "number", default: 10, min: 0, max: 100 },
  { key: "reaction", label: "反应", type: "number", default: 10, min: 0, max: 100 },
];

export const FACTION_TYPES = [
  { key: 0, label: "江湖" },
  { key: 1, label: "秩序" },
  { key: 2, label: "混乱" },
  { key: 3, label: "中立" },
];

export const MODEL_TYPES = [
  { key: "BaseMale", label: "男角色" },
  { key: "BaseFemale", label: "女角色" },
];

export const NPC_TYPE_OPTIONS = [
  { key: "friendly", label: "友好" },
  { key: "hostile", label: "敌对" },
];

export const GENDER_OPTIONS = [
  { key: "male", label: "男" },
  { key: "female", label: "女" },
];

export const BRAIN_INPUT_ATTRIBUTES = [
  { key: "faction", label: "目标阵营", type: "number" },
  { key: "health", label: "目标生命", type: "number" },
  { key: "stamina", label: "目标体力", type: "number" },
  { key: "strength", label: "目标强壮度", type: "number" },
  { key: "agility", label: "目标敏捷", type: "number" },
  { key: "reaction", label: "目标反应", type: "number" },
  { key: "distance", label: "目标距离", type: "number" },
  { key: "attentionToMe", label: "注视我", type: "boolean" },
  { key: "selfHealth", label: "自身生命", type: "number" },
  { key: "selfStrength", label: "自身强壮度", type: "number" },
];

export const BRAIN_OPERATORS = [
  { key: "eq", label: "等于 =" },
  { key: "ne", label: "不等于 !=" },
  { key: "gt", label: "大于 >" },
  { key: "lt", label: "小于 <" },
  { key: "gte", label: "大于等于 >=" },
  { key: "lte", label: "小于等于 <=" },
  { key: "eqSelf", label: "等于自身" },
  { key: "neSelf", label: "不等于自身" },
  { key: "truthy", label: "为真" },
  { key: "falsy", label: "为假" },
];

export const BRAIN_SCORE_TARGET_TYPES = [
  { key: "safeScore", label: "安全分" },
  { key: "dangerScore", label: "危险分" },
];

export const BRAIN_DECISION_METRICS = [
  { key: "safeScore", label: "安全总分", valueType: "number" },
  { key: "dangerScore", label: "危险总分", valueType: "number" },
  { key: "safeRatio", label: "安全占比", valueType: "percent" },
  { key: "dangerRatio", label: "危险占比", valueType: "percent" },
  { key: "visibleTargetCount", label: "可见目标数量", valueType: "number" },
  { key: "dangerTargetCount", label: "危险目标数量", valueType: "number" },
  { key: "highestDangerScore", label: "最高危险分", valueType: "number" },
  { key: "strongestDangerStrength", label: "危险目标最高强壮度", valueType: "number" },
  { key: "selfHealth", label: "自身生命", valueType: "number" },
];

export const BEHAVIOR_MODE_TYPES = [
  { key: "default", label: "默认", description: "无明确威胁时的日常行为" },
  { key: "alert", label: "警惕", description: "发现风险但尚未进入战斗" },
  { key: "attack", label: "攻击", description: "锁定目标并执行攻击链" },
  { key: "flee", label: "逃跑", description: "远离最高危险目标" },
];

export const TARGET_SELECTOR_TYPES = [
  { key: "none", label: "无" },
  { key: "highestDanger", label: "危险值最高者" },
  { key: "weakestDanger", label: "危险值非 0 且强壮度最低者" },
  { key: "lookTarget", label: "注视目标" },
  { key: "lockedTarget", label: "锁定目标" },
  { key: "randomPosition", label: "Random Pos" },
  { key: "fleeFromHighestDanger", label: "危险最高者反向点" },
  { key: "selfPosition", label: "自身位置" },
];

export const NODE_DATA_REQUIREMENTS = {
  walk: [{ key: "destinationPos", label: "目的地 Pos", defaultSource: "randomPosition" }],
  lookAt: [{ key: "targetPos", label: "目标 Pos", defaultSource: "highestDanger" }],
  lockTarget: [{ key: "targetPos", label: "目标 Pos", defaultSource: "lookTarget" }],
  move: [{ key: "destinationPos", label: "目的地 Pos", defaultSource: "randomPosition" }],
  run: [{ key: "destinationPos", label: "目的地 Pos", defaultSource: "fleeFromHighestDanger" }],
  attack: [{ key: "targetPos", label: "目标 Pos", defaultSource: "lockedTarget" }],
};

export const BRAIN_OUTPUT_TYPES = [
  { key: "setBehaviorMode", label: "设置行为模式" },
  { key: "switchState", label: "状态切换" },
  { key: "setMoveTarget", label: "设置移动目标" },
  { key: "setLookTarget", label: "设置注视目标" },
  { key: "setAttackTarget", label: "设置攻击目标" },
  { key: "modifyCooldown", label: "修改冷却时间" },
];

export const BEHAVIOR_NODE_TYPES = [
  { key: "walk", label: "随机走", icon: "" },
  { key: "lookAt", label: "注视", icon: "" },
  { key: "lockTarget", label: "锁定", icon: "" },
  { key: "move", label: "移动", icon: "" },
  { key: "run", label: "跑动", icon: "" },
  { key: "attack", label: "攻击", icon: "" },
  { key: "stateTransition", label: "状态切换", icon: "" },
];

export const TRANSITION_CONDITION_TYPES = [
  { key: "always", label: "总是" },
  { key: "targetDead", label: "目标生命为 0" },
  { key: "targetDistance", label: "目标超过距离" },
  { key: "targetStrengthChange", label: "目标强壮度大幅提升" },
  { key: "brainModeChanged", label: "大脑模式变化" },
];

export const VISION_DEFAULTS = { distance: 15, angle: 120 };

export const MOVE_SPEED_DEFAULTS = { normal: 2.0, combat: 1.2 };

export function getDefaultAttributes() {
  const attrs = {};
  for (const def of ATTRIBUTE_DEFS) {
    attrs[def.key] = def.default;
  }
  return attrs;
}

export function getAttributeDefs() {
  return ATTRIBUTE_DEFS;
}

export function getFactionTypes() {
  return FACTION_TYPES;
}

export function getModelTypes() {
  return MODEL_TYPES;
}
