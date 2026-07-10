/**
 * Smoke test for the event-bridge protocol.
 * Run with: bun test/smoke.ts
 *
 * Uses a fake opencode HTTP server so no real model call is made.
 * Covers four invariants:
 *
 *  1. prose     — role filter, buffering, dual event shapes, snapshot diff.
 *  2. toolcall  — gating sees '<', buffered, tool emitted, no text events.
 *  3. mixed     — tool-capable turn: hasTool=true buffers all text so NO
 *                 text_delta events appear; reasoning flushed from
 *                 pendingReasoningDeltas via thinking_*; tool call detected
 *                 at session.idle; done(toolUse).
 *
 * Between cases the singleton server is killed via the captured
 * `session_shutdown` handler so each case spawns a fresh child inheriting
 * the updated FAKE_OC_MODE env var.
 */
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, Context, Model, Tool } from "@oh-my-pi/pi-ai";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import openCodeOmpExtension from "../src/index.ts";

// ---------------------------------------------------------------------------
// Fake binary — Bun HTTP server, already chmod +x'd
// ---------------------------------------------------------------------------

process.env.OPENCODE_OMP_BIN = join(import.meta.dirname, "fake-opencode.ts");

// ---------------------------------------------------------------------------
// Capture streamSimple and event handlers
// ---------------------------------------------------------------------------

type StreamSimple = (model: Model<Api>, context: Context) => AssistantMessageEventStream;
type EventHandler = (...args: unknown[]) => unknown;

let streamSimple: StreamSimple | undefined;
const eventHandlers = new Map<string, EventHandler>();

