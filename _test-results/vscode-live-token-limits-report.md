# VS Code Model Certification Report

- Generated: 2026-08-06T12:40:24.364Z
- Target: `http://127.0.0.1:50209`
- Authentication source: `running-vscode-proxy`
- Flow: streamed function-tool request through the VS Code-scoped CodeMie proxy
- Discovered models: 37
- Enabled models: 37
- Protocol-compatible models: 36
- Unclassified models: 1
- Executed models: 36
- Model/effort combinations: 130
- Passing combinations: 130
- Failing combinations: 0
- Fully passing models: 36/36

No API keys, tokens, request headers, or response payloads are stored in this report.

## Results

| Model | API | Effort | Result | HTTP | Tool call | Attempts | Duration | Detail |
|---|---|---|---:|---:|---:|---:|---:|---|
| `gpt-5-2-2025-12-11` | chat-completions | `default` | PASS | 200 | yes | 1 | 2177 ms | Streaming function tool call received. |
| `gpt-5-2-2025-12-11` | chat-completions | `none` | PASS | 200 | yes | 1 | 1488 ms | Streaming function tool call received. |
| `gpt-5-2-2025-12-11` | chat-completions | `low` | PASS | 200 | yes | 1 | 1153 ms | Streaming function tool call received. |
| `gpt-5-2-2025-12-11` | chat-completions | `medium` | PASS | 200 | yes | 1 | 1011 ms | Streaming function tool call received. |
| `gpt-5-2-2025-12-11` | chat-completions | `high` | PASS | 200 | yes | 1 | 1327 ms | Streaming function tool call received. |
| `claude-4-5-sonnet` | chat-completions | `default` | PASS | 200 | yes | 1 | 2000 ms | Streaming function tool call received. |
| `claude-sonnet-4-5-20250929` | chat-completions | `default` | PASS | 200 | yes | 1 | 1918 ms | Streaming function tool call received. |
| `claude-haiku-4-5-20251001` | chat-completions | `default` | PASS | 200 | yes | 1 | 875 ms | Streaming function tool call received. |
| `claude-opus-4-5-20251101` | messages | `default` | PASS | 200 | yes | 1 | 2490 ms | Streaming function tool call received. |
| `claude-opus-4-5-20251101` | messages | `low` | PASS | 200 | yes | 1 | 2466 ms | Streaming function tool call received. |
| `claude-opus-4-5-20251101` | messages | `medium` | PASS | 200 | yes | 1 | 3096 ms | Streaming function tool call received. |
| `claude-opus-4-5-20251101` | messages | `high` | PASS | 200 | yes | 1 | 1774 ms | Streaming function tool call received. |
| `claude-opus-4-6-20260205` | messages | `default` | PASS | 200 | yes | 1 | 1927 ms | Streaming function tool call received. |
| `claude-opus-4-6-20260205` | messages | `low` | PASS | 200 | yes | 1 | 2175 ms | Streaming function tool call received. |
| `claude-opus-4-6-20260205` | messages | `medium` | PASS | 200 | yes | 1 | 2491 ms | Streaming function tool call received. |
| `claude-opus-4-6-20260205` | messages | `high` | PASS | 200 | yes | 1 | 2144 ms | Streaming function tool call received. |
| `claude-opus-4-6-20260205` | messages | `max` | PASS | 200 | yes | 1 | 2222 ms | Streaming function tool call received. |
| `claude-opus-4-7` | messages | `default` | PASS | 200 | yes | 1 | 1536 ms | Streaming function tool call received. |
| `claude-opus-4-7` | messages | `low` | PASS | 200 | yes | 1 | 1291 ms | Streaming function tool call received. |
| `claude-opus-4-7` | messages | `medium` | PASS | 200 | yes | 1 | 1492 ms | Streaming function tool call received. |
| `claude-opus-4-7` | messages | `high` | PASS | 200 | yes | 1 | 2419 ms | Streaming function tool call received. |
| `claude-opus-4-7` | messages | `xhigh` | PASS | 200 | yes | 1 | 3348 ms | Streaming function tool call received. |
| `claude-opus-4-7` | messages | `max` | PASS | 200 | yes | 1 | 1359 ms | Streaming function tool call received. |
| `claude-opus-4-8` | messages | `default` | PASS | 200 | yes | 1 | 1739 ms | Streaming function tool call received. |
| `claude-opus-4-8` | messages | `low` | PASS | 200 | yes | 1 | 1701 ms | Streaming function tool call received. |
| `claude-opus-4-8` | messages | `medium` | PASS | 200 | yes | 1 | 1388 ms | Streaming function tool call received. |
| `claude-opus-4-8` | messages | `high` | PASS | 200 | yes | 1 | 1846 ms | Streaming function tool call received. |
| `claude-opus-4-8` | messages | `xhigh` | PASS | 200 | yes | 1 | 1580 ms | Streaming function tool call received. |
| `claude-opus-4-8` | messages | `max` | PASS | 200 | yes | 1 | 1515 ms | Streaming function tool call received. |
| `claude-opus-5` | messages | `default` | PASS | 200 | yes | 1 | 1923 ms | Streaming function tool call received. |
| `claude-opus-5` | messages | `low` | PASS | 200 | yes | 1 | 1724 ms | Streaming function tool call received. |
| `claude-opus-5` | messages | `medium` | PASS | 200 | yes | 1 | 2827 ms | Streaming function tool call received. |
| `claude-opus-5` | messages | `high` | PASS | 200 | yes | 1 | 4283 ms | Streaming function tool call received. |
| `claude-opus-5` | messages | `xhigh` | PASS | 200 | yes | 1 | 1579 ms | Streaming function tool call received. |
| `claude-opus-5` | messages | `max` | PASS | 200 | yes | 1 | 1909 ms | Streaming function tool call received. |
| `claude-sonnet-4-6` | messages | `default` | PASS | 200 | yes | 1 | 2245 ms | Streaming function tool call received. |
| `claude-sonnet-4-6` | messages | `low` | PASS | 200 | yes | 1 | 2072 ms | Streaming function tool call received. |
| `claude-sonnet-4-6` | messages | `medium` | PASS | 200 | yes | 1 | 2114 ms | Streaming function tool call received. |
| `claude-sonnet-4-6` | messages | `high` | PASS | 200 | yes | 1 | 2154 ms | Streaming function tool call received. |
| `claude-sonnet-4-6` | messages | `max` | PASS | 200 | yes | 1 | 2005 ms | Streaming function tool call received. |
| `claude-sonnet-5` | messages | `default` | PASS | 200 | yes | 1 | 2229 ms | Streaming function tool call received. |
| `claude-sonnet-5` | messages | `low` | PASS | 200 | yes | 1 | 2201 ms | Streaming function tool call received. |
| `claude-sonnet-5` | messages | `medium` | PASS | 200 | yes | 1 | 2255 ms | Streaming function tool call received. |
| `claude-sonnet-5` | messages | `high` | PASS | 200 | yes | 1 | 2293 ms | Streaming function tool call received. |
| `claude-sonnet-5` | messages | `xhigh` | PASS | 200 | yes | 1 | 1877 ms | Streaming function tool call received. |
| `claude-sonnet-5` | messages | `max` | PASS | 200 | yes | 1 | 2871 ms | Streaming function tool call received. |
| `moonshotai.kimi-k2.5` | chat-completions | `default` | PASS | 200 | yes | 1 | 1363 ms | Streaming function tool call received. |
| `qwen.qwen3-coder-30b-a3b-v1` | chat-completions | `default` | PASS | 200 | yes | 1 | 568 ms | Streaming function tool call received. |
| `qwen.qwen3-coder-480b-a35b-v1` | chat-completions | `default` | PASS | 200 | yes | 1 | 1056 ms | Streaming function tool call received. |
| `gemini-3-flash` | chat-completions | `default` | PASS | 200 | yes | 1 | 2175 ms | Streaming function tool call received. |
| `gemini-3-flash` | chat-completions | `minimal` | PASS | 200 | yes | 1 | 3726 ms | Streaming function tool call received. |
| `gemini-3-flash` | chat-completions | `low` | PASS | 200 | yes | 1 | 3845 ms | Streaming function tool call received. |
| `gemini-3-flash` | chat-completions | `medium` | PASS | 200 | yes | 1 | 4046 ms | Streaming function tool call received. |
| `gemini-3-flash` | chat-completions | `high` | PASS | 200 | yes | 1 | 2690 ms | Streaming function tool call received. |
| `gemini-3.1-flash-image` | chat-completions | `default` | PASS | 200 | no | 1 | 1693 ms | Streaming response received. |
| `gemini-3.1-pro` | chat-completions | `default` | PASS | 200 | yes | 1 | 3564 ms | Streaming function tool call received. |
| `gemini-3.1-pro` | chat-completions | `low` | PASS | 200 | yes | 1 | 2761 ms | Streaming function tool call received. |
| `gemini-3.1-pro` | chat-completions | `medium` | PASS | 200 | yes | 1 | 3495 ms | Streaming function tool call received. |
| `gemini-3.1-pro` | chat-completions | `high` | PASS | 200 | yes | 1 | 2772 ms | Streaming function tool call received. |
| `gemini-3.5-flash` | chat-completions | `default` | PASS | 200 | yes | 1 | 31315 ms | Streaming function tool call received. |
| `gemini-3.5-flash` | chat-completions | `minimal` | PASS | 200 | yes | 1 | 25852 ms | Streaming function tool call received. |
| `gemini-3.5-flash` | chat-completions | `low` | PASS | 200 | yes | 1 | 3357 ms | Streaming function tool call received. |
| `gemini-3.5-flash` | chat-completions | `medium` | PASS | 200 | yes | 1 | 1523 ms | Streaming function tool call received. |
| `gemini-3.5-flash` | chat-completions | `high` | PASS | 200 | yes | 1 | 1461 ms | Streaming function tool call received. |
| `gpt-4.1` | chat-completions | `default` | PASS | 200 | yes | 1 | 659 ms | Streaming function tool call received. |
| `gpt-4.1-mini` | chat-completions | `default` | PASS | 200 | yes | 1 | 896 ms | Streaming function tool call received. |
| `gpt-5-2025-08-07` | chat-completions | `default` | PASS | 200 | yes | 1 | 3830 ms | Streaming function tool call received. |
| `gpt-5-2025-08-07` | chat-completions | `minimal` | PASS | 200 | yes | 1 | 1795 ms | Streaming function tool call received. |
| `gpt-5-2025-08-07` | chat-completions | `low` | PASS | 200 | yes | 1 | 3009 ms | Streaming function tool call received. |
| `gpt-5-2025-08-07` | chat-completions | `medium` | PASS | 200 | yes | 1 | 4442 ms | Streaming function tool call received. |
| `gpt-5-2025-08-07` | chat-completions | `high` | PASS | 200 | yes | 1 | 8264 ms | Streaming function tool call received. |
| `gpt-5-mini-2025-08-07` | chat-completions | `default` | PASS | 200 | yes | 1 | 3268 ms | Streaming function tool call received. |
| `gpt-5-mini-2025-08-07` | chat-completions | `minimal` | PASS | 200 | yes | 1 | 1935 ms | Streaming function tool call received. |
| `gpt-5-mini-2025-08-07` | chat-completions | `low` | PASS | 200 | yes | 1 | 1475 ms | Streaming function tool call received. |
| `gpt-5-mini-2025-08-07` | chat-completions | `medium` | PASS | 200 | yes | 1 | 2353 ms | Streaming function tool call received. |
| `gpt-5-mini-2025-08-07` | chat-completions | `high` | PASS | 200 | yes | 1 | 2685 ms | Streaming function tool call received. |
| `gpt-5-nano-2025-08-07` | chat-completions | `default` | PASS | 200 | yes | 1 | 4507 ms | Streaming function tool call received. |
| `gpt-5-nano-2025-08-07` | chat-completions | `minimal` | PASS | 200 | yes | 1 | 1920 ms | Streaming function tool call received. |
| `gpt-5-nano-2025-08-07` | chat-completions | `low` | PASS | 200 | yes | 1 | 2280 ms | Streaming function tool call received. |
| `gpt-5-nano-2025-08-07` | chat-completions | `medium` | PASS | 200 | yes | 1 | 3853 ms | Streaming function tool call received. |
| `gpt-5-nano-2025-08-07` | chat-completions | `high` | PASS | 200 | yes | 1 | 5635 ms | Streaming function tool call received. |
| `gpt-5-1-codex-2025-11-13` | responses | `default` | PASS | 200 | yes | 1 | 1494 ms | Streaming function tool call received. |
| `gpt-5.4-2026-03-05` | chat-completions | `default` | PASS | 200 | yes | 1 | 1969 ms | Streaming function tool call received. |
| `gpt-5.4-2026-03-05` | chat-completions | `none` | PASS | 200 | yes | 1 | 1068 ms | Streaming function tool call received. |
| `gpt-5.4-2026-03-05` | chat-completions | `low` | PASS | 200 | yes | 1 | 782 ms | Streaming function tool call received. |
| `gpt-5.4-2026-03-05` | chat-completions | `medium` | PASS | 200 | yes | 1 | 1357 ms | Streaming function tool call received. |
| `gpt-5.4-2026-03-05` | chat-completions | `high` | PASS | 200 | yes | 1 | 680 ms | Streaming function tool call received. |
| `gpt-5.4-2026-03-05` | chat-completions | `xhigh` | PASS | 200 | yes | 1 | 993 ms | Streaming function tool call received. |
| `gpt-5.5-2026-04-24` | responses | `default` | PASS | 200 | yes | 1 | 1592 ms | Streaming function tool call received. |
| `gpt-5.5-2026-04-24` | responses | `none` | PASS | 200 | yes | 1 | 2722 ms | Streaming function tool call received. |
| `gpt-5.5-2026-04-24` | responses | `low` | PASS | 200 | yes | 1 | 1806 ms | Streaming function tool call received. |
| `gpt-5.5-2026-04-24` | responses | `medium` | PASS | 200 | yes | 1 | 1177 ms | Streaming function tool call received. |
| `gpt-5.5-2026-04-24` | responses | `high` | PASS | 200 | yes | 1 | 1548 ms | Streaming function tool call received. |
| `gpt-5.5-2026-04-24` | responses | `xhigh` | PASS | 200 | yes | 1 | 1739 ms | Streaming function tool call received. |
| `gpt-5.6-luna-2026-07-09` | responses | `default` | PASS | 200 | yes | 1 | 1600 ms | Streaming function tool call received. |
| `gpt-5.6-luna-2026-07-09` | responses | `none` | PASS | 200 | yes | 1 | 1500 ms | Streaming function tool call received. |
| `gpt-5.6-luna-2026-07-09` | responses | `low` | PASS | 200 | yes | 1 | 1470 ms | Streaming function tool call received. |
| `gpt-5.6-luna-2026-07-09` | responses | `medium` | PASS | 200 | yes | 1 | 1413 ms | Streaming function tool call received. |
| `gpt-5.6-luna-2026-07-09` | responses | `high` | PASS | 200 | yes | 1 | 1553 ms | Streaming function tool call received. |
| `gpt-5.6-luna-2026-07-09` | responses | `xhigh` | PASS | 200 | yes | 1 | 1187 ms | Streaming function tool call received. |
| `gpt-5.6-luna-2026-07-09` | responses | `max` | PASS | 200 | yes | 1 | 1911 ms | Streaming function tool call received. |
| `gpt-5.6-sol-2026-07-09` | responses | `default` | PASS | 200 | yes | 1 | 2045 ms | Streaming function tool call received. |
| `gpt-5.6-sol-2026-07-09` | responses | `none` | PASS | 200 | yes | 1 | 1344 ms | Streaming function tool call received. |
| `gpt-5.6-sol-2026-07-09` | responses | `low` | PASS | 200 | yes | 1 | 1191 ms | Streaming function tool call received. |
| `gpt-5.6-sol-2026-07-09` | responses | `medium` | PASS | 200 | yes | 1 | 2073 ms | Streaming function tool call received. |
| `gpt-5.6-sol-2026-07-09` | responses | `high` | PASS | 200 | yes | 1 | 1801 ms | Streaming function tool call received. |
| `gpt-5.6-sol-2026-07-09` | responses | `xhigh` | PASS | 200 | yes | 1 | 1510 ms | Streaming function tool call received. |
| `gpt-5.6-sol-2026-07-09` | responses | `max` | PASS | 200 | yes | 1 | 1404 ms | Streaming function tool call received. |
| `gpt-5.6-terra-2026-07-09` | responses | `default` | PASS | 200 | yes | 1 | 1233 ms | Streaming function tool call received. |
| `gpt-5.6-terra-2026-07-09` | responses | `none` | PASS | 200 | yes | 1 | 2143 ms | Streaming function tool call received. |
| `gpt-5.6-terra-2026-07-09` | responses | `low` | PASS | 200 | yes | 1 | 1441 ms | Streaming function tool call received. |
| `gpt-5.6-terra-2026-07-09` | responses | `medium` | PASS | 200 | yes | 1 | 1369 ms | Streaming function tool call received. |
| `gpt-5.6-terra-2026-07-09` | responses | `high` | PASS | 200 | yes | 1 | 1574 ms | Streaming function tool call received. |
| `gpt-5.6-terra-2026-07-09` | responses | `xhigh` | PASS | 200 | yes | 1 | 1747 ms | Streaming function tool call received. |
| `gpt-5.6-terra-2026-07-09` | responses | `max` | PASS | 200 | yes | 1 | 2139 ms | Streaming function tool call received. |
| `o1` | chat-completions | `default` | PASS | 200 | yes | 1 | 2733 ms | Streaming function tool call received. |
| `o3-2025-04-16` | chat-completions | `default` | PASS | 200 | yes | 1 | 1961 ms | Streaming function tool call received. |
| `o3-mini` | chat-completions | `default` | PASS | 200 | no | 1 | 1595 ms | Streaming response received. |
| `o4-mini-2025-04-16` | chat-completions | `default` | PASS | 200 | yes | 1 | 3005 ms | Streaming function tool call received. |
| `claude-opus-4-6-vertex` | messages | `default` | PASS | 200 | yes | 1 | 5997 ms | Streaming function tool call received. |
| `claude-opus-4-6-vertex` | messages | `low` | PASS | 200 | yes | 1 | 4988 ms | Streaming function tool call received. |
| `claude-opus-4-6-vertex` | messages | `medium` | PASS | 200 | yes | 1 | 4856 ms | Streaming function tool call received. |
| `claude-opus-4-6-vertex` | messages | `high` | PASS | 200 | yes | 1 | 3023 ms | Streaming function tool call received. |
| `claude-opus-4-6-vertex` | messages | `max` | PASS | 200 | yes | 1 | 4635 ms | Streaming function tool call received. |
| `claude-4-5-sonnet-vertex` | chat-completions | `default` | PASS | 200 | yes | 1 | 1240 ms | Streaming function tool call received. |
| `claude-sonnet-4-6-vertex` | messages | `default` | PASS | 200 | yes | 1 | 2725 ms | Streaming function tool call received. |
| `claude-sonnet-4-6-vertex` | messages | `low` | PASS | 200 | yes | 1 | 1869 ms | Streaming function tool call received. |
| `claude-sonnet-4-6-vertex` | messages | `medium` | PASS | 200 | yes | 1 | 5368 ms | Streaming function tool call received. |
| `claude-sonnet-4-6-vertex` | messages | `high` | PASS | 200 | yes | 1 | 1649 ms | Streaming function tool call received. |
| `claude-sonnet-4-6-vertex` | messages | `max` | PASS | 200 | yes | 1 | 4738 ms | Streaming function tool call received. |

