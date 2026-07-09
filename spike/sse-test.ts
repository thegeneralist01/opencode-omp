/**
 * Spike v4: collect ALL part updates, resolve roles post-hoc at session.idle,
 * then report per-model whether assistant text is streamed incrementally.
 * Run: bun spike/sse-test.ts [modelID]   (default: deepseek-v4-flash-free)
 * Run all: for m in deepseek-v4-flash-free mimo-v2.5-free nemotron-3-super-free big-pickle; do bun spike/sse-test.ts $m; done
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const MODEL_ID = process.argv[2] ?? "deepseek-v4-flash-free";
const PORT = 49000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

console.log(`\n=== Model: opencode/${MODEL_ID} ===`);
console.log(`Starting opencode serve on port ${PORT}…`);

const server = spawn("opencode", ["serve", `--port=${PORT}`], {
  env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("server start timeout")), 10_000);
  const onData = (chunk: Buffer) => {
    if (chunk.toString().includes("listening")) {
      clearTimeout(timer); server.stdout!.off("data", onData); resolve();
    }
  };
  server.stdout!.on("data", onData);
  server.on("error", reject);
});

const sessResp = await fetch(`${BASE}/session`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
});
const session = await sessResp.json() as { id: string };

// Collect everything; resolve roles post-hoc at session.idle
const messageRole = new Map<string, string>();
type PartEvent = { ms: number; partID: string; messageID: string; text: string };
const partEvents: PartEvent[] = [];
const partText = new Map<string, string>();
const t0 = Date.now();
let idle = false;

const evtResp = await fetch(`${BASE}/event`);
const reader = evtResp.body!.getReader();
const dec = new TextDecoder();
let rem = "";

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
      let ev: { type: string; properties?: Record<string, unknown> };
      try { ev = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
      const ms = Date.now() - t0;

      if (ev.type === "message.updated") {
        const info = (ev.properties as { info?: { id?: string; role?: string; sessionID?: string } })?.info;
        if (info?.id && info?.role && info?.sessionID === session.id)
          messageRole.set(info.id, info.role);
      }

      if (ev.type === "message.part.updated") {
        const p = (ev.properties as { part?: Record<string, unknown> })?.part;
        if (!p || p.type !== "text" || p.sessionID !== session.id) continue;
        const partID = p.id as string;
        const msgID = p.messageID as string;
        const newText = (p.text as string) ?? "";
        const prev = partText.get(partID) ?? "";
        const delta = newText.slice(prev.length);
        partText.set(partID, newText);
        if (delta) partEvents.push({ ms, partID, messageID: msgID, text: delta });
      }

      if (ev.type === "session.idle") { idle = true; }
    }
  }
})();

await sleep(300);
await fetch(`${BASE}/session/${session.id}/prompt_async`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: { providerID: "opencode", modelID: MODEL_ID },
    tools: { bash: false, edit: false, read: false, glob: false, grep: false,
             list: false, task: false, webfetch: false, websearch: false, todowrite: false },
    parts: [{ type: "text", text: "Explain in detail how TCP/IP works, covering the handshake, packet routing, congestion control, and error recovery. Be thorough." }],
  }),
});

await new Promise<void>(resolve => {
  const iv = setInterval(() => { if (idle) { clearInterval(iv); resolve(); } }, 50);
  setTimeout(() => { clearInterval(iv); resolve(); }, 30_000);
});
reader.cancel();
server.kill();

// Post-hoc: filter to assistant-role parts only
const assistantDeltas = partEvents.filter(e => messageRole.get(e.messageID) === "assistant");

// Also show unknown-role deltas so we can debug if role mapping missed them
const unknownDeltas = partEvents.filter(e => !messageRole.has(e.messageID));

const spread = assistantDeltas.length > 1
  ? assistantDeltas.at(-1)!.ms - assistantDeltas[0]!.ms : 0;

console.log(`Role map: ${[...messageRole.entries()].map(([id, r]) => `${id.slice(-4)}=${r}`).join(", ")}`);
console.log(`All text part events:    ${partEvents.length} (unknown-role: ${unknownDeltas.length})`);
console.log(`Assistant delta chunks:  ${assistantDeltas.length}`);
if (assistantDeltas.length) {
  assistantDeltas.forEach(d => console.log(`  [${d.ms}ms] ${JSON.stringify(d.text.slice(0, 50))}`));
}
console.log(`Time spread (ms):        ${spread}`);
console.log(`Real streaming:          ${assistantDeltas.length > 1 && spread > 200 ? "YES ✓" : "NO ✗"}`);
process.exit(assistantDeltas.length > 1 && spread > 200 ? 0 : 1);
