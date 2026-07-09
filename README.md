# opencode-omp

Registers an `opencode-cli` provider in [Oh My Pi (OMP)](https://omp.dev) and delegates model calls to the local `opencode` CLI — no OpenCode login required.

Intended for the free OpenCode models such as:

- `opencode/deepseek-v4-flash-free`
- `opencode/mimo-v2.5-free`
- `opencode/nemotron-3-ultra-free`
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
omp plugin install npm:opencode-omp
```

Then `/reload` in OMP (or restart). Pick the provider with `/model` or pass it directly:

```bash
omp --provider opencode-cli --model opencode/deepseek-v4-flash-free
```

Smoke test:

```bash
omp -p --provider opencode-cli --model opencode/deepseek-v4-flash-free "Reply with exactly OK"
```

## Commands

```
/opencode-omp status    list registered models and last discovery time
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

For each OMP model turn, the extension:

1. Creates a temporary OpenCode project with a locked-down `omp-model` agent (all OpenCode tools denied).
2. Serializes the OMP conversation context (system prompt, tools, message history) into a plain-text bridge prompt.
3. Sends the prompt to `opencode run --format json` via stdin.
4. Forwards the response text back into OMP (forwarded as incremental events if OpenCode emits them; current free models return one final chunk).
5. Converts `<omp_tool_call>{...}</omp_tool_call>` markers in the response into real OMP tool calls.

File access and edits stay under OMP's normal tool pipeline; OpenCode cannot touch your filesystem.

## Limitations

- CLI bridge, not a native HTTP provider — one `opencode run` subprocess per turn.
- Tool calling is prompt-bridged; native providers will be more reliable for heavy tool use.
- Image input is not supported (free models are text-only).
- If OpenCode attempts its own tools, the turn fails rather than silently proceeding.

## Update / uninstall

```bash
omp plugin install npm:opencode-omp@latest   # update
omp plugin uninstall opencode-omp            # remove
```
