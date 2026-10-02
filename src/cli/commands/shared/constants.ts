export const COLOR = {
  PURPLE: { r: 177, g: 185, b: 249 } as const,
} as const;

export const ACTION_TYPE = {
  CANCEL: 'cancel',
  APPLY: 'apply',
  UPDATE: 'update',
  BACK: 'back',
} as const;

export type ActionType = typeof ACTION_TYPE[keyof typeof ACTION_TYPE];

export const SHARED_MESSAGES = {
  WARNING_STALE_REGISTRATION: (kind: 'assistant' | 'skill', name: string, id: string) =>
    `${kind === 'assistant' ? 'Assistant' : 'Skill'} "${name}" (${id}) no longer exists on the server; it remains registered locally. Deselect it to remove it.`,
} as const;
