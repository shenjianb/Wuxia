import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { COMBAT_MOVE_DIRECTIONS } from "../src/combat-move-manager.js";

// Use dedicated targets: never navigate or attach to the combat suite's game tab.
const base = "http://127.0.0.1:5173";
const cdp = "http://127.0.0.1:9222";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = JSON.stringify;
const results = [];
const clients = [];
const strictConfigHash = process.argv.includes("--strict-config-hash");
const configPaths = ["animations/motion_config.json", "combat/move_manager.json", "models/model_config.json"];
const originals = configPaths.map((path) => readFileSync(new URL(`../public/assets/${path}`, import.meta.url), "utf8"));
const config = JSON.parse(originals[0]);
const manager = JSON.parse(originals[1]);
const moves = Object.entries(manager.directions).flatMap(([direction, value]) =>
  value.moves.map((move, index) => ({ ...move, direction, index })));

async function check(name, fn) {
  try { const detail = await fn(); results.push({ name, pass: true, detail }); console.log(`PASS: ${name}`, detail ?? ""); }
  catch (error) { results.push({ name, pass: false, error: error.stack }); console.error(`FAIL: ${name}: ${error.message}`); }
}

async function openEditor(kind, file, prefix) {
  const response = await fetch(`${cdp}/json/new?about:blank`, { method: "PUT" });
  assert.ok(response.ok, `Create ${kind} target: ${response.status}`);
  const target = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const client = { kind, prefix, target, socket, exceptions: [], consoleErrors: [], blocked: [], interceptionErrors: [] };
  let sequence = 0;
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${kind}: timeout ${method}`)); }, 20000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") client.exceptions.push(message.params.exceptionDetails);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      client.consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    }
    if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params;
      // Every non-read request to /api/* is intercepted, including accidental unrelated saves.
      const read = ["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (!read) client.blocked.push({ url: request.url, method: request.method });
      const operation = read ? send("Fetch.continueRequest", { requestId }) : send("Fetch.fulfillRequest", {
        requestId, responseCode: 500,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }],
        body: Buffer.from('{"error":"EDITOR_BROWSER_TEST_SAVE_FAILURE"}').toString("base64"),
      });
      operation.catch((error) => client.interceptionErrors.push(error.message));
    }
    const callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); callback(message); }
  });
  clients.push(client);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  client.send = send;
  client.eval = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  client.until = async (expression, ms = 30000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await client.eval(expression)) return;
      const error = await client.eval(`window.${prefix}_ERROR`);
      if (error) throw new Error(`${kind}: ${error}`);
      await wait(100);
    }
    throw new Error(`${kind}: state not reached: ${expression}`);
  };
  client.state = () => client.eval(`window.${prefix}_STATE`);
  client.click = (selector) => client.eval(`(() => { const el = document.querySelector(${quote(selector)}); if (!el) throw Error('Missing UI: '+${quote(selector)}); el.click(); return true; })()`);
  client.select = (selector, value) => client.eval(`(() => { const el = document.querySelector(${quote(selector)}); if (!el || !Array.from(el.options).some(o => o.value === ${quote(value)})) throw Error('Missing option '+${quote(value)}); el.value=${quote(value)}; el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: "Request" }] });
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${base}/${file}` });
  await client.until(`window.${prefix}_READY === true`);
  return client;
}

function preview(state) {
  assert.ok(state?.pose, "Missing common pose debug contract (wait for editor integration)");
  return { ...state.pose, playing: state.playing };
}

async function selectAction(client, actionName) {
  if (client.kind === "motion") {
    await client.eval(`(() => { const el = [...document.querySelectorAll('.action-item')].find(el=>el.querySelector('.action-name')?.textContent===${quote(actionName)}); if (!el) throw Error('Missing action'); el.click(); return true; })()`);
  } else await client.select("[data-action-select]", actionName);
  await client.until(`window.${client.prefix}_STATE?.duration > 0 && (window.${client.prefix}_STATE?.action === ${quote(actionName)} || window.${client.prefix}_STATE?.selectedActionName === ${quote(actionName)})`);
  await client.click("[data-stop]");
}

async function selectMove(client, move) {
  const direction = COMBAT_MOVE_DIRECTIONS.find((item) => item.id === move.direction);
  assert.ok(direction, `Unknown direction ${move.direction}`);
  await client.eval(`(() => { const el=[...document.querySelectorAll('.direction-tab')].find(el=>el.querySelector('span')?.textContent===${quote(direction.label)}); if(!el)throw Error('Missing direction tab');el.click();return true; })()`);
  await client.until(`!document.querySelector('[data-status]').textContent.includes('加载')`);
  await client.until(`!!document.querySelectorAll('.move-item')[${move.index}]`);
  await client.eval(`document.querySelectorAll('.move-item')[${move.index}].click(); true`);
  await client.until(`window.${client.prefix}_STATE?.selectedMoveId === ${quote(move.id)} && window.${client.prefix}_STATE?.duration > 0 && !document.querySelector('[data-status]').textContent.includes('加载')`);
  await client.click("[data-stop]");
}

async function seek(client, fraction) {
  const current = await client.state();
  const seconds = Math.min(current.duration, Math.round(current.duration * fraction * 1000) / 1000);
  const timelineFraction = current.duration > 0 ? seconds / current.duration : 0;
  if (client.kind === "move") {
    // Use the empty timeline background, not hit-window handles (which edit configuration).
    await client.eval(`(() => { const el=document.querySelector('[data-timeline-track]'); const r=el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.left+r.width*${timelineFraction},clientY:r.top+2})); window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})); return true; })()`);
  } else {
    await client.eval(`(() => { const el=document.querySelector('[data-timeline]'); el.value=${seconds}; el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  }
  await wait(70);
  const state = await client.state();
  // Native range inputs round to step=0.001 seconds.
  assert.ok(Math.abs(state.time - state.duration * fraction) < 0.0011, `${client.kind} seek ${fraction}: ${state.time}/${state.duration}`);
  return state;
}

