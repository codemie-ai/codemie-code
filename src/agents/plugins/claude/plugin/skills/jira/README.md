# Jira Skill for CodeMie / Claude Code

Enables Claude Code to interact with Jira as a first-class citizen of the AI software
development lifecycle. Claude can read tickets before implementing features, update ticket
status, add comments, manage sprints, and more — all via the
[`jira-cli`](https://github.com/ankitpokhrel/jira-cli) binary.

---

## Installation

### macOS

```bash
brew install ankitpokhrel/jira-cli/jira-cli
```

### Linux

Download the latest binary from [GitHub Releases](https://github.com/ankitpokhrel/jira-cli/releases):

```bash
# Example for Linux amd64
curl -L https://github.com/ankitpokhrel/jira-cli/releases/latest/download/jira_linux_x86_64.tar.gz | tar xz
chmod +x jira
sudo mv jira /usr/local/bin/jira
```

Verify the installation:

```bash
jira version
```

---

## Configuration (one-time per Jira instance)

Run the interactive setup wizard:

```bash
jira init
```

The wizard will ask for:
- **Installation type**: `Cloud` (Atlassian Cloud) or `Local` (Server / Data Center)
- **Server URL**: e.g., `https://yourcompany.atlassian.net` or `https://jira.yourcompany.com`
- **Login**: your email (Cloud) or username (on-premise)
- **API token**: see the Credentials section below

Config is saved to `$HOME/.config/.jira/.config.yml`. Do **not** commit this file to version control.

---

## Credentials

### Atlassian Cloud

1. Generate an API token at: https://id.atlassian.com/manage-profile/security/api-tokens
2. Export it in your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export JIRA_API_TOKEN="your-atlassian-api-token"
```

### On-premise (Server / Data Center) — Personal Access Token

```bash
export JIRA_API_TOKEN="your-personal-access-token"
export JIRA_AUTH_TYPE="bearer"
```

Add all exports to your `~/.zshrc` or `~/.bashrc` for persistence.

---

## Verification

After configuration, verify the connection:

```bash
jira me --plain
```

You should see your Jira user profile. If it fails, re-run `jira init` or check your token.

---

## Multi-project / Multi-instance Setup

If you work with multiple Jira instances, use a per-project config file:

```bash
# Initialize a project-specific config
jira init -c ./jira-project.yml

# Use it for commands
jira issue list -c ./jira-project.yml

# Or set an env var
export JIRA_CONFIG_FILE=./jira-project.yml
```

---

## What Claude Can Do With This Skill

| Operation | Example trigger |
|-----------|----------------|
| Read a ticket | "Read PROJ-123", "What are the acceptance criteria for PROJ-123?" |
| Implement a ticket | "Implement PROJ-123", "Work on ticket PROJ-456" |
| Add a comment | "Add a comment to PROJ-123 saying implementation is complete" |
| Transition status | "Move PROJ-123 to In Review" |
| Assign to self | "Assign PROJ-123 to me" |
| List sprint issues | "What's in my sprint?", "Show my open tickets" |
| Create an issue | "Create a bug ticket in PROJ for the login error" |
| Link a PR | "Link PR #42 to PROJ-123" |
| Log work | "Log 2 hours on PROJ-123" |

---

## Optional: Install jq

`jq` is not required but useful for processing `--raw` JSON output from jira-cli:

```bash
brew install jq   # macOS
apt install jq    # Ubuntu/Debian
```

---

## Links

- [jira-cli GitHub](https://github.com/ankitpokhrel/jira-cli)
- [jira-cli Releases](https://github.com/ankitpokhrel/jira-cli/releases)
- [Atlassian API Token Management](https://id.atlassian.com/manage-profile/security/api-tokens)
- [Jira REST API v3 Docs](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)