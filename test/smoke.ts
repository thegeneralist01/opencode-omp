/**
 * Smoke test for the gating-buffer streaming logic.
 * Run with: bun test/smoke.ts
 *
 * Uses a fake opencode binary so no real model call is made.
 * Covers two paths:
 *   1. Prose response  → text_start / text_delta(×N) / text_end / done(stop)
 *                        with correct delta strings and no duplication
 *   2. Tool-call response → no text events, toolcall_end / done(toolUse)
 *
 * Note on partial-snapshot timing: `partial` is a mutable reference shared
 * across all events. The `for await` consumer resumes in a microtask; by then
 * all synchronous `handleLine` work for that data burst is complete. Testing
 * partial.content at a specific event is therefore unreliable — we verify the
 * observable protocol instead: event ordering, delta content, final text.
 */
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
// Static import works: discoverModels() runs inside the factory call, not at
// module evaluation, so setting the env var here is sufficient.
import openCodeOmpExtension from "../src/index.ts";

// ---------------------------------------------------------------------------
// Fake binary — chmod +x'd alongside this file
// ---------------------------------------------------------------------------

process.env.OPENCODE_OMP_BIN = join(import.meta.dirname, "fake-opencode.sh");

// ---------------------------------------------------------------------------
// Capture streamSimple from the extension
// ---------------------------------------------------------------------------

type StreamSimple = (model: Model<Api>, context: Context) => AssistantMessageEventStream;

let streamSimple: StreamSimple | undefined;

const mockPi = {
  registerProvider(_name: string, config: Record<string, unknown>) {
    streamSimple = config.streamSimple as StreamSimple;
  },
  on() {},
  registerCommand() {},
} satisfies Partial<ExtensionAPI> as unknown as ExtensionAPI;

await openCodeOmpExtension(mockPi);
if (!streamSimple) throw new Error("registerProvider was not called");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const model = {
  api: "opencode-cli-runner" as Api,
  provider: "opencode-cli",
  id: "opencode/deepseek-v4-flash-free",
} as unknown as Model<Api>;

const context: Context = {
  systemPrompt: ["You are a helpful assistant."],
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

// ---------------------------------------------------------------------------
// Path 1: prose — gating commits to streaming after first non-WS non-< char
// ---------------------------------------------------------------------------

{
  process.env.FAKE_OC_MODE = "prose";
  const stream = streamSimple(model, context);

  const types: string[] = [];
  const deltas: string[] = [];
  let finalText = "<not seen>";
  let doneReason = "<not seen>";

  for await (const ev of stream) {
    const e = ev as Record<string, unknown>;
    types.push(e.type as string);
    if (e.type === "text_delta") deltas.push(e.delta as string);
    if (e.type === "text_end")   finalText = e.content as string;
    if (e.type === "done")       doneReason = e.reason as string;
  }

  const startIdx  = types.indexOf("text_start");
  const deltaIdxs = types.reduce<number[]>((a, t, i) => (t === "text_delta" ? [...a, i] : a), []);
  const endIdx    = types.indexOf("text_end");
  const doneIdx   = types.indexOf("done");

  // Ordering
  if (startIdx === -1)                      throw new Error("prose: missing text_start");
  if (deltaIdxs.length < 2)                 throw new Error(`prose: expected ≥2 text_delta, got ${deltaIdxs.length}`);
  if (endIdx === -1)                         throw new Error("prose: missing text_end");
  if (doneIdx === -1)                        throw new Error("prose: missing done");
  if (startIdx > deltaIdxs[0])              throw new Error("prose: text_start after first delta");
  if (endIdx < deltaIdxs.at(-1)!)           throw new Error("prose: text_end before last delta");
  if (startIdx > endIdx)                    throw new Error("prose: text_start after text_end");
  if (endIdx > doneIdx)                     throw new Error("prose: text_end after done");

  // Delta content: each delta from the fake binary arrives separately — no merge
  if (!deltas.includes("Hello"))             throw new Error(`prose: expected "Hello" delta, got ${JSON.stringify(deltas)}`);
  if (!deltas.includes(", world"))           throw new Error(`prose: expected ", world" delta, got ${JSON.stringify(deltas)}`);

  // Final text equals concatenation of all deltas — no duplication
  const concatenated = deltas.join("");
  if (finalText !== concatenated)
    throw new Error(`prose: text_end.content "${finalText}" ≠ concat of deltas "${concatenated}"`);

  // done carries stop reason
  if (doneReason !== "stop")                 throw new Error(`prose: done.reason="${doneReason}"`);

  console.log(`✓ prose: start → delta(×${deltaIdxs.length}: ${JSON.stringify(deltas)}) → end("${finalText}") → done(stop)`);
}

// ---------------------------------------------------------------------------
// Path 2: tool-call — gating sees '<', stays buffered, emits no text events
// ---------------------------------------------------------------------------

{
  process.env.FAKE_OC_MODE = "toolcall";
  const stream = streamSimple(model, context);

  const types: string[] = [];
  let toolName = "<not seen>";
  let toolArgs: unknown = undefined;
  let doneReason = "<not seen>";

  for await (const ev of stream) {
    const e = ev as Record<string, unknown>;
    types.push(e.type as string);
    if (e.type === "toolcall_end") {
      const tc = e.toolCall as Record<string, unknown>;
      toolName = tc.name as string;
      toolArgs = tc.arguments;
    }
    if (e.type === "done") doneReason = e.reason as string;
  }

  if (types.includes("text_start"))   throw new Error("toolcall: unexpected text_start");
  if (types.includes("text_delta"))   throw new Error("toolcall: unexpected text_delta");
  if (!types.includes("toolcall_end")) throw new Error("toolcall: missing toolcall_end");
  if (toolName !== "bash")            throw new Error(`toolcall: tool name "${toolName}"`);
  if (doneReason !== "toolUse")       throw new Error(`toolcall: done.reason="${doneReason}"`);

  console.log(`✓ toolcall: no text events → toolcall_end(${toolName}, args: ${JSON.stringify(toolArgs)}) → done(toolUse)`);
}

console.log("\nAll smoke tests passed.");
