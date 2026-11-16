"use strict";

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const python = process.env.HFA_PYTHON || (process.platform === "win32" ? "python" : "python3");
const viteBin = join(projectRoot, "node_modules", "vite", "bin", "vite.js");

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

let backend;
let frontend;
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  frontend?.kill();
  backend?.kill();
  setTimeout(() => process.exit(code), 1000).unref();
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

try {
  const port = await availablePort();
  backend = spawn(python, ["-m", "func.app", "--port", String(port), "--no-browser"], {
    cwd: projectRoot,
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  backend.on("error", (error) => {
    console.error(`Не вдалося запустити Python API: ${error.message}`);
    stop(1);
  });
  backend.on("exit", (code) => { if (!stopping) stop(code || 1); });

  let started = false;
  backend.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    if (started || !String(chunk).includes("Hromada Finance Atlas:")) return;
    started = true;
    frontend = spawn(process.execPath, [viteBin, "--host", "127.0.0.1"], {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, HFA_API_PORT: String(port) },
    });
    frontend.on("error", (error) => {
      console.error(`Не вдалося запустити Vite: ${error.message}`);
      stop(1);
    });
    frontend.on("exit", (code) => { if (!stopping) stop(code || 1); });
  });
} catch (error) {
  console.error(`Не вдалося запустити dev-сервер: ${error.message}`);
  stop(1);
}
