export const ATTRIBUTE_DEFS = [
  { key: "name",      label: "名字",   type: "string", default: "",    min: 0, max: 0 },
  { key: "willpower", label: "意志力", type: "number", default: 10,   min: 0, max: 100 },
  { key: "health",    label: "生命值", type: "number", default: 100,  min: 1, max: 9999 },
  { key: "stamina",   label: "体力",   type: "number", default: 100,  min: 0, max: 9999 },
  { key: "strength",  label: "强壮度", type: "number", default: 10,   min: 0, max: 100 },
  { key: "agility",   label: "敏捷",   type: "number", default: 10,   min: 0, max: 100 },
  { key: "reaction",  label: "反应",   type: "number", default: 10,   min: 0, max: 100 },
];

export const FACTION_TYPES = [
  { key: 0, label: "江湖" },
  { key: 1, label: "秩序" },
  { key: 2, label: "混乱" },
];

export const MODEL_TYPES = [
  { key: "BaseMale",   label: "男主角" },
  { key: "BaseFemale", label: "女主角" },
];

export const NPC_TYPE_OPTIONS = [
  { key: "friendly", label: "友好" },
  { key: "hostile",  label: "敌对" },
];

export const GENDER_OPTIONS = [
  { key: "male",   label: "男" },
  { key: "female", label: "女" },
];

export const BRAIN_INPUT_ATTRIBUTES = [
  { key: "name",      label: "名字",   type: "string" },
  { key: "health",    label: "生命值", type: "number" },
  { key: "stamina",   label: "体力",   type: "number" },
  { key: "strength",  label: "强壮度", type: "number" },
  { key: "agility",   label: "敏捷",   type: "number" },
  { key: "reaction",  label: "反应",   type: "number" },
  { key: "faction",   label: "阵营",   type: "number" },
  { key: "gender",    label: "性别",   type: "string" },
  { key: "distance",  label: "距离",   type: "number" },
];

export const BRAIN_OPERATORS = [
  { key: "eq", label: "等于 (=)" },
  { key: "ne", label: "不等于 (!=)" },
  { key: "gt", label: "大于 (>)" },
  { key: "lt", label: "小于 (<)" },
  { key: "gte", label: "大于等于 (>=)" },
  { key: "lte", label: "小于等于 (<=)" },
];

export const BRAIN_OUTPUT_TYPES = [
  { key: "switchState",     label: "状态切换" },
  { key: "setMoveTarget",   label: "设置移动目标" },
  { key: "setLookTarget",   label: "设置注视目标" },
  { key: "setAttackTarget", label: "设置攻击目标" },
  { key: "modifyCooldown",  label: "修改冷却时间" },
];

export const BEHAVIOR_NODE_TYPES = [
  { key: "walk",            label: "行走",     icon: "🚶" },
  { key: "lookAt",          label: "注视目标", icon: "👁" },
  { key: "stateTransition", label: "状态转换", icon: "🔄" },
  { key: "move",            label: "战斗移动", icon: "⚔" },
  { key: "attack",          label: "攻击",     icon: "💥" },
];

export const TRANSITION_CONDITION_TYPES = [
  { key: "always",              label: "总是" },
  { key: "targetDead",          label: "目标生命值为0" },
  { key: "targetDistance",      label: "目标超过距离" },
  { key: "targetStrengthChange", label: "目标实力大幅提升" },
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
