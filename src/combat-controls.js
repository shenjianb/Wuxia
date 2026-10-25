export const ATTACK_KEYS = { KeyW: [0, 1], KeyA: [-1, 0], KeyS: [0, -1], KeyD: [1, 0] };
export const FACING_KEYS = { ArrowUp: [0, 1], ArrowLeft: [-1, 0], ArrowDown: [0, -1], ArrowRight: [1, 0] };
export const RELATIVE_DIRECTIONS = ["forward", "leftForward", "left", "leftBack", "back", "rightBack", "right", "rightForward"];

export function shortestAngle(from, to) {
  const angle = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return Math.abs(Math.abs(angle) - Math.PI) < 1e-9 ? Math.PI : angle;
}

export function stepFacing(from, to, delta, speed = 5.5) {
  const gap = shortestAngle(from, to);
  const step = Math.min(Math.abs(gap), Math.max(0, delta * speed));
  return from + Math.sign(gap) * step;
}

export function relativeAttackDirection(worldYaw, bodyYaw) {
  const sector = Math.round(shortestAngle(bodyYaw, worldYaw) / (Math.PI / 4));
  return RELATIVE_DIRECTIONS[(sector + 8) % 8];
}

export function keyAxis(keys, definitions) {
  let x = 0, y = 0;
  for (const code of keys) {
    const axis = definitions[code];
    if (axis) { x += axis[0]; y += axis[1]; }
  }
  return x || y ? { x: Math.sign(x), y: Math.sign(y) } : null;
}

export function createAttackChord() {
  return { held: new Set(), direction: null };
}

// Keep the latest non-neutral chord while releasing its constituent keys.
export function updateAttackChord(chord, code, down) {
  if (!ATTACK_KEYS[code]) return null;
  if (down) {
    if (chord.held.has(code)) return null;
    if (!chord.held.size) chord.direction = null;
    chord.held.add(code);
    chord.direction = keyAxis(chord.held, ATTACK_KEYS);
    return null;
  }
  if (!chord.held.delete(code) || chord.held.size) return null;
  const result = chord.direction;
  chord.direction = null;
  return result;
}

export function normalizeInterruptWindow(value) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) return null;
  const values = value.map((v) => Math.max(0, Math.min(1, v))).sort((a, b) => a - b);
  return values;
}

export function isActionInterruptible(config, time, duration) {
  const window = normalizeInterruptWindow(config?.interruptWindow);
  if (!window || !(duration > 0)) return false;
  const progress = Math.max(0, Math.min(1, time / duration));
  return progress >= window[0] && progress <= window[1];
}
