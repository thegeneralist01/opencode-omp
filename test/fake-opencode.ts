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
 * Prose SSE sequence exercises every code path:
 *
 *  [role filter — flat shape]
 *   message.updated (user, user-msg-1)
 *   message.part.delta (user-msg-1, "DECOY FLAT DELTA")       ← must NOT appear
 *   message.part.updated (user-msg-1, delta="DECOY UPDATED")   ← must NOT appear
 *
 *  [buffering path + flat shape]
 *   message.part.delta (asst-msg-1, partID=p-a-1, "Hello")    ← arrives BEFORE
 *   message.updated (assistant, asst-msg-1)                     ← flush: "Hello"
 *                                                                partTextById[p-a-1]="Hello"
 *
 *  [SDK updated-shape WITH delta]
 *   message.part.updated (asst-msg-1, part.id=p-a-1,
 *     text="Hello, world", delta=", world")                    ← streams ", world"
 *                                                                partTextById[p-a-1]="Hello, world"
 *
 *  [SDK updated-shape WITHOUT delta — snapshot only]
 *   message.part.updated (asst-msg-1, part.id=p-a-1,
 *     text="Hello, world!", no delta)                          ← derives "!" via
 *                                                                text.slice(prev.length)
 *
 *   session.idle                                               ← turn done
 */

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
  // Shared part ID used by both flat delta and snapshot updated events
  // to exercise cross-shape partTextById consistency.
  const ASST_PART_ID = "p-a-1";

  function sseEvent(type: string, properties: unknown): string {
    return `data: ${JSON.stringify({ type, properties })}\n\n`;
  }

  /** Read mode fresh each request so a re-spawned server sees the current env. */
  function buildSseBody(): string {
    const mode = process.env.FAKE_OC_MODE ?? "prose";

    if (mode === "prose") {
      return [
        // ── User message — role=user decoys ──────────────────────────────────
        sseEvent("message.updated", {
          info: { id: USER_MSG_ID, role: "user", sessionID: SESSION_ID },
        }),
        // Flat-shape decoy: must be filtered by role.
        sseEvent("message.part.delta", {
          sessionID: SESSION_ID,
          messageID: USER_MSG_ID,
          partID: "p-u-1",
          field: "text",
          delta: "DECOY FLAT DELTA",
        }),
        // Updated-shape decoy: must also be filtered.
        sseEvent("message.part.updated", {
          part: { id: "p-u-1", type: "text", sessionID: SESSION_ID, messageID: USER_MSG_ID, text: "DECOY UPDATED DELTA" },
          delta: "DECOY UPDATED DELTA",
        }),

        // ── Buffering path: flat delta BEFORE assistant message.updated ───────
        // partTextById["p-a-1"] starts at "".
        sseEvent("message.part.delta", {
          sessionID: SESSION_ID,
          messageID: ASST_MSG_ID,
          partID: ASST_PART_ID,
          field: "text",
          delta: "Hello",
        }),
        // Confirm assistant role — triggers flush of buffered "Hello".
        // partTextById["p-a-1"] = "" + "Hello" = "Hello" (set by flat handler).
        sseEvent("message.updated", {
          info: { id: ASST_MSG_ID, role: "assistant", sessionID: SESSION_ID },
        }),

        // ── SDK updated-shape WITH delta ──────────────────────────────────────
        // partTextById["p-a-1"] was "Hello"; update to "Hello, world".
        sseEvent("message.part.updated", {
          part: { id: ASST_PART_ID, type: "text", sessionID: SESSION_ID, messageID: ASST_MSG_ID, text: "Hello, world" },
          delta: ", world",
        }),

        // ── SDK updated-shape WITHOUT delta (snapshot only) ───────────────────
        // Bridge derives "!" from "Hello, world!".slice("Hello, world".length).
        sseEvent("message.part.updated", {
          part: { id: ASST_PART_ID, type: "text", sessionID: SESSION_ID, messageID: ASST_MSG_ID, text: "Hello, world!" },
          // no delta field — intentionally absent
        }),

        sseEvent("session.idle", { sessionID: SESSION_ID }),
      ].join("");
    }

    // ── toolcall mode ─────────────────────────────────────────────────────────
    return [
      sseEvent("message.updated", {
        info: { id: USER_MSG_ID, role: "user", sessionID: SESSION_ID },
      }),
      // User decoy — must be filtered.
      sseEvent("message.part.delta", {
        sessionID: SESSION_ID,
        messageID: USER_MSG_ID,
        partID: "p-u-1",
        field: "text",
        delta: "DECOY TOOL DELTA",
      }),
      // Tool-call text arrives BEFORE assistant message.updated — buffered.
      sseEvent("message.part.delta", {
        sessionID: SESSION_ID,
        messageID: ASST_MSG_ID,
        partID: ASST_PART_ID,
        field: "text",
        delta: '<omp_tool_call>{"name":"bash","arguments":{"command":"echo hi"}}</omp_tool_call>',
      }),
      // Confirm assistant — flushes buffer; '<' triggers buffered gating mode.
      sseEvent("message.updated", {
        info: { id: ASST_MSG_ID, role: "assistant", sessionID: SESSION_ID },
      }),
      sseEvent("session.idle", { sessionID: SESSION_ID }),
    ].join("");
  }

  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "POST" && path === "/session") {
        return Response.json({ id: SESSION_ID });
      }
      if (req.method === "GET" && path === "/event") {
        return new Response(buildSseBody(), {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }
      if (req.method === "POST" && path === `/session/${SESSION_ID}/prompt_async`) {
        return new Response(null, { status: 204 });
      }
      if (req.method === "DELETE" && path === `/session/${SESSION_ID}`) {
        return new Response(null, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  // Signal ready — ensureServer() scans stdout for this pattern.
  console.log(`listening on http://127.0.0.1:${port}`);
}
