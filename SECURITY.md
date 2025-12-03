# Security Policy

## Supported Versions

We release patches for security vulnerabilities. Which versions are eligible for receiving such patches depends on the CVSS v3.0 Rating:

| Version | Supported          |
| ------- | ------------------ |
| 0.0.x   | :white_check_mark: |

## Reporting a Vulnerability

The CodeMie team takes security bugs seriously. We appreciate your efforts to responsibly disclose your findings, and will make every effort to acknowledge your contributions.

### How to Report a Security Vulnerability

**Please DO NOT file a public issue** for security vulnerabilities. Instead, please report security vulnerabilities through one of the following channels:

#### GitHub Security Advisory (Preferred)

1. Go to the [Security tab](https://github.com/codemie-ai/codemie-code/security) of the repository
2. Click on "Report a vulnerability"
3. Fill out the security advisory form with details about the vulnerability


### What to Expect

After you submit a vulnerability report, you can expect:

1. **Acknowledgment**: We will acknowledge receipt of your vulnerability report within **48 hours**
2. **Initial Assessment**: We will provide an initial assessment within **10 business days**
3. **Updates**: We will keep you informed about our progress as we work on a fix
4. **Resolution**: We will notify you when the vulnerability has been fixed and publicly disclosed

### Disclosure Policy

- We will coordinate with you on the disclosure timeline
- We will credit you in the security advisory (unless you prefer to remain anonymous)
- We request that you do not publicly disclose the vulnerability until we have released a fix
- We aim to release fixes for critical vulnerabilities within 30 days

## Security Update Distribution

Security updates will be released as:

1. **New Package Versions**: Published to npm with security notes in the release
2. **GitHub Security Advisories**: Published in the repository's Security tab
3. **Release Notes**: Detailed in GitHub releases with `[SECURITY]` tag

## Security Best Practices for Users

When using CodeMie CLI:

1. **API Keys**: Never commit API keys or credentials to version control
   - Use environment variables or secure config files
   - Run `npm run validate:secrets` before committing (requires Docker)

2. **Configuration Files**: The `~/.codemie/config.json` file may contain sensitive data
   - Ensure proper file permissions (readable only by you)
   - Do not share this file or include it in backups without redacting secrets

3. **SSO Authentication**: When using AI/Run SSO:
   - Tokens are stored securely in the system keychain
   - Use `codemie auth logout` to clear tokens when needed

4. **Proxy Server**: When using the built-in proxy:
   - Only run on localhost
   - The proxy should not be exposed to external networks
   - Logs may contain sensitive request/response data

5. **Analytics**: Analytics data is collected locally by default
   - Review `~/.codemie/analytics/` for sensitive information
   - Use `codemie analytics disable` if you prefer not to collect analytics

6. **Updates**: Keep CodeMie CLI up to date
   ```bash
   npm update -g @codemieai/code
   ```

## Known Security Considerations

### API Key Handling
- API keys are stored in plain text in `~/.codemie/config.json`
- Ensure this file has restricted permissions (600 on Unix-like systems)
- Consider using environment variables for ephemeral sessions

### Network Communication
- All API requests use HTTPS by default
- The proxy server can handle custom SSL certificates for enterprise environments
- Self-signed certificates require explicit configuration

### Code Execution
- The CLI can execute shell commands through built-in tools
- External agents (Claude Code, Codex) run with your user permissions
- Review code before executing suggested commands

## Compliance

CodeMie CLI is designed with security and privacy in mind:

- **Data Privacy**: User prompts and code are sent only to configured AI providers
- **Local Processing**: Configuration and analytics are stored locally
- **No Telemetry**: We do not collect usage data without explicit opt-in
- **Open Source**: All code is available for security review

## Bug Bounty Program

We do not currently have a formal bug bounty program. However, we deeply appreciate responsible disclosure of security vulnerabilities and will publicly acknowledge your contributions (with your permission).

## Contact

For security-related questions or concerns that are not vulnerabilities, you can reach us at:
- Email: security@codemie.ai
- GitHub Issues: [https://github.com/codemie-ai/codemie-code/issues](https://github.com/codemie-ai/codemie-code/issues) (for non-sensitive security questions)

## Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [CWE/SANS Top 25](https://cwe.mitre.org/top25/)
- [GitHub Security Best Practices](https://docs.github.com/en/code-security)
