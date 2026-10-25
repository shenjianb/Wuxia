import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

const base = "http://127.0.0.1:5173";
const tabs = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = tabs.find((tab) => tab.type === "page" && tab.url.startsWith(base));
assert.ok(page, "Local game tab missing");
const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const exceptions = [];
let sequence = 0;
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
  const callback = pending.get(message.id);
  if (callback) { pending.delete(message.id); callback(message); }
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(expression) {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(expression)) return;
    const error = await evaluate("window.__DEMO_ERROR");
    if (error) throw new Error(error);
    await wait(100);
  }
  throw new Error(`State not reached: ${expression}`);
}
const key = (code, down, repeat = false) => evaluate(`window.dispatchEvent(new KeyboardEvent(${JSON.stringify(down ? "keydown" : "keyup")}, {code:${JSON.stringify(code)}, repeat:${repeat}})); true`);
const state = () => evaluate("window.__DEMO_STATE");
const gap = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send("Page.bringToFront");
  await send("Page.navigate", { url: base });
  await until("window.__DEMO_READY === true");
  await evaluate("document.querySelector('[data-choice=male]').click(); true");
  await until("(() => { window.dispatchEvent(new KeyboardEvent('keydown', {code:'ArrowDown'})); return typeof window.__DEMO_STATE?.facingTargetYaw === 'number'; })()");
  await key("ArrowDown", false);
  for (const pair of [["ArrowLeft", "ArrowDown"], ["ArrowRight", "ArrowUp"]]) {
    for (const release of [pair, [...pair].reverse()]) {
      await key(pair[0], true); await key(pair[1], true);
      await wait(50);
      const target = (await state()).facingTargetYaw;
      await key(release[0], false);
      await key(release[1], true, true);
      await wait(100);
      assert.ok(Math.abs(gap((await state()).facingTargetYaw, target)) < 1e-8);
      await key(release[1], false);
      await wait(750);
      const settled = await state();
      assert.ok(Math.abs(gap(settled.facingTargetYaw, target)) < 1e-8);
      assert.ok(Math.abs(gap(settled.facingMarkerRotationY, target)) < 0.02);
    }
  }
  console.log("PASS: diagonal targets and actual facing survive both release orders and repeat");
  const captures = [];
  for (const viewport of [{ width: 1280, height: 720, mobile: false, name: "desktop" }, { width: 390, height: 844, mobile: true, name: "mobile" }]) {
    await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
    await key("ArrowDown", true); await key("ArrowDown", false); await wait(900);
    if (!(await state()).combatMode) { await key("Tab", true); await key("Tab", false); await wait(50); }
    const before = await state();
    await key("KeyW", true); await wait(80);
    assert.equal((await state()).attackSequence, before.attackSequence);
    await key("KeyW", false); await wait(35);
    const attack = await state();
    assert.equal(attack.attackSequence, before.attackSequence + 1);
    assert.equal(attack.attackDirectionOnly, true);
    assert.equal(attack.attackDirectionVisible, true);
    assert.equal(attack.combatAttackMoveId, null);
    assert.ok(Math.abs(Math.abs(gap(Math.atan2(attack.attackDirection[0], attack.attackDirection[2]), attack.facingMarkerRotationY)) - Math.PI) < 0.05);
    const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const path = new URL(`../.tmp-combat-${viewport.name}.png`, import.meta.url);
    writeFileSync(path, Buffer.from(screenshot.data, "base64"));
    captures.push(path.pathname);
    await wait(400);
    assert.equal((await state()).attackDirectionVisible, false);
    console.log(`PASS: ${viewport.name} empty backward attack shows one locked arrow and ends`);
  }
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ ready: true, runtimeExceptions: exceptions.length, captures }));
} finally {
  socket.close();
}
