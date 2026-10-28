#!/usr/bin/env bun
/**
 * Fake opencode binary for smoke testing.
 *
 * Handles:
 *   models opencode  — model discovery
 *   serve --port=N   — minimal HTTP server for the SSE bridge
 *
 * IMPORTANT: `FAKE_OC_MODE` is read per-request inside `buildSseBody()`, NOT
 * captured at server startup. The smoke test kills the singleton server between
 * cases and spawns a fresh child that inherits the updated env var.
 *
 * Modes
 * ─────
 * prose     Role filter, buffering path, dual shapes, snapshot diff.
 * toolcall  Gating buffer detects '<', no tool context, tool-only output.
 * mixed     Tool-capable turn with pre-confirmation reasoning delta:
 *             1. reasoning delta arrives BEFORE assistant message.updated
 *                → must be buffered in pendingReasoningDeltas, not dropped.
 *             2. message.updated flushes it through thinking_*.
 *             3. second reasoning delta via snapshot diff (no delta field).
 *             4. text preamble + tool call buffered by hasTool=true.
 *             5. No text_delta events must appear.
 * error     opencode's shape for a failed turn: session.error, then idle.
 * retry     A free-tier refusal: a retry status carrying an action, then the
 *           stream stays open, as opencode waits for the limit to reset.
 *
 * FAKE_OC_CALLS, when set, names a file that gets one line per abort/delete
 * request, so a test can see how the bridge released the session.
 */

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);

// ── model discovery ───────────────────────────────────────────────────────────
if (args[0] === "models") {
  console.log("opencode/deepseek-v4-flash-free");
  console.log("opencode/big-pickle");
  process.exit(0);
}