const vectors = ["rootPosition", "rootQuaternion", "skeletonRootPosition", "skeletonRootQuaternion", "leftHandWorldPosition", "rightHandWorldPosition"];
function compare(a, b, label, tolerance = 0.004) {
  const errors = {};
  for (const field of vectors) {
    assert.ok(Array.isArray(a[field]) && a[field].length === (field.endsWith("Quaternion") ? 4 : 3), `${label}: missing ${field}`);
    assert.ok(Array.isArray(b[field]) && b[field].length === a[field].length, `${label}: missing peer ${field}`);
    assert.ok([...a[field], ...b[field]].every(Number.isFinite), `${label}: nonfinite ${field}`);
    const distance = (sign) => Math.max(...a[field].map((value, i) => Math.abs(value - sign * b[field][i])));
    errors[field] = field.endsWith("Quaternion") ? Math.min(distance(1), distance(-1)) : distance(1);
    assert.ok(errors[field] <= tolerance, `${label}: ${field} delta ${errors[field]} > ${tolerance}`);
  }
  return errors;
}

async function capture(client, viewport) {
  await client.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1 });
  await client.send("Page.bringToFront");
  await client.eval("document.querySelector('canvas').scrollIntoView({block:'center',inline:'center'}); true");
  await wait(450);
  const rect = await client.eval(`(() => { const r=document.querySelector('canvas').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
  assert.ok(rect.width > 40 && rect.height > 40, `${client.kind}: canvas has no usable area`);
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  const width = Math.min(viewport.width, rect.x + rect.width) - x;
  const height = Math.min(viewport.height, rect.y + rect.height) - y;
  assert.ok(width > 40 && height > 40, `${client.kind}: canvas outside viewport`);
  const shot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const path = new URL(`../.tmp-editor-${client.kind}-${viewport.mobile ? "mobile" : "desktop"}.png`, import.meta.url);
  writeFileSync(path, Buffer.from(shot.data, "base64"));
  // Decode compositor pixels rather than attempting unsupported WebGPU canvas readback.
  const pixels = await client.eval(`(async()=>{const img=await createImageBitmap(await (await fetch('data:image/png;base64,${shot.data}')).blob()); const c=document.createElement('canvas');c.width=${Math.floor(width)};c.height=${Math.floor(height)}; const ctx=c.getContext('2d');ctx.drawImage(img,${x},${y},${width},${height},0,0,c.width,c.height);const d=ctx.getImageData(0,0,c.width,c.height).data;let lo=255,hi=0,lit=0;const colors=new Set();for(let i=0;i<d.length;i+=4){const v=Math.max(d[i],d[i+1],d[i+2]);lo=Math.min(lo,v);hi=Math.max(hi,v);if(v>45)lit++;colors.add((d[i]>>3)*1024+(d[i+1]>>3)*32+(d[i+2]>>3));}return {width:c.width,height:c.height,lo,hi,lit,colors:colors.size};})()`);
  assert.ok(pixels.hi - pixels.lo > 30 && pixels.colors > 30 && pixels.lit > 200, `Blank canvas: ${JSON.stringify(pixels)}`);
  return { path: path.pathname, pixels };
}

try {
  assert.ok(moves.length > 0, "No configured moves");
  const motion = await openEditor("motion", "motion-editor.html", "__MOTION_EDITOR");
  const move = await openEditor("move", "move-manager.html", "__MOVE_MANAGER");
  const model = await openEditor("model", "model-editor.html", "__MODEL_EDITOR");
  await check("common pose debug contract", async () => {
    for (const client of clients) {
      const pose = preview(await client.state());
      for (const field of [...vectors, "modelId", "actionName", "playbackRate"]) assert.ok(pose[field] != null, `${client.kind}: missing pose.${field}`);
    }
  });
  for (const gender of ["male", "female"]) {
    const modelId = gender === "male" ? "SK_BaseMale" : "SK_BaseFemale";
    await motion.select("[data-gender]", gender);
    await move.select("[data-model-select]", modelId);
    for (const item of moves) await check(`${gender}: ${item.actionName} deterministic UI seek parity`, async () => {
      assert.ok(config[item.actionName], "Action must have persisted configuration");
      await selectAction(motion, item.actionName);
      await selectMove(move, item);
      const samples = new Map();
      let maximumDelta = 0;
      for (const fraction of [0, 0.25, 0.5, 1, 0.5, 0.25, 0, 1, 1, 0.5]) {
        const left = await seek(motion, fraction), right = await seek(move, fraction);
        assert.ok(Math.abs(left.duration - right.duration) < 0.00001, "Different animation durations");
        const a = preview(left), b = preview(right);
        for (const p of [a, b]) {
          assert.equal(p.modelId, modelId, "Rendered model must follow UI selection");
          assert.equal(p.actionName, item.actionName, "Bound mixer action must follow selected move/action");
          assert.equal(p.playing, false, "Scrubbing must pause playback");
          assert.ok(Number.isFinite(p.playbackRate) && p.playbackRate >= 0, "Invalid playback rate");
          if (!["walk", "combatWalk"].includes(item.actionName)) assert.equal(p.playbackRate, 1, "Non-locomotion actions must play at runtime rate 1");
        }
        maximumDelta = Math.max(maximumDelta, ...Object.values(compare(a, b, `${gender}/${item.actionName}/${fraction}`)));
        if (samples.has(fraction)) {
          compare(a, samples.get(fraction)[0], "motion repeated/backwards seek", 0.00001);
          compare(b, samples.get(fraction)[1], "move repeated/backwards seek", 0.00001);
        } else samples.set(fraction, [a, b]);
      }
      // Verify UI play actually advances time, not only a stale playback-rate label.
      for (const client of [motion, move]) {
        await client.send("Page.bringToFront");
        await wait(150);
        await seek(client, 0);
        await client.click("[data-play]");
        const start = await client.state();
        await client.until(`window.${client.prefix}_STATE.time > ${start.time}`, 5000);
        const end = await client.state();
        assert.ok(end.time > start.time, `${client.kind}: playback did not advance`);
        if (!["walk", "combatWalk"].includes(item.actionName)) assert.equal(preview(end).playbackRate, 1);
        await client.click("[data-stop]");
      }
      return { motionMode: config[item.actionName].motionMode, samples: 10, maximumDelta };
    });
  }
  await check("model switching retains and animates the current action without reselection", async () => {
    const item = moves.find((entry) => config[entry.actionName]?.motionMode === "RootMotion") || moves[0];
    await selectAction(motion, item.actionName);
    await selectMove(move, item);
    for (const gender of ["male", "female", "male"]) {
      const modelId = gender === "male" ? "SK_BaseMale" : "SK_BaseFemale";
      await motion.select("[data-gender]", gender);
      await move.select("[data-model-select]", modelId);
      const zero = [];
      const mid = [];
      for (const client of [motion, move]) {
        zero.push(preview(await seek(client, 0)));
        const pose = preview(await seek(client, 0.5));
        assert.equal(pose.modelId, modelId);
        assert.equal(pose.actionName, item.actionName);
        mid.push(pose);
      }
      compare(mid[0], mid[1], `${gender}: model switch pose`);
      for (let i = 0; i < mid.length; i++) {
        const relative = (pose) => pose.rightHandWorldPosition.map((value, axis) => value - pose.rootPosition[axis]);
        assert.ok(relative(mid[i]).some((value, axis) => Math.abs(value - relative(zero[i])[axis]) > 0.01), "New model's hand pose did not animate");
      }
    }
  });
  await check("model editor: both models and RootMotion pose smoke", async () => {
    const dash = moves.find((item) => config[item.actionName]?.motionMode === "RootMotion");
    assert.ok(dash);
    for (const modelId of ["SK_BaseMale", "SK_BaseFemale"]) {
      await model.eval(`(() => { const item=[...document.querySelectorAll('.model-item')].find(el=>el.textContent.includes(${quote(modelId)}));if(!item)throw Error('Missing model UI');item.click();return true; })()`);
      await selectAction(model, dash.actionName);
      const zero = preview(await seek(model, 0));
      const mid = preview(await seek(model, 0.5));
      assert.equal(mid.modelId, modelId);
      assert.equal(mid.actionName, dash.actionName);
      assert.equal(mid.playbackRate, 1);
      compare(mid, preview(await seek(model, 0.5)), "model repeat");
      assert.ok(vectors.some((field) => JSON.stringify(zero[field]) !== JSON.stringify(mid[field])), "RootMotion pose never changes");
    }
  });
  for (const client of clients) for (const viewport of [{ width: 1440, height: 1000, mobile: false }, { width: 390, height: 844, mobile: true }]) {
    await check(`${client.kind}: ${viewport.mobile ? "mobile" : "desktop"} screenshot and nonblank canvas`, () => capture(client, viewport));
  }
  await check("motion save failure: intercepted 500, dirty retained, no disk write", async () => {
    await motion.eval(`(() => { const el=document.querySelector('[data-fields] input[type=range]');if(!el)throw Error('Missing config slider');el.value=Number(el.value)>Number(el.min)?Number(el.value)-Number(el.step):Number(el.value)+Number(el.step);el.dispatchEvent(new Event('input',{bubbles:true}));return true; })()`);
    await motion.until("window.__MOTION_EDITOR_STATE?.dirty === true");
    const errorsBefore = motion.consoleErrors.length;
    await motion.click("[data-save]");
    await motion.until("document.querySelector('[data-status]').classList.contains('bad') && !document.querySelector('[data-save]').disabled");
    assert.equal((await motion.state()).dirty, true);
    assert.ok(await motion.eval("document.querySelector('[data-save]').classList.contains('dirty')"));
    assert.deepEqual(motion.blocked.map(({ url, method }) => [new URL(url).pathname, method]), [["/api/motion-config", "PUT"]]);
    const expected = motion.consoleErrors.splice(errorsBefore);
    assert.ok(expected.every((text) => text.includes("EDITOR_BROWSER_TEST_SAVE_FAILURE")), `Unexpected save console error: ${expected}`);
    return { blocked: motion.blocked, status: await motion.eval("document.querySelector('[data-status]').textContent") };
  });
} catch (error) {
  results.push({ name: "suite setup", pass: false, error: error.stack });
  console.error(error);
} finally {
  for (const client of clients) {
    await check(`${client.kind}: no uncaught exceptions or unexpected console errors`, async () => {
      assert.deepEqual(client.exceptions, []);
      assert.deepEqual(client.consoleErrors, []);
      assert.deepEqual(client.interceptionErrors, []);
    });
    // Close only targets created above, including dirty forms without invoking save.
    try { await fetch(`${cdp}/json/close/${client.target.id}`); } catch { /* Browser may already be closed. */ }
    client.socket.close();
  }
  await check("persisted configuration snapshot comparison", async () => {
    const changed = configPaths.filter((path, index) => readFileSync(new URL(`../public/assets/${path}`, import.meta.url), "utf8") !== originals[index]);
    if (strictConfigHash) assert.deepEqual(changed, [], "Configurations changed during test (possibly a concurrent editor task)");
    return { changed, strictConfigHash };
  });
}
console.log(JSON.stringify({ configuredMoves: moves.map(({ id, actionName }) => ({ id, actionName })), results, limitations: ["Pose parity only: foot lock, collision and transitions excluded", "CDP compositor screenshots, not Playwright", "Nonblank pixels do not prove model visual correctness; inspect saved screenshots", "Saving is deliberately failed; successful persistence is not tested", "Configuration snapshot changes are informational unless --strict-config-hash is specified"] }, null, 2));
if (results.some((result) => !result.pass)) process.exitCode = 1;
