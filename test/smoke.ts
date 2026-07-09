/**
 * Smoke test for the event-bridge protocol.
 * Run with: bun test/smoke.ts
 *
 * Uses a fake opencode binary (Bun HTTP server) so no real model call is made.
 * Verifies the bridge correctly handles all covered paths:
 *
 *   1. Prose — role filtering, buffering path, dual event-shape dispatch,
 *      snapshot-only diffing, and final text correctness.
 *        • User-message decoys (flat + updated shapes) must NOT appear.
 *        • First assistant delta buffered before message.updated, then flushed.
 *        • Second delta via message.part.updated WITH delta field.
 *        • Third delta via message.part.updated WITHOUT delta (snapshot diff).
 *        • Final text = "Hello, world!"
 *
 *   2. Tool-call — gating sees '<', stays buffered, emits no text events,
 *      toolcall_end / done(toolUse).
 *        • User decoy also filtered here.
 *        • Tool-call delta buffered then flushed; gating detects '<'.
 *
 * Between cases the singleton server is killed via the registered
 * `session_shutdown` handler so the toolcall case spawns a fresh child
 * inheriting the updated FAKE_OC_MODE env var.
 *
 * Note on partial-snapshot timing: `partial` is a mutable reference shared
 * across all events. The `for await` consumer resumes in a microtask; by then
 * all synchronous work for that data burst is complete. We verify the
 * observable protocol (event ordering, delta content, final text) not the
 * mutable partial snapshot at a specific event.
 */
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import openCodeOmpExtension from "../src/index.ts";

// ---------------------------------------------------------------------------
// Fake binary — Bun HTTP server, already chmod +x'd
// ---------------------------------------------------------------------------

process.env.OPENCODE_OMP_BIN = join(import.meta.dirname, "fake-opencode.ts");

// ---------------------------------------------------------------------------
// Capture streamSimple and event handlers from the extension
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

const context: Context = {
  systemPrompt: ["You are a helpful assistant."],
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

// ---------------------------------------------------------------------------
// Path 1: prose
//   Exercises: role filter, buffering path, both event shapes, snapshot diff.
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
  if (startIdx === -1)
    throw new Error("prose: missing text_start");
  if (deltaIdxs.length < 3)
    throw new Error(`prose: expected ≥3 text_delta (Hello + ", world" + "!"), got ${deltaIdxs.length}: ${JSON.stringify(deltas)}`);
  if (endIdx === -1)
    throw new Error("prose: missing text_end");
  if (doneIdx === -1)
    throw new Error("prose: missing done");
  if (startIdx > deltaIdxs[0]!)
    throw new Error("prose: text_start after first delta");
  if (endIdx < deltaIdxs.at(-1)!)
    throw new Error("prose: text_end before last delta");
  if (startIdx > endIdx)
    throw new Error("prose: text_start after text_end");
  if (endIdx > doneIdx)
    throw new Error("prose: text_end after done");

  // ── Role filter: decoy text must NOT appear in any delta ─────────────────
  if (deltas.join("").includes("DECOY"))
    throw new Error(`prose: decoy text leaked into deltas: ${JSON.stringify(deltas)}`);

  // ── Buffering path: first delta was buffered, flushed after message.updated ─
  if (!deltas.includes("Hello"))
    throw new Error(`prose: expected buffered "Hello" delta, got ${JSON.stringify(deltas)}`);

  // ── SDK updated-shape with delta ─────────────────────────────────────────
  if (!deltas.includes(", world"))
    throw new Error(`prose: expected ", world" delta (message.part.updated with delta), got ${JSON.stringify(deltas)}`);

  // ── Snapshot-only diff: derives "!" from part.text without delta field ────
  if (!deltas.includes("!"))
    throw new Error(`prose: expected "!" delta (snapshot-only message.part.updated), got ${JSON.stringify(deltas)}`);

  // ── Final text = exact concatenation, no duplication ─────────────────────
  const expectedText = "Hello, world!";
  if (finalText !== expectedText)
    throw new Error(`prose: text_end.content "${finalText}" ≠ "${expectedText}"`);
  if (deltas.join("") !== expectedText)
    throw new Error(`prose: concat of deltas "${deltas.join("")}" ≠ "${expectedText}"`);

  if (doneReason !== "stop")
    throw new Error(`prose: done.reason="${doneReason}"`);

  console.log(`✓ prose: start → delta(×${deltaIdxs.length}: ${JSON.stringify(deltas)}) → end("${finalText}") → done(stop)`);
}

// Kill the singleton server so the toolcall case spawns a fresh child that
// inherits the updated FAKE_OC_MODE env var.
await eventHandlers.get("session_shutdown")?.();
process.env.FAKE_OC_MODE = "toolcall";

// ---------------------------------------------------------------------------
// Path 2: tool-call
//   Role filter + buffering path also exercised here (tool delta buffered).
//   Gating commits to "buffered" on '<'; no text events emitted.
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

  console.log(`✓ toolcall: no text events → toolcall_end(${toolName}, args: ${JSON.stringify(toolArgs)}) → done(toolUse)`);
}

// Kill the second fake server child so the process exits cleanly.
await eventHandlers.get("session_shutdown")?.();

console.log("\nAll smoke tests passed.");