const mockPi = {
  registerProvider(_name: string, config: Record<string, unknown>) {
    streamSimple = config.streamSimple as StreamSimple;
  },
  on(event: string, handler: EventHandler) {
    eventHandlers.set(event, handler);
  },
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

/** No tools — gating buffer and streaming paths. */
const context: Context = {
  systemPrompt: ["You are a helpful assistant."],
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

/** Has tools — hasTool=true path: buffer all text, emit at session.idle. */
const contextWithTools: Context = {
  systemPrompt: ["You are a helpful assistant."],
  messages: [{ role: "user", content: "explain this repo" }],
  tools: [{ name: "read", description: "Read a file or directory", parameters: { type: "object", properties: { path: { type: "string" }, i: { type: "string" } }, required: ["path", "i"] } }] as Tool[],
};

// ---------------------------------------------------------------------------
// Path 1: prose (no tools)
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

  if (startIdx === -1) throw new Error("prose: missing text_start");
  if (deltaIdxs.length < 3) throw new Error(`prose: expected ≥3 text_delta, got ${deltaIdxs.length}: ${JSON.stringify(deltas)}`);
  if (endIdx === -1) throw new Error("prose: missing text_end");
  if (doneIdx === -1) throw new Error("prose: missing done");
  if (startIdx > deltaIdxs[0]!) throw new Error("prose: text_start after first delta");
  if (endIdx < deltaIdxs.at(-1)!) throw new Error("prose: text_end before last delta");
  if (endIdx > doneIdx) throw new Error("prose: text_end after done");

  if (deltas.join("").includes("DECOY"))
    throw new Error(`prose: decoy text leaked: ${JSON.stringify(deltas)}`);
  if (!deltas.includes("Hello"))
    throw new Error(`prose: expected buffered "Hello" delta, got ${JSON.stringify(deltas)}`);
  if (!deltas.includes(", world"))
    throw new Error(`prose: expected ", world" delta (updated with delta), got ${JSON.stringify(deltas)}`);
  if (!deltas.includes("!"))
    throw new Error(`prose: expected "!" delta (snapshot diff), got ${JSON.stringify(deltas)}`);

  const expectedText = "Hello, world!";
  if (finalText !== expectedText) throw new Error(`prose: text_end.content "${finalText}" ≠ "${expectedText}"`);
  if (deltas.join("") !== expectedText) throw new Error(`prose: delta concat "${deltas.join("")}" ≠ "${expectedText}"`);
  if (doneReason !== "stop") throw new Error(`prose: done.reason="${doneReason}"`);

  console.log(`✓ prose: start → delta(×${deltaIdxs.length}: ${JSON.stringify(deltas)}) → end("${finalText}") → done(stop)`);
}

await eventHandlers.get("session_shutdown")?.();
process.env.FAKE_OC_MODE = "toolcall";

// ---------------------------------------------------------------------------
// Path 2: toolcall (no tools — gating buffer path)
// ---------------------------------------------------------------------------

{
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

  if (types.includes("text_start"))    throw new Error("toolcall: unexpected text_start");
  if (types.includes("text_delta"))    throw new Error("toolcall: unexpected text_delta");
  if (!types.includes("toolcall_end")) throw new Error("toolcall: missing toolcall_end");
  if (toolName !== "bash")             throw new Error(`toolcall: tool name "${toolName}"`);
  if (doneReason !== "toolUse")        throw new Error(`toolcall: done.reason="${doneReason}"`);

  console.log(`✓ toolcall: no text → toolcall_end(${toolName}, ${JSON.stringify(toolArgs)}) → done(toolUse)`);
}

await eventHandlers.get("session_shutdown")?.();
process.env.FAKE_OC_MODE = "mixed";

// ---------------------------------------------------------------------------
// Path 3: mixed (tools in context → hasTool=true)
//   Verifies:
//   • reasoning delta arrives BEFORE assistant message.updated → buffered in
//     pendingReasoningDeltas → flushed on message.updated confirmation
//   • second reasoning delta via snapshot diff (no delta field)
//   • thinking_start / thinking_delta(×2) / thinking_end fire
//   • NO text_delta events (hasTool buffers all text)
//   • toolcall_end(read) + done(toolUse)
// ---------------------------------------------------------------------------

{
  const stream = streamSimple(model, contextWithTools);

  const types: string[] = [];
  const thinkingDeltas: string[] = [];
  let toolName = "<not seen>";
  let doneReason = "<not seen>";

  for await (const ev of stream) {
    const e = ev as Record<string, unknown>;
    types.push(e.type as string);
    if (e.type === "thinking_delta") thinkingDeltas.push(e.delta as string);
    if (e.type === "toolcall_end") toolName = (e.toolCall as Record<string, unknown>).name as string;
    if (e.type === "done") doneReason = e.reason as string;
  }

  // No text events — hasTool=true suppresses mid-stream text_delta.
  if (types.includes("text_delta"))
    throw new Error(`mixed: text_delta leaked (hasTool must buffer): ${JSON.stringify(types)}`);

  // Reasoning routed through thinking channel.
  if (!types.includes("thinking_start"))
    throw new Error("mixed: missing thinking_start");
  if (thinkingDeltas.length < 2)
    throw new Error(`mixed: expected ≥2 thinking_delta, got ${thinkingDeltas.length}: ${JSON.stringify(thinkingDeltas)}`);
  if (!types.includes("thinking_end"))
    throw new Error("mixed: missing thinking_end");

  // First reasoning delta was buffered before message.updated, then flushed.
  if (!thinkingDeltas.join("").includes("The user wants to explore"))
    throw new Error(`mixed: pre-confirmation reasoning missing from thinking_delta: ${JSON.stringify(thinkingDeltas)}`);
  // Second reasoning delta from snapshot diff.
  if (!thinkingDeltas.join("").includes("I should read it"))
    throw new Error(`mixed: snapshot-diff reasoning missing from thinking_delta: ${JSON.stringify(thinkingDeltas)}`);

  // Tool call detected at session.idle, emitted cleanly.
  if (!types.includes("toolcall_end"))
    throw new Error("mixed: missing toolcall_end");
  if (toolName !== "read")
    throw new Error(`mixed: expected tool "read", got "${toolName}"`);
  if (doneReason !== "toolUse")
    throw new Error(`mixed: done.reason="${doneReason}"`);

  console.log(`✓ mixed: thinking_delta(×${thinkingDeltas.length}) → no text_delta → toolcall_end(${toolName}) → done(toolUse)`);
}

// Kill server so the process exits cleanly.
await eventHandlers.get("session_shutdown")?.();

console.log("\nAll smoke tests passed.");
