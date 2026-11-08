// 批量生成演示图（本地 chatgpt2api 网关）。密钥只从环境变量或 /tmp 读取，不入库。
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.IC_IMG_BASE || "http://127.0.0.1:3000";
const KEY = process.env.IC_IMG_KEY || (fs.existsSync("/tmp/ic_key.txt") ? fs.readFileSync("/tmp/ic_key.txt", "utf8").trim() : "");
const MODEL = process.env.IC_IMG_MODEL || "gpt-image-2.6";
const OUT = path.resolve("assets/raw");
if (!KEY) throw new Error("missing key");

const STYLE = "Flat vector editorial poster illustration, soft paper grain texture, warm autumn palette of cream, burnt orange and espresso brown, generous negative space, minimal geometric shapes, high quality, no text, no letters, no watermark, no logo.";
const MASCOT = "a cute small orange blob mascot: wide rounded-rectangle body in flat vivid orange (#E8703A), two small black square eyes, two stubby round feet, no mouth";

const tasks = [];
const series = [
  `the orange blob mascot sitting beside a steaming ceramic coffee cup on a wooden table, fallen maple leaves around`,
  `the orange blob mascot peeking out from behind a takeaway paper coffee cup`,
  `the orange blob mascot sitting on a small burlap sack of coffee beans`,
  `the orange blob mascot standing on a cafe counter with an espresso machine silhouette behind`,
  `the orange blob mascot holding up a tiny blank menu card`,
  `the orange blob mascot under an autumn tree with falling orange leaves`,
  `the orange blob mascot peeking out from inside a big ceramic coffee cup`,
  `the orange blob mascot next to a croissant on a plate`,
  `the orange blob mascot on a windowsill with a rainy window behind`,
  `the orange blob mascot carrying a paper bag of coffee beans`,
  `the orange blob mascot walking along a wooden shelf with glass jars`,
  `the orange blob mascot beside a coffee cup with a coffee ring stain on the table`,
];
series.forEach((scene, i) => {
  tasks.push({ out: `poster-autumn-${String(i + 1).padStart(2, "0")}.png`, size: "1536x1024", prompt: scene.replace(/the orange blob mascot/g, MASCOT) + ". " + STYLE });
});
const blueScenes = [
  `${MASCOT} sitting beside a steaming coffee cup on a dark blue night table with a warm lamp glow`,
  `${MASCOT} peeking out from behind a takeaway cup under deep blue evening light with warm rim light`,
];
blueScenes.forEach((scene, i) => tasks.push({ out: `chat-result-blue-0${i + 1}.png`, size: "1536x1024", prompt: scene + ". Flat vector editorial illustration, deep navy blue and warm amber palette, soft grain, minimal, no text, no letters, no watermark." }));
tasks.push({ out: "chat-result-autumn-01.png", size: "1536x1024", prompt: series[0].replace(/the orange blob mascot/g, MASCOT) + ". " + STYLE });
tasks.push({ out: "chat-result-autumn-02.png", size: "1536x1024", prompt: series[6].replace(/the orange blob mascot/g, MASCOT) + ". " + STYLE });
tasks.push({ out: "artifact-poster.png", size: "1536x1024", prompt: series[1].replace(/the orange blob mascot/g, MASCOT) + ". " + STYLE });
const squares = [
  `${MASCOT} close-up portrait beside a coffee cup, cream background`,
  `${MASCOT} with autumn leaves falling around, square composition`,
  `${MASCOT} sitting on a saucer next to espresso`,
  `${MASCOT} under a warm lamp with coffee beans`,
];
squares.forEach((scene, i) => tasks.push({ out: `image-result-0${i + 1}.png`, size: "1024x1024", prompt: scene + ". " + STYLE }));
tasks.push({ out: "image-ref.png", size: "1024x1024", prompt: `${MASCOT} holding a small coffee cup, square close-up. ` + STYLE });

const CONCURRENCY = Number(process.env.IC_IMG_CONCURRENCY || 3);
let idx = 0, done = 0, failed = [];
async function worker() {
  while (idx < tasks.length) {
    const task = tasks[idx++];
    if (fs.existsSync(path.join(OUT, task.out))) { done++; continue; }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const t0 = Date.now();
        const res = await fetch(`${BASE}/v1/images/generations`, {
          method: "POST",
          headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: MODEL, prompt: task.prompt, size: task.size, n: 1, response_format: "b64_json" }),
        });
        const text = await res.text();
        let json; try { json = JSON.parse(text); } catch { throw new Error("bad json " + text.slice(0, 200)); }
        if (json.error) throw new Error(JSON.stringify(json.error).slice(0, 200));
        const item = (json.data || [])[0] || {};
        if (!item.b64_json) throw new Error("no b64 " + text.slice(0, 120));
        fs.writeFileSync(path.join(OUT, task.out), Buffer.from(item.b64_json, "base64"));
        done++;
        console.log(`[OK ${done}/${tasks.length}] ${task.out} ${(Date.now() - t0) / 1000}s`);
        break;
      } catch (e) {
        console.log(`[retry ${attempt + 1}] ${task.out}: ${e.message}`);
        if (attempt === 2) failed.push(task.out);
      }
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`DONE ${done}/${tasks.length} failed=${failed.join(",") || "none"}`);
