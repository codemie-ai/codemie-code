# VS Code Model Certification Report

- Generated: 2026-07-24T08:31:16.124Z
- Target: `http://127.0.0.1:4001`
- Authentication source: `running-vscode-proxy`
- Flow: streamed function-tool request through the VS Code-scoped CodeMie proxy
- Models: 27
- Model/effort combinations: 111
- Passing combinations: 111
- Failing combinations: 0
- Fully passing models: 27/27

No API keys, tokens, request headers, or response payloads are stored in this report.

## Results

| Model | API | Effort | Result | HTTP | Tool call | Attempts | Duration | Detail |
|---|---|---|---:|---:|---:|---:|---:|---|
| `claude-sonnet-4-5-20250929` | chat-completions | `default` | PASS | 200 | yes | 1 | 2065 ms | Streaming function tool call received. |
| `gpt-4.1` | chat-completions | `default` | PASS | 200 | yes | 1 | 948 ms | Streaming function tool call received. |
| `gpt-4.1-mini` | chat-completions | `default` | PASS | 200 | yes | 1 | 1030 ms | Streaming function tool call received. |
| `gpt-5-2025-08-07` | chat-completions | `default` | PASS | 200 | yes | 1 | 3433 ms | Streaming function tool call received. |
| `gpt-5-2025-08-07` | chat-completions | `minimal` | PASS | 200 | yes | 1 | 1117 ms | Streaming function tool call received. |
| `gpt-5-2025-08-07` | chat-completions | `low` | PASS | 200 | yes | 1 | 2141 ms | Streaming function tool call received. |
| `gpt-5-2025-08-07` | chat-completions | `medium` | PASS | 200 | yes | 1 | 2809 ms | Streaming function tool call received. |
| `gpt-5-2025-08-07` | chat-completions | `high` | PASS | 200 | yes | 1 | 8887 ms | Streaming function tool call received. |
| `gpt-5-mini-2025-08-07` | chat-completions | `default` | PASS | 200 | yes | 1 | 2862 ms | Streaming function tool call received. |
| `gpt-5-mini-2025-08-07` | chat-completions | `minimal` | PASS | 200 | yes | 1 | 831 ms | Streaming function tool call received. |
| `gpt-5-mini-2025-08-07` | chat-completions | `low` | PASS | 200 | yes | 1 | 1922 ms | Streaming function tool call received. |
| `gpt-5-mini-2025-08-07` | chat-completions | `medium` | PASS | 200 | yes | 1 | 2360 ms | Streaming function tool call received. |
| `gpt-5-mini-2025-08-07` | chat-completions | `high` | PASS | 200 | yes | 1 | 3186 ms | Streaming function tool call received. |
| `gpt-5-nano-2025-08-07` | chat-completions | `default` | PASS | 200 | yes | 1 | 4113 ms | Streaming function tool call received. |
| `gpt-5-nano-2025-08-07` | chat-completions | `minimal` | PASS | 200 | yes | 1 | 868 ms | Streaming function tool call received. |
| `gpt-5-nano-2025-08-07` | chat-completions | `low` | PASS | 200 | yes | 1 | 1278 ms | Streaming function tool call received. |
| `gpt-5-nano-2025-08-07` | chat-completions | `medium` | PASS | 200 | yes | 1 | 3463 ms | Streaming function tool call received. |
| `gpt-5-nano-2025-08-07` | chat-completions | `high` | PASS | 200 | yes | 1 | 5720 ms | Streaming function tool call received. |
| `gpt-5-1-codex-2025-11-13` | responses | `default` | PASS | 200 | yes | 1 | 1652 ms | Streaming function tool call received. |
| `gpt-5-1-codex-2025-11-13` | responses | `low` | PASS | 200 | yes | 1 | 2088 ms | Streaming function tool call received. |
| `gpt-5-1-codex-2025-11-13` | responses | `medium` | PASS | 200 | yes | 1 | 2669 ms | Streaming function tool call received. |
| `gpt-5-1-codex-2025-11-13` | responses | `high` | PASS | 200 | yes | 1 | 1656 ms | Streaming function tool call received. |
| `gpt-5-2-2025-12-11` | chat-completions | `default` | PASS | 200 | yes | 1 | 1437 ms | Streaming function tool call received. |
| `gpt-5-2-2025-12-11` | chat-completions | `none` | PASS | 200 | yes | 1 | 1250 ms | Streaming function tool call received. |
| `gpt-5-2-2025-12-11` | chat-completions | `low` | PASS | 200 | yes | 1 | 821 ms | Streaming function tool call received. |
| `gpt-5-2-2025-12-11` | chat-completions | `medium` | PASS | 200 | yes | 1 | 1819 ms | Streaming function tool call received. |
| `gpt-5-2-2025-12-11` | chat-completions | `high` | PASS | 200 | yes | 1 | 968 ms | Streaming function tool call received. |
| `gpt-5.4-2026-03-05` | chat-completions | `default` | PASS | 200 | yes | 1 | 1374 ms | Streaming function tool call received. |
| `gpt-5.4-2026-03-05` | chat-completions | `none` | PASS | 200 | yes | 1 | 1410 ms | Streaming function tool call received. |
| `gpt-5.4-2026-03-05` | chat-completions | `low` | PASS | 200 | yes | 1 | 899 ms | Streaming function tool call received. |
| `gpt-5.4-2026-03-05` | chat-completions | `medium` | PASS | 200 | yes | 1 | 667 ms | Streaming function tool call received. |
| `gpt-5.4-2026-03-05` | chat-completions | `high` | PASS | 200 | yes | 1 | 1465 ms | Streaming function tool call received. |
| `gpt-5.4-2026-03-05` | chat-completions | `xhigh` | PASS | 200 | yes | 1 | 1571 ms | Streaming function tool call received. |
| `gpt-5.5-2026-04-24` | responses | `default` | PASS | 200 | yes | 1 | 3587 ms | Streaming function tool call received. |
| `gpt-5.5-2026-04-24` | responses | `none` | PASS | 200 | yes | 1 | 1782 ms | Streaming function tool call received. |
| `gpt-5.5-2026-04-24` | responses | `low` | PASS | 200 | yes | 1 | 1813 ms | Streaming function tool call received. |
| `gpt-5.5-2026-04-24` | responses | `medium` | PASS | 200 | yes | 1 | 1730 ms | Streaming function tool call received. |
| `gpt-5.5-2026-04-24` | responses | `high` | PASS | 200 | yes | 1 | 1542 ms | Streaming function tool call received. |
| `gpt-5.5-2026-04-24` | responses | `xhigh` | PASS | 200 | yes | 1 | 3337 ms | Streaming function tool call received. |
| `gpt-5.6-luna-2026-07-09` | responses | `default` | PASS | 200 | yes | 1 | 1421 ms | Streaming function tool call received. |
| `gpt-5.6-luna-2026-07-09` | responses | `none` | PASS | 200 | yes | 1 | 2998 ms | Streaming function tool call received. |
| `gpt-5.6-luna-2026-07-09` | responses | `low` | PASS | 200 | yes | 1 | 1437 ms | Streaming function tool call received. |
| `gpt-5.6-luna-2026-07-09` | responses | `medium` | PASS | 200 | yes | 1 | 1311 ms | Streaming function tool call received. |
| `gpt-5.6-luna-2026-07-09` | responses | `high` | PASS | 200 | yes | 1 | 3261 ms | Streaming function tool call received. |
| `gpt-5.6-luna-2026-07-09` | responses | `xhigh` | PASS | 200 | yes | 1 | 1581 ms | Streaming function tool call received. |
| `gpt-5.6-luna-2026-07-09` | responses | `max` | PASS | 200 | yes | 1 | 1379 ms | Streaming function tool call received. |
| `gpt-5.6-sol-2026-07-09` | responses | `default` | PASS | 200 | yes | 1 | 1092 ms | Streaming function tool call received. |
| `gpt-5.6-sol-2026-07-09` | responses | `none` | PASS | 200 | yes | 1 | 2140 ms | Streaming function tool call received. |
| `gpt-5.6-sol-2026-07-09` | responses | `low` | PASS | 200 | yes | 1 | 19806 ms | Streaming function tool call received. |
| `gpt-5.6-sol-2026-07-09` | responses | `medium` | PASS | 200 | yes | 1 | 1136 ms | Streaming function tool call received. |
| `gpt-5.6-sol-2026-07-09` | responses | `high` | PASS | 200 | yes | 1 | 2222 ms | Streaming function tool call received. |
| `gpt-5.6-sol-2026-07-09` | responses | `xhigh` | PASS | 200 | yes | 1 | 1086 ms | Streaming function tool call received. |
| `gpt-5.6-sol-2026-07-09` | responses | `max` | PASS | 200 | yes | 1 | 1269 ms | Streaming function tool call received. |
| `gpt-5.6-terra-2026-07-09` | responses | `default` | PASS | 200 | yes | 1 | 1794 ms | Streaming function tool call received. |
| `gpt-5.6-terra-2026-07-09` | responses | `none` | PASS | 200 | yes | 1 | 2149 ms | Streaming function tool call received. |
| `gpt-5.6-terra-2026-07-09` | responses | `low` | PASS | 200 | yes | 1 | 1468 ms | Streaming function tool call received. |
| `gpt-5.6-terra-2026-07-09` | responses | `medium` | PASS | 200 | yes | 1 | 1873 ms | Streaming function tool call received. |
| `gpt-5.6-terra-2026-07-09` | responses | `high` | PASS | 200 | yes | 1 | 1921 ms | Streaming function tool call received. |
| `gpt-5.6-terra-2026-07-09` | responses | `xhigh` | PASS | 200 | yes | 1 | 1950 ms | Streaming function tool call received. |
| `gpt-5.6-terra-2026-07-09` | responses | `max` | PASS | 200 | yes | 1 | 1266 ms | Streaming function tool call received. |
| `gemini-3-flash` | chat-completions | `default` | PASS | 200 | yes | 1 | 1959 ms | Streaming function tool call received. |
| `gemini-3-flash` | chat-completions | `minimal` | PASS | 200 | yes | 1 | 844 ms | Streaming function tool call received. |
| `gemini-3-flash` | chat-completions | `low` | PASS | 200 | yes | 1 | 847 ms | Streaming function tool call received. |
| `gemini-3-flash` | chat-completions | `medium` | PASS | 200 | yes | 1 | 1269 ms | Streaming function tool call received. |
| `gemini-3-flash` | chat-completions | `high` | PASS | 200 | yes | 1 | 1614 ms | Streaming function tool call received. |
| `gemini-3.1-pro` | chat-completions | `default` | PASS | 200 | yes | 1 | 5728 ms | Streaming function tool call received. |
| `gemini-3.1-pro` | chat-completions | `low` | PASS | 200 | yes | 1 | 2616 ms | Streaming function tool call received. |
| `gemini-3.1-pro` | chat-completions | `medium` | PASS | 200 | yes | 1 | 3136 ms | Streaming function tool call received. |
| `gemini-3.1-pro` | chat-completions | `high` | PASS | 200 | yes | 1 | 3194 ms | Streaming function tool call received. |
| `gemini-3.5-flash` | chat-completions | `default` | PASS | 200 | yes | 1 | 1660 ms | Streaming function tool call received. |
| `gemini-3.5-flash` | chat-completions | `minimal` | PASS | 200 | yes | 1 | 17292 ms | Streaming function tool call received. |
| `gemini-3.5-flash` | chat-completions | `low` | PASS | 200 | yes | 1 | 25835 ms | Streaming function tool call received. |
| `gemini-3.5-flash` | chat-completions | `medium` | PASS | 200 | yes | 1 | 15569 ms | Streaming function tool call received. |
| `gemini-3.5-flash` | chat-completions | `high` | PASS | 200 | yes | 1 | 16069 ms | Streaming function tool call received. |
| `claude-4-5-sonnet` | chat-completions | `default` | PASS | 200 | yes | 1 | 1464 ms | Streaming function tool call received. |
| `claude-sonnet-4-6` | messages | `default` | PASS | 200 | yes | 1 | 3260 ms | Streaming function tool call received. |
| `claude-sonnet-4-6` | messages | `low` | PASS | 200 | yes | 1 | 2286 ms | Streaming function tool call received. |
| `claude-sonnet-4-6` | messages | `medium` | PASS | 200 | yes | 1 | 1935 ms | Streaming function tool call received. |
| `claude-sonnet-4-6` | messages | `high` | PASS | 200 | yes | 1 | 1793 ms | Streaming function tool call received. |
| `claude-sonnet-4-6` | messages | `max` | PASS | 200 | yes | 1 | 1852 ms | Streaming function tool call received. |
| `claude-sonnet-5` | messages | `default` | PASS | 200 | yes | 1 | 1829 ms | Streaming function tool call received. |
| `claude-sonnet-5` | messages | `low` | PASS | 200 | yes | 1 | 1616 ms | Streaming function tool call received. |
| `claude-sonnet-5` | messages | `medium` | PASS | 200 | yes | 1 | 1987 ms | Streaming function tool call received. |
| `claude-sonnet-5` | messages | `high` | PASS | 200 | yes | 1 | 2920 ms | Streaming function tool call received. |
| `claude-sonnet-5` | messages | `xhigh` | PASS | 200 | yes | 1 | 1918 ms | Streaming function tool call received. |
| `claude-sonnet-5` | messages | `max` | PASS | 200 | yes | 1 | 1762 ms | Streaming function tool call received. |
| `claude-opus-4-5-20251101` | messages | `default` | PASS | 200 | yes | 1 | 2114 ms | Streaming function tool call received. |
| `claude-opus-4-5-20251101` | messages | `low` | PASS | 200 | yes | 1 | 1635 ms | Streaming function tool call received. |
| `claude-opus-4-5-20251101` | messages | `medium` | PASS | 200 | yes | 1 | 1844 ms | Streaming function tool call received. |
| `claude-opus-4-5-20251101` | messages | `high` | PASS | 200 | yes | 1 | 1720 ms | Streaming function tool call received. |
| `claude-opus-4-6-20260205` | messages | `default` | PASS | 200 | yes | 1 | 1762 ms | Streaming function tool call received. |
| `claude-opus-4-6-20260205` | messages | `low` | PASS | 200 | yes | 1 | 1919 ms | Streaming function tool call received. |
| `claude-opus-4-6-20260205` | messages | `medium` | PASS | 200 | yes | 1 | 2658 ms | Streaming function tool call received. |
| `claude-opus-4-6-20260205` | messages | `high` | PASS | 200 | yes | 1 | 1746 ms | Streaming function tool call received. |
| `claude-opus-4-6-20260205` | messages | `max` | PASS | 200 | yes | 1 | 1749 ms | Streaming function tool call received. |
| `claude-opus-4-7` | messages | `default` | PASS | 200 | yes | 1 | 1433 ms | Streaming function tool call received. |
| `claude-opus-4-7` | messages | `low` | PASS | 200 | yes | 1 | 1489 ms | Streaming function tool call received. |
| `claude-opus-4-7` | messages | `medium` | PASS | 200 | yes | 1 | 2842 ms | Streaming function tool call received. |
| `claude-opus-4-7` | messages | `high` | PASS | 200 | yes | 1 | 1359 ms | Streaming function tool call received. |
| `claude-opus-4-7` | messages | `xhigh` | PASS | 200 | yes | 1 | 2265 ms | Streaming function tool call received. |
| `claude-opus-4-7` | messages | `max` | PASS | 200 | yes | 1 | 1312 ms | Streaming function tool call received. |
| `claude-opus-4-8` | messages | `default` | PASS | 200 | yes | 1 | 1777 ms | Streaming function tool call received. |
| `claude-opus-4-8` | messages | `low` | PASS | 200 | yes | 1 | 2838 ms | Streaming function tool call received. |
| `claude-opus-4-8` | messages | `medium` | PASS | 200 | yes | 1 | 1640 ms | Streaming function tool call received. |
| `claude-opus-4-8` | messages | `high` | PASS | 200 | yes | 1 | 1518 ms | Streaming function tool call received. |
| `claude-opus-4-8` | messages | `xhigh` | PASS | 200 | yes | 1 | 1535 ms | Streaming function tool call received. |
| `claude-opus-4-8` | messages | `max` | PASS | 200 | yes | 1 | 1778 ms | Streaming function tool call received. |
| `claude-haiku-4-5-20251001` | chat-completions | `default` | PASS | 200 | yes | 1 | 1941 ms | Streaming function tool call received. |
| `qwen.qwen3-coder-30b-a3b-v1` | chat-completions | `default` | PASS | 200 | yes | 1 | 1011 ms | Streaming function tool call received. |
| `qwen.qwen3-coder-480b-a35b-v1` | chat-completions | `default` | PASS | 200 | yes | 1 | 454 ms | Streaming function tool call received. |
| `moonshotai.kimi-k2.5` | chat-completions | `default` | PASS | 200 | yes | 1 | 615 ms | Streaming function tool call received. |

