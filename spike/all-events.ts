/**
 * Spike: log EVERY SSE event type during a real opencode run.
 * Identifies what events are actually available on /event.
 * bun spike/all-events.ts
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 49000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = process.argv[2] ?? "deepseek-v4-flash-free";

console.log(`Model: opencode/${MODEL}  Port: ${PORT}`);
const server = spawn("opencode", ["serve", `--port=${PORT}`], {
  env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timeout")), 10_000);
  server.stdout!.on("data", (c: Buffer) => {
    if (c.toString().includes("listening")) { clearTimeout(t); resolve(); }
  });
  server.on("error", reject);
});

const sess = await (await fetch(`${BASE}/session`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
})).json() as { id: string };

// Open SSE before sending prompt
const evtResp = await fetch(`${BASE}/event`);
const reader = evtResp.body!.getReader();
const dec = new TextDecoder();
let rem = "";
const seen = new Map<string, number>(); // type → count
const t0 = Date.now();
let idle = false;

const sseTask = (async () => {
  while (!idle) {
    const { done, value } = await reader.read();
    if (done) break;
    rem += dec.decode(value, { stream: true });
    const blocks = rem.split(/\n\n/);
    rem = blocks.pop() ?? "";
    for (const block of blocks) {
      const dataLine = block.split("\n").find(l => l.startsWith("data:"));
      if (!dataLine) continue;
      try {
        const ev = JSON.parse(dataLine.slice(5).trim()) as { type: string; properties?: unknown };
        const ms = Date.now() - t0;
        seen.set(ev.type, (seen.get(ev.type) ?? 0) + 1);
        // Print every unique type first time, and delta/part types every time
        const isDeltaOrPart = ev.type.includes("delta") || ev.type.includes("part");
        if (isDeltaOrPart || seen.get(ev.type) === 1) {
          const props = JSON.stringify(ev.properties).slice(0, 120);
          console.log(`[${ms}ms] ${ev.type} ${props}`);
        }
        if (ev.type === "session.idle") idle = true;
      } catch { /**/ }
    }
  }
})();

await sleep(300);
await fetch(`${BASE}/session/${sess.id}/prompt_async`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: { providerID: "opencode", modelID: MODEL },
    tools: { bash: false, edit: false, read: false, glob: false,
             grep: false, list: false, task: false, webfetch: false,
             websearch: false, todowrite: false },
    parts: [{ type: "text", text: "Explain in detail how TCP/IP works, covering handshake, routing, congestion control, error recovery." }],
  }),
});

await new Promise<void>(r => {
  const iv = setInterval(() => { if (idle) { clearInterval(iv); r(); } }, 50);
  setTimeout(() => { clearInterval(iv); r(); }, 30_000);
});
reader.cancel();
server.kill();

console.log("\n=== ALL EVENT TYPES SEEN ===");
[...seen.entries()].sort((a, b) => b[1] - a[1])
  .forEach(([t, n]) => console.log(`  ${n.toString().padStart(4)}x  ${t}`));
