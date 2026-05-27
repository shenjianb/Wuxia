import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const animationAssetsPath = path.resolve(projectRoot, "public/assets/animations");
const motionConfigPath = path.resolve(animationAssetsPath, "motion_config.json");

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

export default defineConfig({
  base: "./",
  plugins: [motionConfigApi()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(projectRoot, "index.html"),
        motionEditor: path.resolve(projectRoot, "motion-editor.html"),
      },
    },
  },
});