## Advertised Configuration

| Model | API | Token limits (input/output) | Advertised efforts | VS Code model options |
|---|---|---:|---|---|
| `gpt-5-2-2025-12-11` | chat-completions | 272000 / 128000 | none, low, medium, high | default |
| `claude-4-5-sonnet` | chat-completions | 136000 / 64000 | none | `{"top_p":null}` |
| `claude-sonnet-4-5-20250929` | chat-completions | 136000 / 64000 | none | `{"top_p":null}` |
| `claude-haiku-4-5-20251001` | chat-completions | 136000 / 64000 | none | `{"top_p":null}` |
| `claude-opus-4-5-20251101` | messages | 136000 / 64000 | low, medium, high | `{"top_p":null}` |
| `claude-opus-4-6-20260205` | messages | 872000 / 128000 | low, medium, high, max | `{"top_p":null}` |
| `claude-opus-4-7` | messages | 872000 / 128000 | low, medium, high, xhigh, max | `{"top_p":null}` |
| `claude-opus-4-8` | messages | 872000 / 128000 | low, medium, high, xhigh, max | `{"top_p":null}` |
| `claude-opus-5` | messages | 872000 / 128000 | low, medium, high, xhigh, max | `{"top_p":null}` |
| `claude-sonnet-4-6` | messages | 936000 / 64000 | low, medium, high, max | `{"top_p":null}` |
| `claude-sonnet-5` | messages | 872000 / 128000 | low, medium, high, xhigh, max | `{"top_p":null}` |
| `moonshotai.kimi-k2.5` | chat-completions | 245760 / 16384 | none | default |
| `qwen.qwen3-coder-30b-a3b-v1` | chat-completions | 245760 / 16384 | none | default |
| `qwen.qwen3-coder-480b-a35b-v1` | chat-completions | 114688 / 16384 | none | default |
| `gemini-3-flash` | chat-completions | 983040 / 65536 | minimal, low, medium, high | default |
| `gemini-3.1-flash-image` | chat-completions | unset / unset | none | default |
| `gemini-3.1-pro` | chat-completions | 983040 / 65536 | low, medium, high | default |
| `gemini-3.5-flash` | chat-completions | 983040 / 65536 | minimal, low, medium, high | default |
| `gpt-4.1` | chat-completions | 1014808 / 32768 | none | default |
| `gpt-4.1-mini` | chat-completions | 1014808 / 32768 | none | default |
| `gpt-5-2025-08-07` | chat-completions | 272000 / 128000 | minimal, low, medium, high | `{"top_p":null}` |
| `gpt-5-mini-2025-08-07` | chat-completions | 272000 / 128000 | minimal, low, medium, high | `{"top_p":null}` |
| `gpt-5-nano-2025-08-07` | chat-completions | 272000 / 128000 | minimal, low, medium, high | `{"top_p":null}` |
| `gpt-5-1-codex-2025-11-13` | responses | unset / unset | none | default |
| `gpt-5.4-2026-03-05` | chat-completions | 922000 / 128000 | none, low, medium, high, xhigh | default |
| `gpt-5.5-2026-04-24` | responses | 922000 / 128000 | none, low, medium, high, xhigh | default |
| `gpt-5.6-luna-2026-07-09` | responses | 922000 / 128000 | none, low, medium, high, xhigh, max | default |
| `gpt-5.6-sol-2026-07-09` | responses | 922000 / 128000 | none, low, medium, high, xhigh, max | default |
| `gpt-5.6-terra-2026-07-09` | responses | 922000 / 128000 | none, low, medium, high, xhigh, max | default |
| `o1` | chat-completions | unset / unset | none | default |
| `o3-2025-04-16` | chat-completions | unset / unset | none | default |
| `o3-mini` | chat-completions | unset / unset | none | default |
| `o4-mini-2025-04-16` | chat-completions | unset / unset | none | default |
| `claude-opus-4-6-vertex` | messages | 872000 / 128000 | low, medium, high, max | `{"top_p":null}` |
| `claude-4-5-sonnet-vertex` | chat-completions | 136000 / 64000 | none | `{"top_p":null}` |
| `claude-sonnet-4-6-vertex` | messages | 936000 / 64000 | low, medium, high, max | `{"top_p":null}` |

## Unclassified Models

| Model | Provider | Reason |
|---|---|---|
| `deepseek-r1` | azure_openai | no backend protocol metadata or compatible model-family rule |

## Interpretation

- `default` means no explicit reasoning-effort parameter was sent.
- Every advertised effort was sent using the model’s configured API body shape.
- PASS requires a successful streamed response and, when advertised, a function tool call.
- A model should remain in the released catalog only when every advertised row passes.

## Documentation

- [VS Code custom endpoint model configuration](https://code.visualstudio.com/docs/agent-customization/language-models)
- [OpenAI model and reasoning guidance](https://developers.openai.com/api/docs/models)
- [AWS Claude Messages request parameters](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages-request-response.html)
