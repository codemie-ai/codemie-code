status: DONE_WITH_CONCERNS

commit: 2a834685

Changed paths: the 14 files in `git show --stat HEAD` (src/agents/core/{OtlpAgentAdapter,otlp-field-limits,event-fields/repo-fields}.ts, claude-code-otlp.plugin.ts, copilot-cli-otlp.{plugin,unhooked-tools,usage}.ts, cowork-events.ts, CoworkEventProducer.ts, plus 5 test files). Extra files beyond the brief: repo-fields.ts (tracker passthrough), copilot-cli-otlp.usage.ts, CoworkEventProducer.ts.

Test command: npx vitest run src/agents src/telemetry src/providers/plugins/sso/proxy/plugins/otlp-spool src/utils (339 files, 6198 tests passed); tsc and eslint clean. RED was seen first (5 new tests failed).

Signature changes:
- maskAndBoundFields(fields, mode: ObfuscationMode = 'off'): uses sanitizeDeep on non-identifier keys; cuts via boundedText.
- boundedText(value, maxChars, mode = 'off'): in 'on' uses trimBeforeOpenPlaceholder.
- resolveRepoFields(context, tracker?) passes tracker to resolveStoryFor.
- buildUnhookedToolEvents(sessionId, events, mode = 'off').
- CoworkEnvelope gains optional obfuscation.
- OtlpAgentAdapter: settings resolved once per event batch from hook cwd (InvocationContext.settings); stamps rules_version when on.
- CopilotCliOtlpPlugin.boundedFreeText(mode, value) (private), uses sanitizeText; no more maskSecretsInText import.
Reused: sanitizeText, sanitizeDeep, trimBeforeOpenPlaceholder, OBFUSCATION_RULES_VERSION, resolveAnalyticsSettings, parsePromptFields tracker arg.

Concerns:
- copilot-chat-otlp and codemie-code-hooks have no own collectors for free text: codemie-code-hooks forwards via the claude-code-otlp/base adapter and copilot-chat goes through the base class, so both are covered by OtlpAgentAdapter changes (copilot-chat has a test; codemie-code-hooks has none of its own).
- Cowork derives no ticket fields at all, so its test covers prompt_body, branch and rules_version only (no story_id).
- Copilot daemon-side unhooked-tool events get their mode from the template's rules_version (added to TEMPLATE_FIELDS), since the daemon has no real cwd; a hook-stamped template is what turns it on.
- maskAndBoundFields off mode now uses maskSecretsInLongText (via sanitizeText) instead of maskSecretsInText: differs only for text over 64 KB.
- Tests that do not mock analytics-settings read the real global config.