## Advertised Configuration

| Model | API | Advertised efforts | VS Code model options |
|---|---|---|---|
| `claude-sonnet-4-5-20250929` | chat-completions | none | `{"top_p":null}` |
| `gpt-4.1` | chat-completions | none | default |
| `gpt-4.1-mini` | chat-completions | none | default |
| `gpt-5-2025-08-07` | chat-completions | minimal, low, medium, high | default |
| `gpt-5-mini-2025-08-07` | chat-completions | minimal, low, medium, high | default |
| `gpt-5-nano-2025-08-07` | chat-completions | minimal, low, medium, high | default |
| `gpt-5-1-codex-2025-11-13` | responses | low, medium, high | default |
| `gpt-5-2-2025-12-11` | chat-completions | none, low, medium, high | default |
| `gpt-5.4-2026-03-05` | chat-completions | none, low, medium, high, xhigh | default |
| `gpt-5.5-2026-04-24` | responses | none, low, medium, high, xhigh | default |
| `gpt-5.6-luna-2026-07-09` | responses | none, low, medium, high, xhigh, max | default |
| `gpt-5.6-sol-2026-07-09` | responses | none, low, medium, high, xhigh, max | default |
| `gpt-5.6-terra-2026-07-09` | responses | none, low, medium, high, xhigh, max | default |
| `gemini-3-flash` | chat-completions | minimal, low, medium, high | default |
| `gemini-3.1-pro` | chat-completions | low, medium, high | default |
| `gemini-3.5-flash` | chat-completions | minimal, low, medium, high | default |
| `claude-4-5-sonnet` | chat-completions | none | `{"top_p":null}` |
| `claude-sonnet-4-6` | messages | low, medium, high, max | default |
| `claude-sonnet-5` | messages | low, medium, high, xhigh, max | default |
| `claude-opus-4-5-20251101` | messages | low, medium, high | default |
| `claude-opus-4-6-20260205` | messages | low, medium, high, max | default |
| `claude-opus-4-7` | messages | low, medium, high, xhigh, max | default |
| `claude-opus-4-8` | messages | low, medium, high, xhigh, max | default |
| `claude-haiku-4-5-20251001` | chat-completions | none | `{"top_p":null}` |
| `qwen.qwen3-coder-30b-a3b-v1` | chat-completions | none | default |
| `qwen.qwen3-coder-480b-a35b-v1` | chat-completions | none | default |
| `moonshotai.kimi-k2.5` | chat-completions | none | default |

## Interpretation

- `default` means no explicit reasoning-effort parameter was sent.
- Every advertised effort was sent using the model’s configured API body shape.
- PASS requires both a successful HTTP response and a streamed function tool call.
- A model should remain in the released catalog only when every advertised row passes.

## Documentation

- [VS Code custom endpoint model configuration](https://code.visualstudio.com/docs/agent-customization/language-models)
- [OpenAI model and reasoning guidance](https://developers.openai.com/api/docs/models)
- [AWS Claude Messages request parameters](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages-request-response.html)
