import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
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

const PROVIDER_ID = "opencode-cli";
const API_ID = "opencode-cli-runner";
const AGENT_ID = "omp-model";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DISCOVERY_TIMEOUT_MS = 8_000;
const STDERR_LIMIT = 20_000;

const DEFAULT_FREE_MODELS = [
  "opencode/deepseek-v4-flash-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-super-free",
  "opencode/big-pickle",
];

let registeredModels: string[] = [];
let lastDiscoveryTime: number | undefined;
let lastDiscoveryError: string | undefined;

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

  if (input !== undefined) {
    child.stdin!.end(input);
  }

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
      throw new Error(
        result.stderr.trim() || `opencode models exited with code ${result.code}`,
      );
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

type NotifyFn = (msg: string, level?: "error" | "info" | "warning") => void;

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
  } catch {
    // registerProvider may reject if already registered; model list is still updated.
  }

  const newModels = models.filter((m) => !previousModels.has(m));
  let msg = `opencode-omp: refreshed ${models.length} model(s).`;
  if (newModels.length > 0) {
    msg += ` ${newModels.length} new: ${newModels.slice(0, 5).join(", ")}${newModels.length > 5 ? ", ..." : ""}`;
  }
  if (error) msg += ` Discovery issue: ${error}`;
  ctx.ui.notify(msg, "info");
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function setEstimatedUsage(
  output: AssistantMessage,
  prompt: string,
  text: string,
) {
  if (output.usage.totalTokens > 0) return;
  output.usage.input = estimateTokens(prompt);
  output.usage.output = estimateTokens(text);
  output.usage.totalTokens = output.usage.input + output.usage.output;
  // All opencode free models have zero cost — no calculateCost call needed.
}

