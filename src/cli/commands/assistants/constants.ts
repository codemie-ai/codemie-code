/**
 * Constants for assistants commands
 */

export const COMMAND_NAMES = {
  LIST: 'list',
  CHAT: 'chat'
} as const;

export const EXIT_PROMPTS = ['exit', 'quit', '/exit', '/quit'] as const;

export const ROLES = {
  USER: 'User',
  ASSISTANT: 'Assistant'
} as const;

export const ACTIONS = {
  UPDATE: 'update',
  CANCEL: 'cancel'
} as const;

export type MessageRole = typeof ROLES.USER | typeof ROLES.ASSISTANT;
export type ActionType = typeof ACTIONS.UPDATE | typeof ACTIONS.CANCEL;

export interface HistoryMessage {
  role: MessageRole;
  message?: string;
}

export const MESSAGES = {
  SHARED: {
    OPTION_VERBOSE: 'Enable verbose debug output',
    ERROR_NO_ASSISTANTS: '\n✗ No registered assistants',
    ERROR_ASSISTANT_NOT_FOUND: (id: string) => `\n✗ Assistant ${id} is not registered`,
    ERROR_NOT_FOUND: (id: string) => `Assistant ${id} not found`,
    ERROR_AUTH_EXPIRED: 'Authentication expired. Please re-authenticate.',
    HINT_REGISTER: '  Run: ',
    COMMAND_LIST: 'codemie assistants list',
    HINT_REGISTER_SUFFIX: ' to register assistants\n',
    HINT_SEE_ASSISTANTS: ' to see registered assistants\n',
    PROMPT_SELECT_ASSISTANT: 'Select an assistant:'
  },
  CHAT: {
    COMMAND_DESCRIPTION: 'Send a message to a registered CodeMie assistant',
    ARGUMENT_ASSISTANT_ID: 'Assistant ID (if provided, runs in single-message mode)',
    ARGUMENT_MESSAGE: 'Message to send (required when assistant-id is provided)',
    HEADER: (name: string) => `\n💬 Chat with ${name}`,
    INSTRUCTIONS: 'Type your message and press Enter. Type "/exit" or "/quit" to end the conversation.\n',
    GOODBYE: '\nGoodbye!\n',
    PROMPT_YOUR_MESSAGE: '>',
    VALIDATION_MESSAGE_EMPTY: 'Message cannot be empty',
    SPINNER_THINKING: 'Thinking...',
    FALLBACK_NO_RESPONSE: 'No response',
    ERROR_SEND_FAILED: 'Failed to send message',
    RETRY_PROMPT: 'Failed to get response. Try again or type "/exit" to quit.\n'
  },
  LIST: {
    COMMAND_DESCRIPTION: 'Manage CodeMie assistants (view, register, unregister)',
    OPTION_PROFILE: 'Select profile to configure',
    OPTION_PROJECT: 'Filter assistants by project name',
    OPTION_ALL_PROJECTS: 'Show assistants from all projects',
    SPINNER_FETCHING: 'Fetching assistants...',
    SUCCESS_FOUND: (count: number) => `Found ${count} assistant${count === 1 ? '' : 's'}`,
    ERROR_FETCH_FAILED: 'Failed to fetch assistants',
    NO_ASSISTANTS: '\nNo assistants found.',
    FILTERED_BY_PROJECT: (project: string) => `Filtered by project: ${project}`,
    TRY_ALL_PROJECTS: '--all-projects',
    HINT_TRY_ALL: ' to see all assistants.\n',
    PROMPT_SELECT: 'Select assistants to register (space to toggle, enter when done):',
    PROMPT_ACTION: 'What would you like to do?',
    ACTION_UPDATE: 'Update - Apply changes',
    ACTION_CANCEL: 'Cancel - Discard changes',
    NO_CHANGES_MADE: '\nNo changes made.\n',
    NO_CHANGES_TO_APPLY: '\nNo changes to apply\n',
    SPINNER_REGISTERING: (name: string) => `Registering ${name}...`,
    SPINNER_UNREGISTERING: (name: string) => `Unregistering ${name}...`,
    SUCCESS_REGISTERED: (name: string, slug: string) => `Registered ${name} as /${slug}`,
    SUCCESS_UNREGISTERED: (name: string, slug: string) => `Unregistered ${name} (/${slug})`,
    ERROR_REGISTER_FAILED: (name: string) => `Failed to register ${name}`,
    ERROR_UNREGISTER_FAILED: (name: string) => `Failed to unregister ${name}`,
    SUMMARY_UPDATED: (count: number) => `\n✓ Updated ${count} assistant${count === 1 ? '' : 's'}`,
    SUMMARY_REGISTERED: (count: number) => `  Registered: ${count}`,
    SUMMARY_UNREGISTERED: (count: number) => `  Unregistered: ${count}`,
    SUMMARY_PROFILE: (profile: string) => `  Profile: ${profile}\n`,
    CURRENTLY_REGISTERED: 'Currently registered assistants:'
  }
} as const;
