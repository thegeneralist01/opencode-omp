import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import pkg from "../package.json" with { type: "json" };
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
  type Api,
  type AssistantMessage,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
} from "@oh-my-pi/pi-ai";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_ID = "opencode-cli";
const API_ID = "opencode-cli-runner";
const AGENT_ID = "omp-model";
const VERSION = pkg.version;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DISCOVERY_TIMEOUT_MS = 8_000;
const SERVER_START_TIMEOUT_MS = 12_000;
const STDERR_LIMIT = 20_000;

const DEFAULT_FREE_MODELS = [
  "opencode/deepseek-v4-flash-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-super-free",
  "opencode/big-pickle",
];

const DISABLED_TOOLS: Record<string, false> = {
  bash: false, edit: false, read: false, glob: false, grep: false,
  list: false, task: false, webfetch: false, websearch: false, todowrite: false,
};

// ---------------------------------------------------------------------------
// Named types
// ---------------------------------------------------------------------------

interface OcServer {
  url: string;
  proc: ChildProcess;
}

interface OcPartDelta {
  sessionID: string;
  messageID: string;
  partID: string;
  field: string;
  delta: string;
}

interface OcPartRef {
  id: string;
  type: string;
  sessionID: string;
  messageID: string;
  text?: string;
}

interface OcPartUpdatedProps {
  part: OcPartRef;
  delta?: string;
}

interface OcMessageInfo {
  id: string;
  role: string;
  sessionID: string;
}

interface OcMessageUpdated {
  info: OcMessageInfo;
}

interface OcSessionIdle {
  sessionID: string;
}

type NotifyFn = (msg: string, level?: "error" | "info" | "warning") => void;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let registeredModels: string[] = [];
let lastDiscoveryTime: number | undefined;
let lastDiscoveryError: string | undefined;
let ocAgentDir: string | undefined;
let ocServer: OcServer | undefined;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function opencodeBin(): string {
  return process.env.OPENCODE_OMP_BIN?.trim() || "opencode";
}

function configuredModels(): string[] | undefined {
  const raw = process.env.OPENCODE_OMP_MODELS?.trim();
  if (!raw) return undefined;
  return raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((model) => (model.includes("/") ? model : `opencode/${model}`));
}

function modelDisplayName(model: string): string {
  const [, id = model] = model.split(/\/(.*)/s);
  return `OpenCode ${id}`;
}

function contextWindowFor(model: string): number {
  if (model.includes("big-pickle")) return 200_000;
  return DEFAULT_CONTEXT_WINDOW;
}

