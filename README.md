# opencode-omp

Registers an `opencode-cli` provider in [Oh My Pi (OMP)](https://omp.dev) and delegates model calls to the local `opencode` CLI — no OpenCode login required.

Intended for the free OpenCode models such as:

- `opencode/deepseek-v4-flash-free`
- `opencode/mimo-v2.5-free`
- `opencode/nemotron-3-super-free`
- `opencode/big-pickle`

## Requirements

- [Oh My Pi (OMP)](https://omp.dev) coding agent
- [OpenCode](https://opencode.ai) installed and on PATH:

```bash
opencode --version
opencode models opencode   # verify free models are listed
```

## Install

```bash
omp plugin install github:thegeneralist01/opencode-omp
```

Then `/reload` in OMP (or restart). Pick the model with `/model` and select from the `opencode-cli` provider, or pass it directly:

```bash
omp -p --model opencode-cli/opencode/deepseek-v4-flash-free "Reply with exactly OK"
```

> **npm** (`npm:opencode-omp`) currently serves 1.0.0. Use the GitHub install path above to get 1.2.0.

## Commands

```
/opencode-omp status    version, server state, registered models
/opencode-omp models    list registered model IDs
/opencode-omp update    re-query opencode for the current free model roster
/opencode-omp test      print a smoke-test command to run manually
/opencode-omp help      usage summary
```

## Configuration

| Variable | Description |
|---|---|
| `OPENCODE_OMP_BIN` | Override the opencode executable path (default: `opencode`) |
| `OPENCODE_OMP_MODELS` | Comma- or space-separated model list to register instead of auto-discovery |

```bash
OPENCODE_OMP_MODELS="opencode/deepseek-v4-flash-free,opencode/big-pickle" omp
```

## How it works

On the first model turn the extension starts a persistent `opencode serve` subprocess in a locked-down temp directory (all OpenCode tools denied). The server is reused across turns and shut down when the OMP session ends.

For each turn:

1. Serializes the OMP conversation context (system prompt, tools, message history) into a plain-text bridge prompt.
2. Opens an SSE connection to `opencode serve`'s `/event` stream.
3. Creates a new OpenCode session and sends the prompt via `POST /session/:id/prompt_async`.
4. Streams `message.part.delta` and `message.part.updated` SSE events back to OMP as incremental `text_delta` events. User-message deltas are filtered by role; deltas that arrive before role confirmation are buffered and flushed when the `message.updated` event arrives.
5. Converts `<omp_tool_call>{...}</omp_tool_call>` markers in the response into real OMP tool calls.
6. Deletes the OpenCode session when the turn completes.

File access and edits stay under OMP's normal tool pipeline; OpenCode cannot touch your filesystem.

## Limitations

- SSE bridge, not a native HTTP provider — streaming quality depends on what the underlying model exposes through OpenCode's event layer.
- Tool calling is prompt-bridged; native providers will be more reliable for heavy tool use.
- Image input is not supported (free models are text-only).
- If OpenCode attempts its own tools, the turn fails rather than silently proceeding.

## Update / uninstall

```bash
omp plugin install github:thegeneralist01/opencode-omp   # update
omp plugin uninstall opencode-omp                        # remove
```
