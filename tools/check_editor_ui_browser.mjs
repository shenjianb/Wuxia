import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

// Keep the isolated-target/client lifecycle used by check_animation_editors_browser.mjs.
// This suite never attaches to an existing user or regression-suite target.
const base = process.env.EDITOR_TEST_BASE || "http://127.0.0.1:5173";
const cdp = process.env.EDITOR_TEST_CDP || "http://127.0.0.1:9222";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const q = JSON.stringify;
const clients = [], results = [];
const pages = [
  ["motion", "motion-editor.html", "__MOTION_EDITOR"],
  ["move", "move-manager.html", "__MOVE_MANAGER"],
  ["model", "model-editor.html", "__MODEL_EDITOR"],
  ["npc", "npc-editor.html", "__NPC_EDITOR"],
  ["behavior", "behavior-editor.html", "__BEHAVIOR_EDITOR"],
  ["scene", "scene-editor.html", "__SCENE_EDITOR"],
];
const viewports = [
  { width: 1440, height: 1000, mobile: false },
  { width: 390, height: 844, mobile: true },
];
const configPaths = ["animations/motion_config.json", "combat/move_manager.json", "models/model_config.json"];
const originals = configPaths.map((path) => readFileSync(new URL(`../public/assets/${path}`, import.meta.url), "utf8"));
const configuredMoves = Object.values(JSON.parse(originals[1]).directions).flatMap((value) => value.moves);

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail });
    console.log(`PASS: ${name}`, process.argv.includes('--summary') ? '' : JSON.stringify(detail ?? ""));
  } catch (error) {
    results.push({ name, pass: false, error: error.stack });
    console.error(`FAIL: ${name}: ${error.message.slice(0,1800)}`);
  }
}

async function openEditor([kind, file, prefix]) {
  const response = await fetch(`${cdp}/json/new?about:blank`, { method: "PUT" });
  assert.ok(response.ok, `Create ${kind} target: ${response.status}`);
  const target = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const client = { kind, prefix, target, socket, exceptions: [], consoleErrors: [], blocked: [], interceptionErrors: [] };
  clients.push(client);
  let sequence = 0;
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(Error(`${kind}: timeout ${method}`)); }, 20000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        if (message.error) reject(Error(JSON.stringify(message.error)));
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
      // Intercept all origins and API paths, not just the endpoint deliberately tested below.
      const read = ["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (!read) client.blocked.push({ url: request.url, method: request.method });
      const operation = read ? send("Fetch.continueRequest", { requestId }) : send("Fetch.fulfillRequest", {
        requestId, responseCode: 500,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }],
        body: Buffer.from('{"error":"EDITOR_UI_TEST_SAVE_FAILURE"}').toString("base64"),
      });
      operation.catch((error) => client.interceptionErrors.push(error.message));
    }
    const callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); callback(message); }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  client.send = send;
  client.eval = async (expression) => {
    const value = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  };
  client.until = async (expression, ms = 30000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await client.eval(expression)) return;
      const error = await client.eval(`window.${prefix}_ERROR`);
      if (error) throw Error(`${kind}: ${error}`);
      await wait(100);
    }
    throw Error(`${kind}: state not reached: ${expression}`);
  };
  client.state = () => client.eval(`window.${prefix}_STATE`);
  client.click = (selector) => client.eval(`(() => { const el=document.querySelector(${q(selector)}); if(!el) throw Error('Missing UI: '+${q(selector)}); if(el.disabled)throw Error('Disabled UI: '+${q(selector)}); el.click();return true; })()`);
  client.select = (selector, value) => client.eval(`(() => { const el=document.querySelector(${q(selector)});if(!el || ![...el.options].some(o=>o.value===${q(value)}))throw Error('Missing option: '+${q(value)});el.value=${q(value)};el.dispatchEvent(new Event('change',{bubbles:true}));return true; })()`);
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api*", requestStage: "Request" }] });
  await send("Emulation.setDeviceMetricsOverride", { ...viewports[0], deviceScaleFactor: 1 });
  await send("Page.navigate", { url: `${base}/${file}` });
  await client.until(`window.${prefix}_READY === true`);
  return client;
}

