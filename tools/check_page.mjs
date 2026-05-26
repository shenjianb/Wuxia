const endpoint = "http://127.0.0.1:9222";
const targetUrl = process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:5173/";

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let version;
  for (let i = 0; i < 30; i += 1) {
    try {
      version = await getJson(`${endpoint}/json/version`);
      break;
    } catch {
      await wait(250);
    }
  }
  if (!version) throw new Error("Could not connect to Edge remote debugging endpoint.");

  const tabs = await getJson(`${endpoint}/json`);
  const page = tabs.find((tab) => tab.type === "page") ?? tabs[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const callbacks = new Map();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (callbacks.has(message.id)) {
      callbacks.get(message.id)(message);
      callbacks.delete(message.id);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  function send(method, params = {}) {
    id += 1;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => callbacks.set(id, resolve));
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: targetUrl });
  await wait(6000);

  if (process.argv.includes("--select-male")) {
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-choice="male"]').click()`,
    });
    await wait(3000);
  }

  if (process.argv.includes("--move-forward")) {
    await send("Runtime.evaluate", {
      expression: `
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft' }));
      `,
    });
    await wait(1500);
    await send("Runtime.evaluate", {
      expression: `
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowLeft' }));
      `,
    });
    await wait(500);
  }

  if (process.argv.includes("--turn-left")) {
    await send("Runtime.evaluate", {
      expression: `window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft' }));`,
    });
    await wait(1500);
    await send("Runtime.evaluate", {
      expression: `window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowLeft' }));`,
    });
    await wait(500);
  }

  const status = await send("Runtime.evaluate", {
    expression: `({
      ready: window.__DEMO_READY,
      error: window.__DEMO_ERROR,
      hasGpu: !!navigator.gpu,
      canvasCount: document.querySelectorAll('canvas').length,
      bodyReady: document.body.dataset.ready || null,
      badge: document.querySelector('[data-renderer]')?.textContent || null,
      demoState: window.__DEMO_STATE || null,
      canvas: (() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return null;
        return {
          width: canvas.width,
          height: canvas.height,
          rect: canvas.getBoundingClientRect().toJSON(),
        };
      })()
    })`,
    returnByValue: true,
  });

  console.log(JSON.stringify(status.result.result.value, null, 2));

  const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (screenshot.result?.data) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("D:/Wuxia_Web/demo_cdp_screenshot.png", Buffer.from(screenshot.result.data, "base64"));
  }
  ws.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
