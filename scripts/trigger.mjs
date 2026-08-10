import { readFile } from "node:fs/promises";

const envPath = new URL("../.env", import.meta.url);

function parseEnv(source) {
  const values = new Map();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

let envSource;
try {
  envSource = await readFile(envPath, "utf8");
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    console.error("未找到仓库根目录的 .env，请先写入 MANUAL_TRIGGER_TOKEN。");
    process.exit(1);
  }
  throw error;
}

const token = parseEnv(envSource).get("MANUAL_TRIGGER_TOKEN");
if (!token) {
  console.error(".env 缺少 MANUAL_TRIGGER_TOKEN，请先配置后再运行。");
  process.exit(1);
}

const workerUrl = process.argv[2] ?? process.env.WORKER_URL;
if (!workerUrl) {
  console.error("缺少 Worker URL。请设置 WORKER_URL，或运行 npm run trigger -- https://<worker>.workers.dev。");
  process.exit(1);
}

let endpoint;
try {
  const url = new URL(workerUrl);
  url.pathname = "/trigger-run";
  url.search = "";
  url.hash = "";
  endpoint = url.toString();
} catch {
  console.error("Worker URL 无效。");
  process.exit(1);
}

try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(`HTTP ${response.status}`);
  const responseText = await response.text();
  try {
    console.log(JSON.stringify(JSON.parse(responseText), null, 2));
  } catch {
    console.error("响应不是有效 JSON。");
    process.exitCode = 1;
  }
  if (!response.ok) {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "未知网络错误";
  console.error(`触发失败：${message}`);
  process.exitCode = 1;
}
