const EPSILON = 0.000001;

function asNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function readPosition(entity) {
  const value = entity?.position ?? entity?.pos ?? entity?.worldPosition;
  if (Array.isArray(value) && value.length >= 3) {
    return [asNumber(value[0]), asNumber(value[1]), asNumber(value[2])];
  }
  if (value && typeof value === "object") {
    return [asNumber(value.x), asNumber(value.y), asNumber(value.z)];
  }
  return null;
}

function getEntityAttribute(entity, attribute) {
  if (!entity) return undefined;
  if (entity.attributes && entity.attributes[attribute] !== undefined) return entity.attributes[attribute];
  return entity[attribute];
}

export function readBrainAttribute(context, target, attribute) {
  const self = context?.self ?? {};
  if (attribute === "selfHealth") return getEntityAttribute(self, "health");
  if (attribute === "selfStrength") return getEntityAttribute(self, "strength");
  if (attribute === "attentionToMe") {
    return target?.attentionToMe
      ?? target?.isLookingAtSelf
      ?? target?.perception?.attentionToMe
      ?? target?.perception?.lookingAtSelf
      ?? false;
  }
  return getEntityAttribute(target, attribute);
}

export function compareBrainValue(left, operator, right, selfValue) {
  switch (operator) {
    case "eq":
      return String(left) === String(right);
    case "ne":
      return String(left) !== String(right);
    case "gt":
      return asNumber(left) > asNumber(right);
    case "lt":
      return asNumber(left) < asNumber(right);
    case "gte":
      return asNumber(left) >= asNumber(right);
    case "lte":
      return asNumber(left) <= asNumber(right);
    case "eqSelf":
      return String(left) === String(selfValue);
    case "neSelf":
      return String(left) !== String(selfValue);
    case "truthy":
      return !!left;
    case "falsy":
      return !left;
    default:
      return false;
  }
}

export function evaluateScoringRule(rule, context, target) {
  if (!rule || rule.enabled === false) return { matched: false, score: 0 };
  const conditions = Array.isArray(rule.conditions) && rule.conditions.length > 0
    ? rule.conditions
    : [{ attribute: rule.attribute || "faction", operator: rule.operator || "eq", value: rule.value }];
  const matched = conditions.every((condition) => {
    const attribute = condition.attribute || "faction";
    const left = readBrainAttribute(context, target, attribute);
    const selfValue = readBrainAttribute(context, context?.self, attribute);
    return compareBrainValue(left, condition.operator || "eq", condition.value, selfValue);
  });
  if (!matched) return { matched: false, score: 0 };
  return {
    matched: true,
    scoreTarget: rule.scoreTarget || "dangerScore",
    score: asNumber(rule.score, 0),
    rule,
  };
}

export function scoreVisibleTargets(brain, context = {}) {
  const scoringRules = brain?.scoringRules || [];
  const visibleTargets = context.visibleTargets || [];
  return visibleTargets.map((target) => {
    const result = {
      target,
      targetId: target.id ?? target.name ?? "",
      safeScore: 0,
      dangerScore: 0,
      matchedRules: [],
    };

    for (const rule of scoringRules) {
      const scored = evaluateScoringRule(rule, context, target);
      if (!scored.matched) continue;
      if (scored.scoreTarget === "safeScore") {
        result.safeScore += scored.score;
      } else {
        result.dangerScore += scored.score;
      }
      result.matchedRules.push({
        id: rule.id,
        name: rule.name,
        scoreTarget: scored.scoreTarget,
        score: scored.score,
      });
    }
    return result;
  });
}

export function aggregateBrainScores(targetScores, context = {}) {
  const safeScore = targetScores.reduce((sum, item) => sum + item.safeScore, 0);
  const dangerScore = targetScores.reduce((sum, item) => sum + item.dangerScore, 0);
  const totalScore = safeScore + dangerScore;
  const dangerTargets = targetScores.filter((item) => item.dangerScore > 0);
  const strongestDangerStrength = dangerTargets.reduce((highest, item) => {
    return Math.max(highest, asNumber(getEntityAttribute(item.target, "strength"), 0));
  }, 0);

  return {
    safeScore,
    dangerScore,
    totalScore,
    safeRatio: totalScore > EPSILON ? safeScore / totalScore : 0,
    dangerRatio: totalScore > EPSILON ? dangerScore / totalScore : 0,
    visibleTargetCount: targetScores.length,
    dangerTargetCount: dangerTargets.length,
    highestDangerScore: dangerTargets.reduce((highest, item) => Math.max(highest, item.dangerScore), 0),
    strongestDangerStrength,
    selfHealth: asNumber(getEntityAttribute(context.self, "health"), 0),
    targetAngleDeltaDegrees: asNumber(context.blackboard?.targetAngleDeltaDegrees, 0),
    targetDistance: asNumber(context.blackboard?.targetDistance, 999999),
  };
}

