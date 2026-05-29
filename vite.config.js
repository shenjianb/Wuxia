import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const animationAssetsPath = path.resolve(projectRoot, "public/assets/animations");
const motionConfigPath = path.resolve(animationAssetsPath, "motion_config.json");
const scenesPath = path.resolve(projectRoot, "public/assets/scenes");

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function motionConfigApi() {
  return {
    name: "motion-config-api",
    configureServer(server) {
      server.middlewares.use("/api/animation-assets", async (req, res) => {
        try {
          if (req.method !== "GET") {
            res.statusCode = 405;
            res.setHeader("Allow", "GET");
            res.end();
            return;
          }

          const entries = await fs.readdir(animationAssetsPath, { withFileTypes: true });
          const files = entries
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".glb"))
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b));
          sendJson(res, 200, { files });
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
      });

      server.middlewares.use("/api/motion-config", async (req, res) => {
        try {
          if (req.method === "GET") {
            const file = await fs.readFile(motionConfigPath, "utf8");
            sendJson(res, 200, JSON.parse(file));
            return;
          }

          if (req.method === "PUT" || req.method === "POST") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            const config = payload.config ?? payload;

            if (!config || Array.isArray(config) || typeof config !== "object") {
              sendJson(res, 400, { error: "Motion config must be a JSON object." });
              return;
            }

            await fs.writeFile(motionConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
            sendJson(res, 200, { ok: true });
            return;
          }

          res.statusCode = 405;
          res.setHeader("Allow", "GET, PUT, POST");
          res.end();
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
      });
    },
  };
}

function scenesApi() {
  return {
    name: "scenes-api",
    configureServer(server) {
      server.middlewares.use("/api/scenes", async (req, res) => {
        try {
          const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
          const pathParts = url.pathname.replace("/api/scenes", "").replace(/^\/+/, "");
          const sceneName = decodeURIComponent(pathParts);

          if (!sceneName && req.method === "GET") {
            await fs.mkdir(scenesPath, { recursive: true });
            const entries = await fs.readdir(scenesPath, { withFileTypes: true });
            const scenes = [];
            for (const entry of entries) {
              if (entry.isFile() && entry.name.endsWith(".json")) {
                try {
                  const content = await fs.readFile(path.join(scenesPath, entry.name), "utf8");
                  const data = JSON.parse(content);
                  scenes.push({
                    name: data.name || entry.name.replace(".json", ""),
                    created: data.created || "",
                    modified: data.modified || "",
                  });
                } catch {
                  scenes.push({ name: entry.name.replace(".json", ""), created: "", modified: "" });
                }
              }
            }
            sendJson(res, 200, { scenes });
            return;
          }

          if (!sceneName) {
            res.statusCode = 400;
            sendJson(res, 400, { error: "Scene name is required." });
            return;
          }

          const safeName = sceneName.replace(/[<>:"/\\|?*]/g, "_");
          const filePath = path.join(scenesPath, `${safeName}.json`);

          if (req.method === "GET") {
            try {
              const content = await fs.readFile(filePath, "utf8");
              sendJson(res, 200, JSON.parse(content));
            } catch {
              res.statusCode = 404;
              sendJson(res, 404, { error: `Scene "${sceneName}" not found.` });
            }
            return;
          }

          if (req.method === "PUT" || req.method === "POST") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            if (!payload || typeof payload !== "object") {
              sendJson(res, 400, { error: "Scene data must be a JSON object." });
              return;
            }
            payload.name = payload.name || sceneName;
            payload.modified = new Date().toISOString();
            payload.created = payload.created || payload.modified;
            await fs.mkdir(scenesPath, { recursive: true });
            await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
            sendJson(res, 200, { ok: true });
            return;
          }

          if (req.method === "DELETE") {
            try {
              await fs.unlink(filePath);
              sendJson(res, 200, { ok: true });
            } catch {
              res.statusCode = 404;
              sendJson(res, 404, { error: `Scene "${sceneName}" not found.` });
            }
            return;
          }

          res.statusCode = 405;
          res.setHeader("Allow", "GET, PUT, DELETE");
          res.end();
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [motionConfigApi(), scenesApi()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(projectRoot, "index.html"),
        motionEditor: path.resolve(projectRoot, "motion-editor.html"),
        sceneEditor: path.resolve(projectRoot, "scene-editor.html"),
      },
    },
  },
});
