export async function createSafeRenderer(THREE, options = {}) {
  const {
    antialias = true,
    alpha = true,
    depth = true,
    stencil = false,
    preferWebGPU = true,
    ...rest
  } = options;
  const baseOptions = { antialias, alpha, depth, stencil, ...rest };

  if (preferWebGPU && navigator.gpu) {
    try {
      const renderer = new THREE.WebGPURenderer(baseOptions);
      await renderer.init();
      renderer.userData = renderer.userData || {};
      renderer.userData.backendLabel = renderer.backend?.isWebGPUBackend ? "WebGPU" : getRendererBackendLabel(renderer);
      return renderer;
    } catch (error) {
      console.warn("WebGPU renderer init failed; falling back to WebGL2.", error);
    }
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2", {
    antialias,
    alpha,
    depth,
    stencil,
    powerPreference: "high-performance",
  });

  if (!context) {
    throw new Error("WebGL2 context is unavailable. Restart the browser or close other GPU-heavy tabs, then reload this page.");
  }

  const renderer = new THREE.WebGPURenderer({
    ...baseOptions,
    forceWebGL: true,
    canvas,
    context,
  });
  await renderer.init();
  renderer.userData = renderer.userData || {};
  renderer.userData.backendLabel = "WebGL2";
  return renderer;
}

export function getRendererBackendLabel(renderer) {
  if (renderer?.userData?.backendLabel) return renderer.userData.backendLabel;
  if (renderer?.backend?.isWebGPUBackend) return "WebGPU";
  if (renderer?.backend?.isWebGLBackend) return "WebGL2";
  return "Renderer";
}