function maxTokensFor(model: string): number {
  if (model.includes("big-pickle")) return 32_000;
  return DEFAULT_MAX_TOKENS;
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

function runCapture(
  args: string[],
  input?: string,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const { promise, resolve, reject } =
    Promise.withResolvers<{ stdout: string; stderr: string; code: number | null }>();

  const child = spawn(opencodeBin(), args, {
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
  });

  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    reject(new Error(`opencode timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_LIMIT); });
  child.on("error", (error) => { clearTimeout(timer); reject(error); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });

  if (input !== undefined) child.stdin!.end(input);
  return promise;
}

async function discoverModels(): Promise<{
  models: string[];
  time: number;
  error: string | undefined;
}> {
  const configured = configuredModels();
  if (configured?.length) {
    lastDiscoveryError = undefined;
    return { models: [...new Set(configured)], time: Date.now(), error: undefined };
  }
  try {
    const result = await runCapture(["models", "opencode"]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `opencode models exited with code ${result.code}`);
    }
    const discovered = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("opencode/"))
      .filter((m) => /(^opencode\/.*-free$)|(^opencode\/big-pickle$)/.test(m));
    lastDiscoveryError = undefined;
    return {
      models: [...new Set(discovered.length > 0 ? discovered : DEFAULT_FREE_MODELS)],
      time: Date.now(),
      error: undefined,
    };
  } catch (error) {
    lastDiscoveryError = error instanceof Error ? error.message : String(error);
    return { models: DEFAULT_FREE_MODELS, time: Date.now(), error: lastDiscoveryError };
  }
}

async function refreshModels(
  pi: ExtensionAPI,
  ctx: { ui: { notify: NotifyFn } },
): Promise<void> {
  const previousModels = new Set(registeredModels);
  const { models, time, error } = await discoverModels();
  registeredModels = models;
  lastDiscoveryTime = time;
  try {
    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "cli:opencode",
      apiKey: "opencode-cli-no-api-key",
      api: API_ID,
      models: models.map((model) => ({
        id: model,
        name: `${modelDisplayName(model)} (OpenCode CLI)`,
        reasoning: false,
        input: ["text"] as const,
        contextWindow: contextWindowFor(model),
        maxTokens: maxTokensFor(model),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
      streamSimple: streamOpenCode,
    });
  } catch { /* re-register silently if already registered */ }
  const newModels = models.filter((m) => !previousModels.has(m));
  let msg = `opencode-omp: refreshed ${models.length} model(s).`;
  if (newModels.length > 0)
    msg += ` ${newModels.length} new: ${newModels.slice(0, 5).join(", ")}${newModels.length > 5 ? ", ..." : ""}`;
  if (error) msg += ` Discovery issue: ${error}`;
  ctx.ui.notify(msg, "info");
}

// ---------------------------------------------------------------------------
// Server management
// ---------------------------------------------------------------------------

const AGENT_INSTRUCTIONS = `---
description: Text-only OMP bridge agent. OpenCode tools are denied; OMP tool calls are emitted as text markers.
mode: primary
permission:
  read: deny
  edit: deny
  glob: deny
  grep: deny
  list: deny
  bash: deny
  task: deny
  external_directory: deny
  todowrite: deny
  webfetch: deny
  websearch: deny
  lsp: deny
  skill: deny
  question: deny
  doom_loop: deny
---
You are the OpenCode side of an OMP coding agent bridge. OpenCode tools are disabled. Reply in plain text, or emit <omp_tool_call>{"name":"...","arguments":{...}}</omp_tool_call> exactly when the prompt asks you to request an OMP tool.
`;

async function ensureAgentDir(): Promise<string> {
  if (ocAgentDir) return ocAgentDir;
  const dir = await mkdtemp(join(tmpdir(), "opencode-omp-"));
  await mkdir(join(dir, ".opencode", "agents"), { recursive: true });
  await writeFile(join(dir, ".opencode", "agents", `${AGENT_ID}.md`), AGENT_INSTRUCTIONS, "utf8");
  ocAgentDir = dir;
  return dir;
}

async function ensureServer(): Promise<string> {
  if (ocServer) return ocServer.url;

  const dir = await ensureAgentDir();
  const port = 49000 + Math.floor(Math.random() * 5000);
  const { promise, resolve, reject } = Promise.withResolvers<string>();

  const proc = spawn(opencodeBin(), ["serve", `--port=${port}`], {
    cwd: dir,
    env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timer = setTimeout(() => {
    proc.kill("SIGTERM");
    reject(new Error(`opencode serve start timeout after ${SERVER_START_TIMEOUT_MS}ms`));
  }, SERVER_START_TIMEOUT_MS);

  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
    const match = chunk.match(/on\s+(https?:\/\/[^\s]+)/);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
  proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  proc.on("exit", () => { ocServer = undefined; });

  const url = await promise;
  ocServer = { url, proc };
  return url;
}

function stopServer(): void {
  ocServer?.proc.kill("SIGTERM");
  ocServer = undefined;
}

async function cleanupAgentDir(): Promise<void> {
  if (ocAgentDir) {
    await rm(ocAgentDir, { recursive: true, force: true }).catch(() => undefined);
    ocAgentDir = undefined;
  }
}

// ---------------------------------------------------------------------------
// Message/context serialization
// ---------------------------------------------------------------------------

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function setEstimatedUsage(output: AssistantMessage, prompt: string, text: string) {
  if (output.usage.totalTokens > 0) return;
  output.usage.input = estimateTokens(prompt);
  output.usage.output = estimateTokens(text);
  output.usage.totalTokens = output.usage.input + output.usage.output;
}

function contentToText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .map((item) => {
      if (item.type === "text") return item.text;
      return `[image omitted: ${item.mimeType}, ${item.data.length} base64 chars]`;
    })
    .join("\n");
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function serializeMessage(message: Message): string {
  if (message.role === "user") {
    return `USER:\n${contentToText(message.content as string | (TextContent | ImageContent)[])}`;
  }
  if (message.role === "toolResult") {
    return [
      `OMP TOOL RESULT (${message.toolName}, id=${message.toolCallId}, isError=${message.isError}):`,
      contentToText(message.content as string | (TextContent | ImageContent)[]),
    ].join("\n");
  }
  const rawContent = message.content;
  if (typeof rawContent === "string") return `ASSISTANT:\n${rawContent}`;
  const parts = (rawContent as unknown[]).map((part) => {
    if (part === null || typeof part !== "object") return String(part);
    if ("type" in part) {
      if (part.type === "text" && "text" in part && typeof part.text === "string") return part.text;
      if (part.type === "thinking" && "thinking" in part && typeof part.thinking === "string")
        return `<thinking>${part.thinking}</thinking>`;
      if (part.type === "toolCall" && "name" in part && "arguments" in part)
        return `<omp_tool_call>${safeJson({ name: part.name, arguments: part.arguments })}</omp_tool_call>`;
    }
    return safeJson(part);
  });
  return `ASSISTANT:\n${parts.join("\n")}`;
}

function serializeTools(tools?: Tool[]): string {
  if (!tools || tools.length === 0) return "No OMP tools are available for this turn.";
  return safeJson(tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })));
}

function buildPrompt(context: Context): string {
  const sections: string[] = [];
  sections.push(`# OMP/OpenCode bridge instructions

You are being used as the model backend for Oh My Pi (OMP) coding agent through the OpenCode CLI.
OpenCode's own tools are disabled. Do not try to use OpenCode tools.

OUTPUT RULES — follow exactly:

1. If you need OMP to run a tool, output ONLY the tool-call block(s) with absolutely no preamble,
   explanation, or prose before or after:
   <omp_tool_call>{"name":"tool_name","arguments":{}}</omp_tool_call>
   Do not say "Let me read..." or "I'll check...". Start the output with <omp_tool_call> immediately.

2. If you can answer without a tool, answer in plain text only — no XML tags.

3. After OMP returns tool results, either answer in plain text or emit another tool call.

4. The JSON inside <omp_tool_call> must be valid JSON with "name" and "arguments" fields.
   Use only tools listed in the "Available OMP tools" section.
   Do not wrap tool calls in Markdown fences.

5. Do not output internal reasoning or thinking as part of your response text.
   If you need to think, do it silently — never include it in the output.`);

  const sysPrompt = Array.isArray(context.systemPrompt)
    ? context.systemPrompt.join("\n").trim()
    : (context.systemPrompt ?? "").trim();
  if (sysPrompt) sections.push(`# OMP system prompt\n\n${sysPrompt}`);

  sections.push(`# Available OMP tools\n\n${serializeTools(context.tools)}`);

  if (context.messages.length > 0) {
    sections.push(`# Conversation transcript\n\n${context.messages.map(serializeMessage).join("\n\n---\n\n")}`);
  } else {
    sections.push("# Conversation transcript\n\n(no prior messages)");
  }

  sections.push("Now produce the next assistant message for OMP.");
  return sections.join("\n\n---\n\n");
}

function parseToolCalls(text: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const trimmed = text.trim();
  const tagRegex = /<omp_tool_call>([\s\S]*?)<\/omp_tool_call>/g;
  const matches = [...trimmed.matchAll(tagRegex)];
  if (matches.length > 0) return matches.flatMap((match) => parseToolCallJson(match[1] ?? ""));
  return parseToolCallJson(trimmed);
}

function parseToolCallJson(raw: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  let value: unknown;
  try { value = JSON.parse(raw.trim()); } catch { return []; }

  const candidates: unknown[] = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object" && "tool_calls" in value && Array.isArray(value.tool_calls)
      ? value.tool_calls
      : [value];

  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") continue;
    let name: string | undefined;
    if ("name" in candidate && typeof candidate.name === "string") name = candidate.name;
    else if ("tool" in candidate && typeof candidate.tool === "string") name = candidate.tool;
    if (!name) continue;
    let args: unknown = {};
    if ("arguments" in candidate) args = candidate.arguments;
    else if ("args" in candidate) args = candidate.args;
    else if ("input" in candidate) args = candidate.input;
    if (typeof args !== "object" || args === null || Array.isArray(args)) continue;
    calls.push({ name, arguments: args as Record<string, unknown> });
  }
  return calls;
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

function parseSseBlocks(raw: string): Array<{ type: string; properties: unknown }> {
  const events: Array<{ type: string; properties: unknown }> = [];
  for (const block of raw.split(/\n\n/)) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    try {
      const ev = JSON.parse(dataLine.slice(5).trim()) as { type?: unknown; properties?: unknown };
      if (typeof ev.type === "string") events.push({ type: ev.type, properties: ev.properties ?? {} });
    } catch { /* skip malformed */ }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Streaming via opencode serve + SSE
// ---------------------------------------------------------------------------

function streamOpenCode(
  _model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: _model.api,
      provider: _model.provider,
      model: _model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const hasTool = (context.tools?.length ?? 0) > 0;

    const st = {
      textMode: "gating" as "gating" | "streaming" | "buffered",
      gateBuffer: "",
      textContentIndex: -1,
    };

    let reasoningContentIndex = -1;
    let accumulatedText = "";
    let sessionId: string | undefined;
    let sseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const prompt = buildPrompt(context);

    const assistantMsgIds = new Set<string>();
    const pendingDeltas = new Map<string, string[]>();
    const pendingReasoningDeltas = new Map<string, string[]>();
    const partTextById = new Map<string, string>();
    const reasoningTextById = new Map<string, string>();

    const handleReasoningDelta = (delta: string): void => {
      if (!delta) return;
      if (reasoningContentIndex === -1) {
        reasoningContentIndex = (output.content as unknown[]).length;
        (output.content as unknown[]).push({ type: "thinking", thinking: "" });
        stream.push({ type: "thinking_start", contentIndex: reasoningContentIndex, partial: output });
      }
      const block = (output.content as unknown[])[reasoningContentIndex] as { thinking: string };
      block.thinking += delta;
      stream.push({ type: "thinking_delta", contentIndex: reasoningContentIndex, delta, partial: output });
    };

    const dispatchReasoning = (msgId: string, delta: string): void => {
      if (!delta) return;
      if (assistantMsgIds.has(msgId)) {
        handleReasoningDelta(delta);
      } else {
        const buf = pendingReasoningDeltas.get(msgId) ?? [];
        buf.push(delta);
        pendingReasoningDeltas.set(msgId, buf);
      }
    };

    const handleTextDelta = (delta: string): void => {
      accumulatedText += delta;
      if (hasTool) return;

      if (st.textMode === "buffered") return;

      if (st.textMode === "streaming") {
        const block = (output.content as unknown[])[st.textContentIndex] as { text: string };
        block.text += delta;
        stream.push({ type: "text_delta", contentIndex: st.textContentIndex, delta, partial: output });
        return;
      }

      st.gateBuffer += delta;
      const firstNonWS = st.gateBuffer.trimStart()[0];
      if (firstNonWS === undefined) return;

      if (firstNonWS === "<" || firstNonWS === "{" || firstNonWS === "[") {
        st.textMode = "buffered";
      } else {
        st.textMode = "streaming";
        st.textContentIndex = (output.content as unknown[]).length;
        (output.content as unknown[]).push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: st.textContentIndex, partial: output });
        const gateBlock = (output.content as unknown[])[st.textContentIndex] as { text: string };
        gateBlock.text = st.gateBuffer;
        stream.push({ type: "text_delta", contentIndex: st.textContentIndex, delta: st.gateBuffer, partial: output });
        st.gateBuffer = "";
      }
    };

    const dispatchDelta = (msgId: string, delta: string): void => {
      if (!delta) return;
      if (assistantMsgIds.has(msgId)) {
        handleTextDelta(delta);
      } else {
        const buf = pendingDeltas.get(msgId) ?? [];
        buf.push(delta);
        pendingDeltas.set(msgId, buf);
      }
    };

    const flushPending = (msgId: string): void => {
      const pendingText = pendingDeltas.get(msgId);
      if (pendingText) {
        pendingDeltas.delete(msgId);
        for (const delta of pendingText) handleTextDelta(delta);
      }
      const pendingReasoning = pendingReasoningDeltas.get(msgId);
      if (pendingReasoning) {
        pendingReasoningDeltas.delete(msgId);
        for (const delta of pendingReasoning) handleReasoningDelta(delta);
      }
    };

    const cleanup = async () => {
      sseReader?.cancel().catch(() => undefined);
      if (sessionId) {
        const baseUrl = ocServer?.url;
        if (baseUrl) {
          await fetch(`${baseUrl}/session/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
        }
        sessionId = undefined;
      }
    };

    try {
      stream.push({ type: "start", partial: output });

      const baseUrl = await ensureServer();

      const sessResp = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!sessResp.ok) throw new Error(`session create failed: ${sessResp.status}`);
      const sess = await sessResp.json() as { id: string };
      sessionId = sess.id;

      const sseAbort = new AbortController();
      const onAbort = () => sseAbort.abort();
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      const evtResp = await fetch(`${baseUrl}/event`, { signal: sseAbort.signal });
      sseReader = evtResp.body!.getReader();

      const slashIdx = _model.id.indexOf("/");
      const providerID = slashIdx >= 0 ? _model.id.slice(0, slashIdx) : _model.id;
      const modelID = slashIdx >= 0 ? _model.id.slice(slashIdx + 1) : _model.id;

      const promptResp = await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: { providerID, modelID },
          agent: AGENT_ID,
          tools: DISABLED_TOOLS,
          parts: [{ type: "text", text: prompt }],
        }),
      });
      if (!promptResp.ok) throw new Error(`prompt_async failed: ${promptResp.status}`);

      const dec = new TextDecoder();
      let sseRemainder = "";
      let done = false;

      while (!done) {
        if (options?.signal?.aborted) throw new Error("Request was aborted");

        const { done: rdDone, value } = await sseReader.read();
        if (rdDone) break;

        sseRemainder += dec.decode(value, { stream: true });
        const blockBoundary = sseRemainder.lastIndexOf("\n\n");
        if (blockBoundary < 0) continue;

        const toProcess = sseRemainder.slice(0, blockBoundary + 2);
        sseRemainder = sseRemainder.slice(blockBoundary + 2);

        for (const ev of parseSseBlocks(toProcess)) {
          if (ev.type === "message.updated") {
            const props = ev.properties as OcMessageUpdated;
            if (props.info.sessionID === sessionId && props.info.role === "assistant") {
              assistantMsgIds.add(props.info.id);
              flushPending(props.info.id);
            }
          } else if (ev.type === "message.part.delta") {
            const props = ev.properties as OcPartDelta;
            if (props.sessionID !== sessionId || !props.delta) continue;
            if (props.field === "text") {
              const prev = partTextById.get(props.partID) ?? "";
              partTextById.set(props.partID, prev + props.delta);
              dispatchDelta(props.messageID, props.delta);
            } else if (props.field === "reasoning") {
              const prev = reasoningTextById.get(props.partID) ?? "";
              reasoningTextById.set(props.partID, prev + props.delta);
              dispatchReasoning(props.messageID, props.delta);
            }
          } else if (ev.type === "message.part.updated") {
            const props = ev.properties as OcPartUpdatedProps;
            if (props.part.sessionID !== sessionId) continue;
            if (props.part.type === "text") {
              const partId = props.part.id;
              const fullText = props.part.text;
              const prev = partTextById.get(partId) ?? "";
              const delta = props.delta ?? (fullText !== undefined ? fullText.slice(prev.length) : "");
              partTextById.set(partId, fullText ?? prev + delta);
              dispatchDelta(props.part.messageID, delta);
            } else if (props.part.type === "reasoning") {
              const partId = props.part.id;
              const fullText = props.part.text;
              const prev = reasoningTextById.get(partId) ?? "";
              const delta = props.delta ?? (fullText !== undefined ? fullText.slice(prev.length) : "");
              reasoningTextById.set(partId, fullText ?? prev + delta);
              dispatchReasoning(props.part.messageID, delta);
            }
          } else if (ev.type === "session.idle") {
            const props = ev.properties as OcSessionIdle;
            if (props.sessionID === sessionId) { done = true; break; }
          }
        }
      }

      options?.signal?.removeEventListener("abort", onAbort);
      sseAbort.abort();

      if (options?.signal?.aborted) throw new Error("Request was aborted");

      setEstimatedUsage(output, prompt, accumulatedText);

      if (reasoningContentIndex !== -1) {
        const block = (output.content as unknown[])[reasoningContentIndex] as { thinking: string };
        stream.push({ type: "thinking_end", contentIndex: reasoningContentIndex, content: block.thinking, partial: output });
      }

      const toolCalls = parseToolCalls(accumulatedText);
      if (toolCalls.length > 0) {
        if (st.textMode === "streaming") {
          stream.push({ type: "text_end", contentIndex: st.textContentIndex, content: accumulatedText, partial: output });
        }
        output.stopReason = "toolUse";
        for (const call of toolCalls) {
          const toolCall: ToolCall = {
            type: "toolCall",
            id: `opencode_omp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: call.name,
            arguments: call.arguments,
          };
          const contentIndex = (output.content as unknown[]).length;
          (output.content as unknown[]).push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex, delta: safeJson(toolCall.arguments), partial: output });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
        }
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
        return;
      }

      if (st.textMode === "streaming") {
        stream.push({ type: "text_end", contentIndex: st.textContentIndex, content: accumulatedText, partial: output });
      } else {
        st.textContentIndex = (output.content as unknown[]).length;
        (output.content as unknown[]).push({ type: "text", text: accumulatedText });
        stream.push({ type: "text_start", contentIndex: st.textContentIndex, partial: output });
        if (accumulatedText) {
          stream.push({ type: "text_delta", contentIndex: st.textContentIndex, delta: accumulatedText, partial: output });
        }
        stream.push({ type: "text_end", contentIndex: st.textContentIndex, content: accumulatedText, partial: output });
      }
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      await cleanup();
    }
  })();

  return stream;
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

