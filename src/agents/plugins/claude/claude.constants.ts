/**
 * Claude Code Plugin Constants
 * Single source of truth for Claude Code configuration
 */

/**
 * Supported Claude Code version
 * This is the latest version tested and verified with CodeMie backend
 *
 * **UPDATE THIS WHEN BUMPING CLAUDE VERSION**
 * - Update this constant to change the supported version across the entire codebase
 * - All references to Claude version will automatically use this value
 */
export const CLAUDE_SUPPORTED_VERSION = "2.1.25";

/**
 * Claude Code installer URLs
 * Official Anthropic installer scripts for native installation
 */
export const CLAUDE_INSTALLER_URLS = {
  macOS: "https://claude.ai/install.sh",
  windows: "https://claude.ai/install.cmd",
  linux: "https://claude.ai/install.sh",
} as const;
