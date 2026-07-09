#!/bin/sh
# Fake opencode binary for smoke testing.
# Handles `models opencode` (discovery) and `run ...` (two modes via FAKE_OC_MODE).

if [ "$1" = "models" ]; then
  echo "opencode/deepseek-v4-flash-free"
  echo "opencode/big-pickle"
  exit 0
fi

# Consume stdin so the parent's stdin write doesn't block.
cat > /dev/null

MODE="${FAKE_OC_MODE:-prose}"

if [ "$MODE" = "prose" ]; then
  echo '{"type":"step_start","timestamp":1,"part":{}}'
  echo '{"type":"text","timestamp":2,"part":{"text":"Hello"}}'
  echo '{"type":"text","timestamp":3,"part":{"text":", world"}}'
  echo '{"type":"step_finish","timestamp":4,"part":{"reason":"stop","tokens":{"total":10,"input":8,"output":2,"reasoning":0,"cache":{"write":0,"read":0}}}}'
else
  echo '{"type":"step_start","timestamp":1,"part":{}}'
  echo '{"type":"text","timestamp":2,"part":{"text":"<omp_tool_call>{\"name\":\"bash\",\"arguments\":{\"command\":\"echo hi\"}}</omp_tool_call>"}}'
  echo '{"type":"step_finish","timestamp":3,"part":{"reason":"stop","tokens":{"total":10,"input":8,"output":2,"reasoning":0,"cache":{"write":0,"read":0}}}}'
fi