function statusLines(): string[] {
  const lines = [
    `opencode-omp version: ${VERSION}`,
    `Provider: ${PROVIDER_ID}`,
    `OpenCode binary: ${opencodeBin()}`,
    `OpenCode installed: ${existsSync(opencodeBin()) || opencodeBin() === "opencode" ? "yes (check PATH)" : "no"}`,
    `Server running: ${ocServer ? ocServer.url : "no"}`,
    `Registered models: ${registeredModels.length}`,
    `Last discovery: ${lastDiscoveryTime ? new Date(lastDiscoveryTime).toLocaleString() : "never"}`,
  ];
  if (lastDiscoveryError) lines.push(`Discovery fallback: ${lastDiscoveryError}`);
  lines.push("");
  for (const model of registeredModels) lines.push(`  - ${PROVIDER_ID}/${model}`);
  lines.push("");
  lines.push("OpenCode login is not required for the bundled free OpenCode models.");
  lines.push("OpenCode tools are disabled; OMP tool use is bridged with prompt-level markers.");
  lines.push("Run /opencode-omp update to refresh the model list from opencode.");
  return lines;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default async function openCodeOmpExtension(pi: ExtensionAPI) {
  const { models, time } = await discoverModels();
  registeredModels = models;
  lastDiscoveryTime = time;

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "cli:opencode",
    apiKey: "opencode-cli-no-api-key",
    api: API_ID,
    models: registeredModels.map((model) => ({
      id: model,
      name: `${modelDisplayName(model)} (OpenCode CLI)`,
      reasoning: false,
      input: ["text"] as const,
      contextWindow: contextWindowFor(model),
      maxTokens: maxTokensFor(model),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple: streamOpenCode,
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `opencode-omp ${VERSION}: registered ${registeredModels.length} OpenCode CLI model(s). Use /model and pick ${PROVIDER_ID}.`,
      "info",
    );
    if (lastDiscoveryError) {
      ctx.ui.notify(`opencode-omp: model discovery used fallback (${lastDiscoveryError})`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    stopServer();
    await cleanupAgentDir();
  });

  pi.registerCommand("opencode-omp", {
    description: "OpenCode CLI bridge status and setup help",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
      if (sub === "status") {
        for (const line of statusLines()) ctx.ui.notify(line, "info");
        return;
      }
      if (sub === "models") {
        for (const model of registeredModels) ctx.ui.notify(`${PROVIDER_ID}/${model}`, "info");
        ctx.ui.notify(`Override with OPENCODE_OMP_MODELS="opencode/model-a,opencode/model-b"`, "info");
        return;
      }
      if (sub === "test") {
        const testModel = registeredModels[0] ?? DEFAULT_FREE_MODELS[0];
        ctx.ui.notify(`Run: omp -p --provider ${PROVIDER_ID} --model ${testModel} "Reply with exactly OK"`, "info");
        return;
      }
      if (sub === "update") {
        await refreshModels(pi, ctx);
        for (const line of statusLines()) ctx.ui.notify(line, "info");
        return;
      }
      if (sub === "help") {
        ctx.ui.notify("Usage: /opencode-omp [status|models|test|update|help]", "info");
        ctx.ui.notify("Set OPENCODE_OMP_BIN to override the opencode executable.", "info");
        ctx.ui.notify("Set OPENCODE_OMP_MODELS to register a custom comma-separated model list.", "info");
        return;
      }
      ctx.ui.notify(`Unknown /opencode-omp subcommand: ${sub}. Try /opencode-omp help`, "warning");
    },
  });
}