function inspectUI() {
  const visible = (el) => {
    if(el.checkVisibility&&!el.checkVisibility({checkVisibilityCSS:true}))return false;
    const closed=el.closest('details:not([open])');
    if(closed&&!closed.querySelector(':scope > summary')?.contains(el))return false;
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);
    if(!(r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"))return false;
    for(let parent=el.parentElement;parent;parent=parent.parentElement){
      const p=getComputedStyle(parent),pr=parent.getBoundingClientRect();
      if(/auto|scroll|hidden|clip/.test(p.overflowY)&&(r.bottom<=pr.top||r.top>=pr.bottom))return false;
      if(/auto|scroll|hidden|clip/.test(p.overflowX)&&(r.right<=pr.left||r.left>=pr.right))return false;
    }
    return true;
  };
  const id = (el) => el.getAttribute("aria-label") || el.title || el.textContent.trim().slice(0, 40) || el.outerHTML.slice(0,100);
  const neutral = (el) => {
    const color=getComputedStyle(el).backgroundColor;
    const values=color.match(/[\d.]+/g)?.map(Number) || [];
    const [r,g,b,a=1]=values;
    return { element:el.className || el.tagName, color, neutral:a===0 || (Math.max(r,g,b)<=42&&Math.max(r,g,b)-Math.min(r,g,b)<=6) };
  };
  const tools=[...document.querySelectorAll('button.editor-icon-button,button[data-icon],button[data-play],button[data-stop],button[data-save],button[data-toggle-ground],button[data-toggle-grid],button[data-toggle-skeleton],button[data-toggle-attack],button[data-btn-save],button[data-save-scene2]')].filter(visible);
  const invalid=tools.flatMap(el=>{
    const r=el.getBoundingClientRect(), svg=el.querySelectorAll("svg");
    const failures=[];
    if(svg.length!==1 || !svg[0]?.classList.contains("lucide"))failures.push("expected exactly one Lucide SVG");
    if(el.querySelector("svg svg"))failures.push("nested SVG");
    if(!el.getAttribute("aria-label")?.trim())failures.push("missing accessible label");
    if(!el.title?.trim())failures.push("missing title tooltip");
    if(!el.dataset.tooltip?.trim())failures.push("missing data-tooltip");
    if(r.width<30||r.height<30)failures.push(`small target ${r.width}x${r.height}`);
    return failures.length?[{tool:id(el),failures}]:[];
  });
  const topControls=[...document.querySelectorAll('button,select,input:not([type=hidden]),summary,a[href]')].filter(el=>{
    if(!visible(el))return false;
    const r=el.getBoundingClientRect();return r.top>=0&&r.top<innerHeight&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;
  });
  const overlaps=[];
  for(let i=0;i<topControls.length;i++)for(let j=i+1;j<topControls.length;j++){
    const a=topControls[i], b=topControls[j];if(a.contains(b)||b.contains(a))continue;
    if(a.matches('input[data-interrupt-handle]')&&b.matches('input[data-interrupt-handle]')&&a.closest('.interrupt-track')===b.closest('.interrupt-track'))continue;
    const x=a.getBoundingClientRect(), y=b.getBoundingClientRect();
    if(Math.min(x.right,y.right)-Math.max(x.left,y.left)>2&&Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>2)overlaps.push([id(a),id(b)]);
  }
  return {
    body:neutral(document.body),
    theme:document.body.dataset.editorTheme,
    panels:[...document.querySelectorAll('.action-rail,.model-rail,.move-rail,.npc-rail,.scene-rail,.property-panel,.panel-head,.timeline-panel,.graph-toolbar')].filter(visible).map(neutral),
    width:innerWidth, documentWidth:document.documentElement.scrollWidth,
    tools:tools.length, invalid, overlaps,
    icons:document.querySelectorAll('button svg').length,
    surfaces:[...document.querySelectorAll('[data-viewport],.property-panel,[data-graph-canvas]')].map(el=>{const r=el.getBoundingClientRect();return {element:el.className,width:r.width,height:r.height,left:r.left,right:r.right,display:getComputedStyle(el).display};}),
    toolSizes:tools.map(el=>({tool:id(el),width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})),
  };
}

async function focusTooltip(client) {
  // Real Tab input after focusing a preceding temporary sentinel exercises :focus-visible.
  const selector = await client.eval(`(async() => {const el=document.querySelector('button[data-toggle-grid],button[data-toggle-wireframe]')||[...document.querySelectorAll('button.editor-icon-button')].find(el=>!el.disabled&&el.checkVisibility());if(!el)throw Error('No focusable icon tool');el.scrollIntoView({block:'center',inline:'nearest'});await new Promise(resolve=>setTimeout(resolve,200));el.dataset.uiTestFocus='';const sentinel=document.createElement('span');sentinel.tabIndex=0;sentinel.dataset.uiTestSentinel='';el.before(sentinel);sentinel.focus({preventScroll:true});return '[data-ui-test-focus]';})()`);
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await wait(750);
  const detail = await client.eval(`(() => {const el=document.querySelector(${q(selector)});const pseudo=['::before','::after'].map(p=>{const s=getComputedStyle(el,p);return {content:s.content,opacity:s.opacity,visibility:s.visibility,display:s.display};});const described=(el.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)).filter(Boolean);return {focused:document.activeElement===el,focusVisible:el.matches(':focus-visible'),pseudo,domTooltip:described.some(t=>{const s=getComputedStyle(t);return t.textContent.trim()&&s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity)>0;})};})()`);
  await client.eval("document.querySelector('[data-ui-test-sentinel]')?.remove();document.querySelector('[data-ui-test-focus]')?.removeAttribute('data-ui-test-focus');true");
  assert.ok(detail.focused && detail.focusVisible, `Keyboard focus failed: ${q(detail)}`);
  const realTooltip=await client.eval("(()=>{const el=document.querySelector('#editor-ui-tooltip[role=tooltip]');if(!el)return null;const s=getComputedStyle(el),r=el.getBoundingClientRect();return {text:el.textContent,visible:s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&r.width>0&&r.height>0,inBounds:r.left>=0&&r.right<=innerWidth};})()");
  assert.ok(detail.domTooltip&&realTooltip?.visible&&realTooltip.inBounds, `No visible linked keyboard tooltip: ${q({detail,realTooltip})}`);
  return detail;
}

async function capture(client, viewport) {
  await client.eval("window.scrollTo(0,0);document.activeElement?.blur();true");
  let initialPath;
  if(viewport.mobile){
    await wait(150);
    const initial=await client.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    initialPath=new URL(`../.tmp-ui-${client.kind}-mobile-initial.png`,import.meta.url);
    writeFileSync(initialPath,Buffer.from(initial.data,'base64'));
  }
  if(viewport.mobile)await client.eval("document.querySelector('[data-viewport], [data-graph-canvas]')?.scrollIntoView({block:'center',inline:'nearest'});true");
  await wait(200);
  const shot=await client.send("Page.captureScreenshot", { format:"png",captureBeyondViewport:false });
  const path=new URL(`../.tmp-ui-${client.kind}-${viewport.mobile?"mobile":"desktop"}.png`,import.meta.url);
  writeFileSync(path,Buffer.from(shot.data,"base64"));
  if(client.kind==="behavior")return {path:path.pathname,initialPath:initialPath?.pathname,graph:await client.eval("({nodes:document.querySelectorAll('.behavior-node').length,paths:document.querySelectorAll('[data-svg-layer] path').length})")};
  const rect=await client.eval(`(()=>{const el=document.querySelector('[data-viewport] canvas:not([data-light-sphere])');if(!el)throw Error('Missing 3D canvas');const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);
  // Sample the central render area, never toolbar/status/readout pixels at canvas edges.
  const x=Math.max(0,rect.x+rect.width*0.2),y=Math.max(0,rect.y+rect.height*0.25);
  const width=Math.min(viewport.width,rect.x+rect.width*0.8)-x,height=Math.min(viewport.height,rect.y+rect.height*0.6)-y;
  assert.ok(width>40&&height>40,`3D canvas outside initial viewport: ${q(rect)}`);
  const pixels=await client.eval(`(async()=>{const img=await createImageBitmap(await(await fetch('data:image/png;base64,${shot.data}')).blob());const c=document.createElement('canvas');c.width=${Math.floor(width)};c.height=${Math.floor(height)};const ctx=c.getContext('2d');ctx.drawImage(img,${x},${y},${width},${height},0,0,c.width,c.height);const d=ctx.getImageData(0,0,c.width,c.height).data;let lo=255,hi=0,lit=0;const colors=new Set();for(let i=0;i<d.length;i+=4){const v=Math.max(d[i],d[i+1],d[i+2]);lo=Math.min(lo,v);hi=Math.max(hi,v);if(v>45)lit++;colors.add((d[i]>>3)*1024+(d[i+1]>>3)*32+(d[i+2]>>3));}return {width:c.width,height:c.height,lo,hi,lit,colors:colors.size};})()`);
  const nonblankVerified=pixels.hi-pixels.lo>30&&pixels.colors>30&&pixels.lit>200;
  if(client.kind!=='scene')assert.ok(nonblankVerified,`Blank canvas: ${q(pixels)}`);
  return {path:path.pathname,initialPath:initialPath?.pathname,pixels,nonblankVerified,limitation:nonblankVerified?undefined:'Scene central pixels are uniform white terrain material; this is not proof of nonblank geometry',sampleRegion:'central 60% width, 25%-60% height; excludes edge UI'};
}

async function playback(client) {
  const key=`window.${client.prefix}_STATE`;
  await client.click('[data-stop]');
  await client.until(`${key}?.playing===false && ${key}.time<0.001`);
  const before=await client.eval("(()=>{const r=document.querySelector('[data-play]').getBoundingClientRect();return {width:r.width,height:r.height};})()");
  await client.click('[data-play]');
  await client.until(`${key}?.playing===true && ${key}.time>0.04`,5000);
  await client.click('[data-toggle-grid]');
  await wait(80);
  assert.equal(await client.eval("document.querySelector('[data-play] svg')?.getAttribute('data-editor-icon')"),'pause','Running icon must remain pause after unrelated grid refresh');
  await client.click('[data-toggle-grid]');
  await client.click('[data-play]');
  await client.click('[data-toggle-grid]');
  await wait(80);
  assert.equal(await client.eval("document.querySelector('[data-play] svg')?.getAttribute('data-editor-icon')"),'play','Paused icon must remain play after unrelated grid refresh');
  await client.click('[data-toggle-grid]');
  await client.until(`${key}?.playing===false`,2000);
  const paused=await client.state();
  await wait(250);
  assert.ok(Math.abs((await client.state()).time-paused.time)<0.002,'Paused preview keeps advancing');
  const after=await client.eval("(()=>{const r=document.querySelector('[data-play]').getBoundingClientRect();return {width:r.width,height:r.height};})()");
  assert.deepEqual(after,before,'Play/pause label changes resize the hit area');
  await client.click('[data-stop]');
  await client.until(`${key}?.playing===false && ${key}.time<0.001`);
  await client.click('[data-toggle-grid]');
  await wait(80);
  assert.equal(await client.eval("document.querySelector('[data-play] svg')?.getAttribute('data-editor-icon')"),'play','Stopped icon must remain play after unrelated grid refresh');
  await client.click('[data-toggle-grid]');
  return {pausedAt:paused.time,hitArea:after};
}

async function motionOptions(client) {
  await client.eval(`(()=>{const item=[...document.querySelectorAll('.action-item')].find(el=>el.querySelector('.action-name')?.textContent===${q(configuredMoves[0].actionName)});if(!item)throw Error('Missing attack action');item.click();return true;})()`);
  await client.until(`window.__MOTION_EDITOR_STATE?.action===${q(configuredMoves[0].actionName)} && window.__MOTION_EDITOR_STATE.duration>0`);
  await client.click('[data-stop]');
  const groups=await client.eval("[...document.querySelectorAll('details[data-motion-group]')].map(el=>({name:el.dataset.motionGroup,open:el.open}))");
  assert.ok(groups.length>0,'No advanced motion folds');
  for(const group of groups){
    const selector=`details[data-motion-group=${q(group.name)}]`;
    await client.click(`${selector} > summary`);
    assert.equal(await client.eval(`document.querySelector(${q(selector)}).open`),!group.open,'Summary did not toggle fold');
    await client.click(`${selector} > summary`);
    assert.equal(await client.eval(`document.querySelector(${q(selector)}).open`),group.open);
  }
  const basic=await client.eval(`(()=>{const el=document.querySelector('[data-basic-motion-mode]')||[...document.querySelectorAll('[data-fields] select')].find(s=>[...s.options].some(o=>o.value==='RootMotion')&&[...s.options].some(o=>o.value==='InPlace'));return {found:!!el,inClosedFold:!!el?.closest('details:not([open])'),display:el?getComputedStyle(el).display:null};})()`);
  assert.ok(basic.found&&!basic.inClosedFold&&basic.display!=="none",`Basic motion mode inaccessible: ${q(basic)}`);
  const loopSelector='.preview-options input[type=checkbox]';
  const originalLoop=await client.eval(`document.querySelector(${q(loopSelector)}).checked`);
  const texts=[];
  for(const loop of [false,true]){
    await client.eval(`(()=>{const el=document.querySelector(${q(loopSelector)});el.checked=${loop};el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    await wait(100);
    const text=await client.eval("document.querySelector('[data-effective-rules]').textContent");
    assert.match(text,/游戏\s*1(?:\.0+)?x\s*\/\s*单次/,'Attack gameplay must remain once at rate 1');
    assert.ok(text.includes(`预览 ${loop?'循环':'单次'}`),`Incorrect preview loop output: ${text}`);
    texts.push(text);
  }
  await client.eval(`(()=>{const el=document.querySelector(${q(loopSelector)});el.checked=${originalLoop};el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  return {groups,basic,texts};
}

async function otherControls(client) {
  if(client.kind==='npc'){
    await client.click('[data-npc-list] .npc-item');
    await client.until("!![...document.querySelectorAll('[data-field-scroll] select')].find(s=>[...s.options].some(o=>o.value==='BaseFemale'))");
    await client.eval("(()=>{const s=[...document.querySelectorAll('[data-field-scroll] select')].find(s=>[...s.options].some(o=>o.value==='BaseFemale'));s.dataset.uiTestModel='';return true;})()");
    await client.select('[data-ui-test-model]','BaseFemale');
    await client.until("document.querySelector('[data-toolbar-info]').textContent.includes('BaseFemale')");
    await client.select('[data-ui-test-model]','BaseMale');
    await client.until("document.querySelector('[data-toolbar-info]').textContent.includes('BaseMale')");
    await client.click('[data-toggle-skeleton]');
    assert.equal(await client.eval("document.querySelector('[data-toggle-skeleton]').getAttribute('aria-pressed')"),'true');
    await client.click('[data-toggle-skeleton]');
    return {modelSelections:['BaseFemale','BaseMale'],skeletonToggle:true,limitation:'NPC has no animation selector; no NPC AI simulation tested'};
  }
  if(client.kind==='scene'){
    const count=await client.eval("document.querySelectorAll('.scene-item').length");
    if(count)await client.click('.scene-item');
    await client.click('[data-edit-mode="select"]');
    assert.ok(await client.eval("document.querySelector('[data-edit-mode=select]').classList.contains('active-tool')"));
    await client.click('[data-edit-mode="terrain"]');
    await client.click('[data-terrain-tool="lower"]');
    assert.ok(await client.eval("document.querySelector('[data-terrain-tool=lower]').classList.contains('active-tool')"));
    await client.click('[data-terrain-tool="raise"]');
    const before=await client.eval("document.querySelector('[data-toggle-wireframe]').getAttribute('aria-pressed')");
    await client.click('[data-toggle-wireframe]');
    const after=await client.eval("document.querySelector('[data-toggle-wireframe]').getAttribute('aria-pressed')");
    assert.notEqual(after,before,'Wireframe state unchanged');
    await client.click('[data-toggle-wireframe]');
    return {sceneItems:count,modes:['select','terrain'],terrainTools:['lower','raise'],wireframe:[before,after],limitation:'No terrain painting, model/action selector or persistent object edits'};
  }
  const graph=await client.eval("({nodes:document.querySelectorAll('.behavior-node').length,edges:document.querySelectorAll('[data-svg-layer] path').length})");
  assert.ok(graph.nodes>1&&graph.edges>0,`Graph is empty: ${q(graph)}`);
  const before=await client.eval("document.querySelector('[data-zoom-info]').textContent");
  await client.eval("(()=>{const el=document.querySelector('[data-graph-canvas]');const r=el.getBoundingClientRect();el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-100,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));return true;})()");
  const after=await client.eval("document.querySelector('[data-zoom-info]').textContent");
  assert.notEqual(after,before,'Graph zoom did not change');
  await client.eval("(()=>{const el=document.querySelector('.behavior-node:not(.type-entry)');el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:0,clientY:0}));window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return true;})()");
  assert.ok(await client.eval("!!document.querySelector('.behavior-node.selected')"),'Node selection did not change');
  return {...graph,zoom:[before,after],selected:true};
}

async function graphVisibility(client, mobile) {
  const initial=await client.eval("({hidden:document.querySelector('[data-brain-dock]').hidden,expanded:document.querySelector('[data-toggle-brain]').getAttribute('aria-expanded')})");
  assert.equal(initial.expanded,String(!initial.hidden));
  if(mobile)assert.equal(initial.hidden,true,'Fresh mobile graph must default to hidden brain dock');
  for(const hidden of [!initial.hidden,initial.hidden]){
    await client.click('[data-toggle-brain]');
    assert.equal(await client.eval("document.querySelector('[data-brain-dock]').hidden"),hidden);
    assert.equal(await client.eval("document.querySelector('[data-toggle-brain]').getAttribute('aria-expanded')"),String(!hidden));
  }
  if(!initial.hidden)await client.click('[data-toggle-brain]');
  await client.eval("document.querySelector('[data-graph-canvas]').scrollIntoView({block:'center'});true");
  await wait(200);
  const point=await client.eval("(()=>{const graph=document.querySelector('[data-graph-canvas]').getBoundingClientRect();for(const el of document.querySelectorAll('.behavior-node:not(.type-entry)')){const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+Math.min(r.height/2,20);if(x<Math.max(0,graph.left)||x>Math.min(innerWidth,graph.right)||y<Math.max(0,graph.top)||y>Math.min(innerHeight,graph.bottom))continue;const hit=document.elementFromPoint(x,y);if(hit?.closest('.behavior-node')===el)return {x,y,id:el.dataset.nodeId};}return null;})()");
  assert.ok(point,'No unobscured behavior node can be hit in graph viewport');
  await client.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
  await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
  assert.ok(await client.eval(`document.querySelector('.behavior-node.selected')?.dataset.nodeId===${q(point.id)}`),'Visible graph node cannot be selected');
  await client.eval('window.scrollTo(0,0);true');
  return {initial,toggledTwice:true,unobscuredSelectedNode:point.id};
}

try {
  for(const page of pages){
    let client;
    await check(`${page[0]}: ready`,async()=>{
      client=await openEditor(page);
      assert.equal(await client.eval(`window.${client.prefix}_ERROR`),null);
      return {ready:true};
    });
    if(!client?.eval)continue;
    await client.send('Page.bringToFront');
    if(['motion','move','model'].includes(client.kind)){
      await check(`${client.kind}: actual play/pause/stop`,()=>playback(client));
      if(client.kind==='motion')await check('motion: advanced folds, basic motion mode and effective attack policy',()=>motionOptions(client));
      else await check(`${client.kind}: effective policy output`,async()=>{
        if(client.kind==='model'){
          await client.select('[data-action-select]',configuredMoves[0].actionName);
          await client.until(`window.__MODEL_EDITOR_STATE?.selectedActionName===${q(configuredMoves[0].actionName)} && window.__MODEL_EDITOR_STATE.duration>0`);
          await client.click('[data-stop]');
        }
        const text=await client.eval("document.querySelector('[data-effective-rules]')?.textContent");
        assert.ok(text?.includes('游戏')&&text?.includes('预览'),`Missing distinct effective policy output: ${text}`);
        assert.match(text,/游戏\s*1(?:\.0+)?x\s*\/\s*单次/,'Attack gameplay must stay once at rate 1');
        return text;
      });
    }else await check(`${client.kind}: basic controls`,()=>otherControls(client));
    for(const viewport of viewports){
      const label=`${client.kind}: ${viewport.mobile?'mobile':'desktop'}`;
      await client.send('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1});
      if(client.kind==='behavior'){
        if(viewport.mobile){
          await client.eval('window.__BEHAVIOR_EDITOR_READY=false;true');
          await client.send('Page.reload',{ignoreCache:false});
          await client.until('window.__BEHAVIOR_EDITOR_READY===true');
        }
        await check(`${label} brain dock toggle and unobscured node selection`,()=>graphVisibility(client,viewport.mobile));
      }
      await client.eval('window.scrollTo(0,0);true');
      await wait(450);
      await check(`${label} neutral surfaces, overflow, tool icons and overlap`,async()=>{
        const ui=await client.eval(`(${inspectUI})()`);
        assert.equal(ui.theme,'codex','Shared editor theme not initialized');
        assert.ok(ui.body.neutral,`Body is not neutral black: ${q(ui.body)}`);
        assert.ok(ui.panels.length>0,'No panels inspected');
        assert.deepEqual(ui.panels.filter(p=>!p.neutral),[],`Non-neutral panels: ${q(ui.panels)}`);
        assert.ok(ui.documentWidth<=ui.width+1,`Horizontal overflow ${ui.documentWidth}>${ui.width}`);
        assert.ok(ui.surfaces.length>=2,'Missing canvas/graph and property surfaces');
        assert.deepEqual(ui.surfaces.filter(s=>s.display==='none'||s.width<40||s.height<40||s.left< -1||s.right>ui.width+1),[],`Unavailable or horizontally clipped panels: ${q(ui.surfaces)}`);
        assert.ok(ui.tools>0,'No standard tools found');
        assert.deepEqual(ui.invalid,[],'Invalid standard tools');
        assert.deepEqual(ui.overlaps,[],'Top-viewport controls overlap');
        return ui;
      });
      await check(`${label} icon mutation stability`,async()=>{
        const a=await client.eval(`(${inspectUI})()`);
        const mutations=await client.eval("new Promise(resolve=>{let count=0;const observers=[...document.querySelectorAll('button[data-icon]')].map(el=>{const observer=new MutationObserver(records=>count+=records.length);observer.observe(el,{childList:true,subtree:true});return observer;});setTimeout(()=>{observers.forEach(o=>o.disconnect());resolve(count);},900);})");
        const b=await client.eval(`(${inspectUI})()`);
        assert.equal(b.icons,a.icons,'Icon count grows while idle');
        assert.deepEqual(b.toolSizes,a.toolSizes,'Tool hit areas shift while idle');
        const duplicates=await client.eval("[...document.querySelectorAll('button[data-icon]')].filter(el=>el.querySelectorAll('svg').length!==1||el.querySelector('svg svg')).map(el=>el.outerHTML.slice(0,250))");
        assert.deepEqual(duplicates,[],'Duplicate/nested SVGs');
        assert.ok(mutations<400,`Excessive idle icon DOM mutations: ${mutations}/900ms`);
        return {icons:b.icons,stableForMs:900,iconChildMutations:mutations};
      });
      await check(`${label} keyboard-focus tooltip`,()=>focusTooltip(client));
      await check(`${label} screenshot and ${client.kind==='behavior'?'graph DOM':client.kind==='scene'?'scene pixel diagnostic':'nonblank 3D canvas'}`,()=>capture(client,viewport));
      if(['motion','move','model'].includes(client.kind))await check(`${label} playback controls remain functional`,()=>playback(client));
    }
  }
  const motion=clients.find(c=>c.kind==='motion'&&c.eval);
  if(motion)await check('motion: save failure retains dirty state and never writes',async()=>{
    await motion.eval("(()=>{const el=document.querySelector('[data-fields] input[type=range]');if(!el)throw Error('Missing config slider');el.value=Number(el.value)>Number(el.min)?Number(el.value)-Number(el.step):Number(el.value)+Number(el.step);el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
    await motion.until('window.__MOTION_EDITOR_STATE?.dirty===true');
    const start=motion.consoleErrors.length;
    await motion.click('[data-save]');
    await motion.until("document.querySelector('[data-status]').classList.contains('bad')&&!document.querySelector('[data-save]').disabled");
    assert.equal((await motion.state()).dirty,true);
    assert.ok(motion.blocked.some(r=>new URL(r.url).pathname==='/api/motion-config'&&r.method==='PUT'));
    const expected=motion.consoleErrors.splice(start);
    assert.ok(expected.every(text=>text.includes('EDITOR_UI_TEST_SAVE_FAILURE')),`Unexpected save errors: ${q(expected)}`);
    return {blocked:motion.blocked,status:await motion.eval("document.querySelector('[data-status]').textContent")};
  });
}catch(error){results.push({name:'suite setup',pass:false,error:error.stack});console.error(error);}
finally{
  for(const client of clients){
    await check(`${client.kind}: no runtime, console or interception errors`,async()=>{
      assert.deepEqual(client.exceptions,[]);
      assert.deepEqual(client.consoleErrors,[]);
      assert.deepEqual(client.interceptionErrors,[]);
      if(client.eval){await client.send('Page.bringToFront');assert.equal(await client.eval(`window.${client.prefix}_ERROR`),null);}
      return {blockedWrites:client.blocked};
    });
    try{await fetch(`${cdp}/json/close/${client.target.id}`);}catch{/* Close only this suite's target. */}
    client.socket.close();
  }
  await check('configuration bytes unchanged',async()=>{
    const changed=configPaths.filter((path,i)=>readFileSync(new URL(`../public/assets/${path}`,import.meta.url),'utf8')!==originals[i]);
    assert.deepEqual(changed,[],'Configuration changed during the suite (including concurrent changes)');
    return {paths:configPaths};
  });
}
console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results:process.argv.includes('--summary')?results.filter(r=>!r.pass):results,limitations:[
  'Edge CDP, not Playwright; only dedicated targets created by this suite are closed',
  'Pixel variation cannot establish model correctness; inspect .tmp-ui-*.png visually',
  'Uniform white scene terrain is recorded as a pixel diagnostic, not a nonblank geometry pass',
  'Behavior graph presence, wheel zoom and node selection only; not all behavior execution',
  'NPC model selection and scene tool smoke only; no AI simulation or terrain painting',
  'No successful persistence; ALL non-read /api requests deliberately return HTTP 500',
  'No collision, foot-lock, transition, complete motion parity or screen-reader audit; run the old 22-case suite separately',
  'Top-viewport pairwise control bounds and sampled surfaces only, not every possible layout or palette state',
]},null,2));
if(results.some(r=>!r.pass))process.exitCode=1;