// ── HTTP serve ────────────────────────────────────────────────────────────────
if (args[0] === "serve") {
  const portArg = args.find((a) => a.startsWith("--port=")) ?? "--port=49000";
  const port = parseInt(portArg.slice("--port=".length), 10);

  const SESSION_ID = "test-session";
  const USER_MSG_ID = "user-msg-1";
  const ASST_MSG_ID = "asst-msg-1";
  const ASST_PART_ID = "p-a-1";    // text part
  const ASST_REASON_ID = "p-r-1";  // reasoning part

  function sseEvent(type: string, properties: unknown): string {
    return `data: ${JSON.stringify({ type, properties })}\n\n`;
  }

  function buildSseBody(): string {
    const mode = process.env.FAKE_OC_MODE ?? "prose";

    // ── prose ─────────────────────────────────────────────────────────────────
    if (mode === "prose") {
      return [
        sseEvent("message.updated", { info: { id: USER_MSG_ID, role: "user", sessionID: SESSION_ID } }),
        sseEvent("message.part.delta", { sessionID: SESSION_ID, messageID: USER_MSG_ID, partID: "p-u-1", field: "text", delta: "DECOY FLAT DELTA" }),
        sseEvent("message.part.updated", { part: { id: "p-u-1", type: "text", sessionID: SESSION_ID, messageID: USER_MSG_ID, text: "DECOY UPDATED DELTA" }, delta: "DECOY UPDATED DELTA" }),
        // "Hello" arrives BEFORE message.updated → pendingDeltas (buffering path).
        sseEvent("message.part.delta", { sessionID: SESSION_ID, messageID: ASST_MSG_ID, partID: ASST_PART_ID, field: "text", delta: "Hello" }),
        sseEvent("message.updated", { info: { id: ASST_MSG_ID, role: "assistant", sessionID: SESSION_ID } }),
        // ", world" via updated-shape WITH delta.
        sseEvent("message.part.updated", { part: { id: ASST_PART_ID, type: "text", sessionID: SESSION_ID, messageID: ASST_MSG_ID, text: "Hello, world" }, delta: ", world" }),
        // "!" via snapshot-only (no delta → text.slice(prev)).
        sseEvent("message.part.updated", { part: { id: ASST_PART_ID, type: "text", sessionID: SESSION_ID, messageID: ASST_MSG_ID, text: "Hello, world!" } }),
        sseEvent("session.idle", { sessionID: SESSION_ID }),
      ].join("");
    }

    // ── error ─────────────────────────────────────────────────────────────────
    if (mode === "error") {
      return [
        sseEvent("session.status", { sessionID: SESSION_ID, status: { type: "busy" } }),
        sseEvent("session.error", { sessionID: SESSION_ID, error: { name: "UnknownError", data: { message: "Model not found: opencode/no-such-model" } } }),
        sseEvent("session.status", { sessionID: SESSION_ID, status: { type: "idle" } }),
        sseEvent("session.idle", { sessionID: SESSION_ID }),
      ].join("");
    }

    // ── retry ─────────────────────────────────────────────────────────────────
    // The retry of another session must not end this turn.
    if (mode === "retry") {
      const action = { reason: "free_tier_limit", provider: "opencode", title: "Free limit reached", label: "subscribe", link: "https://opencode.ai/go" };
      return [
        sseEvent("session.status", { sessionID: SESSION_ID, status: { type: "busy" } }),
        sseEvent("session.status", { sessionID: "other-session", status: { type: "retry", attempt: 1, message: "not this turn", action } }),
        sseEvent("session.status", { sessionID: SESSION_ID, status: { type: "retry", attempt: 1, message: "Free usage exceeded, subscribe to Go", action, next: Date.now() + 14 * 3_600_000 } }),
      ].join("");
    }

    // ── toolcall ──────────────────────────────────────────────────────────────
    if (mode === "toolcall") {
      return [
        sseEvent("message.updated", { info: { id: USER_MSG_ID, role: "user", sessionID: SESSION_ID } }),
        sseEvent("message.part.delta", { sessionID: SESSION_ID, messageID: USER_MSG_ID, partID: "p-u-1", field: "text", delta: "DECOY TOOL DELTA" }),
        // Tool-call delta BEFORE assistant message.updated → gating via pendingDeltas.
        sseEvent("message.part.delta", { sessionID: SESSION_ID, messageID: ASST_MSG_ID, partID: ASST_PART_ID, field: "text", delta: '<omp_tool_call>{"name":"bash","arguments":{"command":"echo hi"}}</omp_tool_call>' }),
        sseEvent("message.updated", { info: { id: ASST_MSG_ID, role: "assistant", sessionID: SESSION_ID } }),
        sseEvent("session.idle", { sessionID: SESSION_ID }),
      ].join("");
    }

    // ── mixed (hasTool=true: buffer text, route reasoning, emit only tool call) ─
    //
    // Key ordering for coverage:
    //   • reasoning delta BEFORE assistant message.updated → pendingReasoningDeltas
    //   • message.updated flushes pending reasoning
    //   • second reasoning delta via snapshot diff (updated-shape, no delta field)
    //   • text preamble + tool call both buffered (hasTool=true)
    //
    // Smoke assertions:
    //   no text_delta, thinking_start fires, both reasoning pieces appear in
    //   thinking_delta, thinking_end fires, toolcall_end(read), done(toolUse).
    return [
      sseEvent("message.updated", { info: { id: USER_MSG_ID, role: "user", sessionID: SESSION_ID } }),
      sseEvent("message.part.delta", { sessionID: SESSION_ID, messageID: USER_MSG_ID, partID: "p-u-1", field: "text", delta: "DECOY MIXED DELTA" }),

      // ── First reasoning delta BEFORE assistant confirmed ───────────────────
      // Must go into pendingReasoningDeltas, not be dropped.
      sseEvent("message.part.delta", {
        sessionID: SESSION_ID, messageID: ASST_MSG_ID,
        partID: ASST_REASON_ID, field: "reasoning",
        delta: "The user wants to explore the repo.",
      }),

      // Confirm assistant → flushPending emits the buffered reasoning delta.
      sseEvent("message.updated", { info: { id: ASST_MSG_ID, role: "assistant", sessionID: SESSION_ID } }),

      // Second reasoning delta via snapshot diff (no delta field).
      sseEvent("message.part.updated", {
        part: { id: ASST_REASON_ID, type: "reasoning", sessionID: SESSION_ID, messageID: ASST_MSG_ID,
                text: "The user wants to explore the repo. I should read it." },
        // no delta — derived as text.slice(prev.length) = " I should read it."
      }),

      // Text preamble + tool call — both buffered because hasTool=true.
      sseEvent("message.part.delta", { sessionID: SESSION_ID, messageID: ASST_MSG_ID, partID: ASST_PART_ID, field: "text", delta: "Let me read the directory." }),
      sseEvent("message.part.delta", { sessionID: SESSION_ID, messageID: ASST_MSG_ID, partID: ASST_PART_ID, field: "text", delta: '\n<omp_tool_call>{"name":"read","arguments":{"i":"explore","path":"."}}</omp_tool_call>' }),

      sseEvent("session.idle", { sessionID: SESSION_ID }),
    ].join("");
  }

  function record(call: string): void {
    if (process.env.FAKE_OC_CALLS) appendFileSync(process.env.FAKE_OC_CALLS, `${call}\n`);
  }

  Bun.serve({
    port,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method === "POST" && path === "/session") return Response.json({ id: SESSION_ID });
      if (req.method === "GET" && path === "/event") {
        const body = buildSseBody();
        const headers = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" };
        if (process.env.FAKE_OC_MODE !== "retry") return new Response(body, { headers });
        // Like opencode, keep the stream open while the session waits to retry.
        const open = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); } });
        return new Response(open, { headers });
      }
      if (req.method === "POST" && path === `/session/${SESSION_ID}/prompt_async`) return new Response(null, { status: 204 });
      if (req.method === "POST" && path === `/session/${SESSION_ID}/abort`) { record("abort"); return Response.json(true); }
      if (req.method === "DELETE" && path === `/session/${SESSION_ID}`) { record("delete"); return new Response(null, { status: 200 }); }
      return new Response("not found", { status: 404 });
    },
  });

  console.log(`listening on http://127.0.0.1:${port}`);
}
