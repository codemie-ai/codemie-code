/**
 * Claude Code writes `<synthetic>` as `message.model` for API-error placeholder rows, not for a
 * real billable model. It must never rank as a primary model — neither `agent.session.summary`'s
 * `primary_model` nor `agent.subagent.usage`'s top-level `model`.
 */
export function isSyntheticModel(model: string): boolean {
  return model === '<synthetic>';
}
