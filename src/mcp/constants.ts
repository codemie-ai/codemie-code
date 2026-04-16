/** Default client_name for MCP OAuth dynamic client registration. Overridable via MCP_CLIENT_NAME env var. */
export const DEFAULT_MCP_CLIENT_NAME = 'CodeMie CLI';

/** Get the MCP client name from env var or default. */
export function getMcpClientName(): string {
  return process.env.MCP_CLIENT_NAME || DEFAULT_MCP_CLIENT_NAME;
}