export function decideBehaviorMode(brain, aggregate) {
  const decisionRules = (brain?.decisionRules || [])
    .filter((rule) => rule.enabled !== false)
    .slice()
    .sort((a, b) => asNumber(a.priority, 100) - asNumber(b.priority, 100));

  for (const rule of decisionRules) {
    const conditions = Array.isArray(rule.conditions) && rule.conditions.length > 0
      ? rule.conditions
      : [{ metric: rule.metric || "dangerRatio", operator: rule.operator || "gte", value: rule.value }];
    const matched = conditions.every((condition) => {
      const metricValue = aggregate[condition.metric || "dangerRatio"];
      return compareBrainValue(metricValue, condition.operator || "gte", condition.value, undefined);
    });
    if (matched) {
      return {
        mode: rule.outputMode || "default",
        rule,
      };
    }
  }

  return { mode: brain?.fallbackMode || "default", rule: null };
}

function subtractPositions(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function normalizeXZ(vector) {
  const length = Math.hypot(vector[0], vector[2]);
  if (length <= EPSILON) return [0, 0, 1];
  return [vector[0] / length, 0, vector[2] / length];
}

function addScaledPosition(origin, direction, scale) {
  return [
    origin[0] + direction[0] * scale,
    origin[1],
    origin[2] + direction[2] * scale,
  ];
}

export function resolveBlackboard(brain, targetScores, context = {}) {
  const dangerTargets = targetScores
    .filter((item) => item.dangerScore > 0)
    .slice()
    .sort((a, b) => b.dangerScore - a.dangerScore);
  const highestDanger = dangerTargets[0] ?? null;
  const weakestDanger = dangerTargets
    .slice()
    .sort((a, b) => {
      const strengthA = asNumber(getEntityAttribute(a.target, "strength"), 0);
      const strengthB = asNumber(getEntityAttribute(b.target, "strength"), 0);
      return strengthA - strengthB;
    })[0] ?? null;

  const selfPosition = readPosition(context.self);
  const highestDangerPosition = readPosition(highestDanger?.target);
  const fleeDistance = asNumber(brain?.blackboardSources?.fleeFromHighestDanger?.distance, 8);
  let fleePosition = null;
  if (selfPosition && highestDangerPosition) {
    const away = normalizeXZ(subtractPositions(selfPosition, highestDangerPosition));
    fleePosition = addScaledPosition(selfPosition, away, fleeDistance);
  }

  return {
    highestDangerTarget: highestDanger?.target ?? null,
    weakestDangerTarget: weakestDanger?.target ?? null,
    lookTarget: context.blackboard?.lookTarget ?? highestDanger?.target ?? null,
    lockedTarget: context.blackboard?.lockedTarget ?? context.blackboard?.lookTarget ?? weakestDanger?.target ?? null,
    randomPosition: context.blackboard?.randomPosition ?? null,
    targetAngleDeltaDegrees: context.blackboard?.targetAngleDeltaDegrees ?? null,
    targetDistance: context.blackboard?.targetDistance ?? null,
    fleePosition,
    selfPosition,
  };
}

export function evaluateNpcBrain(behaviorTree, context = {}) {
  const brain = behaviorTree?.brain || {};
  const targetScores = scoreVisibleTargets(brain, context);
  const aggregate = aggregateBrainScores(targetScores, context);
  const decision = decideBehaviorMode(brain, aggregate);
  const blackboard = resolveBlackboard(brain, targetScores, context);

  return {
    mode: decision.mode,
    decisionRule: decision.rule,
    targetScores,
    aggregate,
    blackboard,
  };
}