function contentToText(
  content: string | (TextContent | ImageContent)[],
): string {
  if (typeof content === "string") return content;
  return content
    .map((item) => {
      if (item.type === "text") return item.text;
      return `[image omitted: ${item.mimeType}, ${item.data.length} base64 chars]`;
    })
    .join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function serializeMessage(message: Message): string {
  if (message.role === "user") {
    // content is string | (TextContent | ImageContent)[]
    return `USER:\n${contentToText(message.content as string | (TextContent | ImageContent)[])}`;
  }

  if (message.role === "toolResult") {
    return [
      `OMP TOOL RESULT (${message.toolName}, id=${message.toolCallId}, isError=${message.isError}):`,
      contentToText(message.content as string | (TextContent | ImageContent)[]),
    ].join("\n");
  }

  // assistant message — content may be string or mixed array
  const rawContent = message.content;
  if (typeof rawContent === "string") {
    return `ASSISTANT:\n${rawContent}`;
  }

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
  return safeJson(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
}

function buildPrompt(context: Context): string {
  const sections: string[] = [];
  sections.push(`# OMP/OpenCode bridge instructions

You are being used as the model backend for Oh My Pi (OMP) coding agent through the OpenCode CLI.
OpenCode's own tools are disabled. Do not try to use OpenCode tools.

If you need OMP to run a tool, output only one or more tool-call blocks and no prose:
<omp_tool_call>{"name":"tool_name","arguments":{}}</omp_tool_call>

Rules for OMP tool calls:
- Use only tools listed in the "Available OMP tools" section.
- The JSON inside <omp_tool_call> must be valid JSON with "name" and "arguments" fields.
- Do not wrap tool calls in Markdown fences.
- If you can answer without a tool, answer normally in plain text.
- After OMP returns tool results, continue from the transcript and either answer or request another OMP tool call.`);

  const sysPrompt = Array.isArray(context.systemPrompt)
    ? context.systemPrompt.join("\n").trim()
    : (context.systemPrompt ?? "").trim();

  if (sysPrompt) {
    sections.push(`# OMP system prompt\n\n${sysPrompt}`);
  }

  sections.push(`# Available OMP tools\n\n${serializeTools(context.tools)}`);

  if (context.messages.length > 0) {
    sections.push(
      `# Conversation transcript\n\n${context.messages.map(serializeMessage).join("\n\n---\n\n")}`,
    );
  } else {
    sections.push("# Conversation transcript\n\n(no prior messages)");
  }

  sections.push("Now produce the next assistant message for OMP.");
  return sections.join("\n\n---\n\n");
}

function parseToolCalls(
  text: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const trimmed = text.trim();
  const tagRegex = /<omp_tool_call>([\s\S]*?)<\/omp_tool_call>/g;
  const matches = [...trimmed.matchAll(tagRegex)];
  if (matches.length > 0) {
    return matches.flatMap((match) => parseToolCallJson(match[1] ?? ""));
  }
  return parseToolCallJson(trimmed);
}

function parseToolCallJson(
  raw: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    return [];
  }

  const candidates: unknown[] = Array.isArray(value)
    ? value
    : value !== null &&
        typeof value === "object" &&
        "tool_calls" in value &&
        Array.isArray(value.tool_calls)
      ? value.tool_calls
      : [value];

  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") continue;

    let name: string | undefined;
    if ("name" in candidate && typeof candidate.name === "string") {
      name = candidate.name;
    } else if ("tool" in candidate && typeof candidate.tool === "string") {
      name = candidate.tool;
    }
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

async function createTempAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-omp-"));
  const agentsDir = join(dir, ".opencode", "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    join(agentsDir, `${AGENT_ID}.md`),
    `---
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
`,
    "utf8",
  );
  return dir;
}

/** Reads a numeric field from a plain object without inline casts. */
function readNumber(obj: Record<string, unknown>, key: string, fallback = 0): number {
  const v = obj[key];
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

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

    let tempDir: string | undefined;
    let accumulatedText = "";
    let stderr = "";
    let stdoutRemainder = "";
    let opencodeToolUse: string | undefined;
    const prompt = buildPrompt(context);

    try {
      stream.push({ type: "start", partial: output });
      tempDir = await createTempAgentDir();

      const args = [
        "run", "--pure",
        "-m", _model.id,
        "--agent", AGENT_ID,
        "--format", "json",
        "--dir", tempDir,
      ];

      const child = spawn(opencodeBin(), args, {
        cwd: tempDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
      });

      const abort = () => child.kill("SIGTERM");
      options?.signal?.addEventListener("abort", abort, { once: true });
      child.stdin!.end(prompt);
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          stderr = (stderr + `\n${line}`).slice(-STDERR_LIMIT);
          return;
        }

        if (event === null || typeof event !== "object") return;

        const type = "type" in event && typeof event.type === "string" ? event.type : "";
        const part =
          "part" in event && event.part !== null && typeof event.part === "object"
            ? (event.part as Record<string, unknown>)
            : undefined;

        if (type === "text" && part && typeof part.text === "string") {
          accumulatedText += part.text;
          return;
        }

        if (type === "step_finish" && part && "tokens" in part) {
          const tokens = part.tokens;
          if (tokens !== null && typeof tokens === "object") {
            const t = tokens as Record<string, unknown>;
            const cache =
              t.cache !== null && typeof t.cache === "object"
                ? (t.cache as Record<string, unknown>)
                : {};
            output.usage.input = readNumber(t, "input");
            output.usage.output = readNumber(t, "output") + readNumber(t, "reasoning");
            output.usage.cacheRead = readNumber(cache, "read");
            output.usage.cacheWrite = readNumber(cache, "write");
            const totalFallback =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            output.usage.totalTokens = readNumber(t, "total") || totalFallback;
          }
          return;
        }

        if (type === "tool_use") {
          opencodeToolUse = part && typeof part.tool === "string" ? part.tool : "unknown";
          return;
        }

        if (type === "error") {
          // Accumulate error events from opencode's JSON stream separately so
          // they surface as the primary error message rather than mixing with
          // opencode's own process stderr logs.
          const msg =
            "part" in event && typeof (event as Record<string, unknown>).part === "object"
              ? safeJson((event as Record<string, unknown>).part)
              : safeJson(event);
          stderr = (stderr + `\nopencode error: ${msg}`).slice(-STDERR_LIMIT);
        }
      };

      child.stdout!.on("data", (chunk: string) => {
        stdoutRemainder += chunk;
        const lines = stdoutRemainder.split(/\r?\n/);
        stdoutRemainder = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });
      child.stderr!.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_LIMIT);
      });

      const { promise: closePromise, resolve: resolveClose, reject: rejectClose } =
        Promise.withResolvers<number | null>();
      child.on("error", rejectClose);
      child.on("close", resolveClose);
      const code = await closePromise;

      options?.signal?.removeEventListener("abort", abort);
      if (stdoutRemainder.trim()) handleLine(stdoutRemainder);

      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (code !== 0) {
        throw new Error(stderr.trim() || `opencode exited with code ${code}`);
      }
      if (opencodeToolUse) {
        throw new Error(
          `OpenCode attempted to use its own tool (${opencodeToolUse}). ` +
            `opencode-omp disables OpenCode tools; use OMP tool-call markers only.`,
        );
      }

      const toolCalls = parseToolCalls(accumulatedText);
      setEstimatedUsage(output, prompt, accumulatedText);

      if (toolCalls.length > 0) {
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
          stream.push({
            type: "toolcall_delta",
            contentIndex,
            delta: safeJson(toolCall.arguments),
            partial: output,
          });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
        }
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
        return;
      }

      const contentIndex = (output.content as unknown[]).length;
      (output.content as unknown[]).push({ type: "text", text: accumulatedText });
      stream.push({ type: "text_start", contentIndex, partial: output });
      if (accumulatedText) {
        stream.push({ type: "text_delta", contentIndex, delta: accumulatedText, partial: output });
      }
      stream.push({ type: "text_end", contentIndex, content: accumulatedText, partial: output });
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  })();

  return stream;
}

function statusLines(): string[] {
  const lines = [
    `Provider: ${PROVIDER_ID}`,
    `OpenCode binary: ${opencodeBin()}`,
    `OpenCode installed: ${existsSync(opencodeBin()) || opencodeBin() === "opencode" ? "check PATH with /opencode-omp test" : "no"}`,
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
      `opencode-omp: registered ${registeredModels.length} OpenCode CLI model(s). Use /model and pick ${PROVIDER_ID}.`,
      "info",
    );
    if (lastDiscoveryError) {
      ctx.ui.notify(
        `opencode-omp: model discovery used fallback (${lastDiscoveryError})`,
        "warning",
      );
    }
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
        ctx.ui.notify(
          `Override with OPENCODE_OMP_MODELS="opencode/model-a,opencode/model-b"`,
          "info",
        );
        return;
      }
      if (sub === "test") {
        const testModel = registeredModels[0] ?? DEFAULT_FREE_MODELS[0];
        ctx.ui.notify(
          `Run: omp -p --provider ${PROVIDER_ID} --model ${testModel} "Reply with exactly OK"`,
          "info",
        );
        ctx.ui.notify(
          `OpenCode check: ${opencodeBin()} run -m ${testModel} --format json "Reply OK"`,
          "info",
        );
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
        ctx.ui.notify(
          "Set OPENCODE_OMP_MODELS to register a custom comma-separated model list.",
          "info",
        );
        return;
      }
      ctx.ui.notify(
        `Unknown /opencode-omp subcommand: ${sub}. Try /opencode-omp help`,
        "warning",
      );
    },
  });
}
