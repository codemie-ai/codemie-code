#!/bin/bash
# Demo script for testing hooks in codemie-code

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}   CodeMie Hooks Demo${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check if config exists
if [ ! -f ~/.codemie/codemie-cli.config.json ]; then
    echo -e "${RED}✗ Configuration file not found${NC}"
    exit 1
fi

# Show configured hooks
echo -e "${GREEN}✓ Configuration loaded${NC}"
echo ""
echo "Configured Hooks:"
echo "━━━━━━━━━━━━━━━━"

# PreToolUse
echo -e "${YELLOW}PreToolUse:${NC}"
echo "  • Matcher: Bash"
echo "  • Action: Block 'rm -rf' commands"
echo "  • Script: ~/.codemie/test-hooks/pre-tool-hook.sh"

echo ""
echo -e "${YELLOW}PostToolUse:${NC}"
echo "  • Matcher: * (all tools)"
echo "  • Action: Log all tool usage"
echo "  • Script: ~/.codemie/test-hooks/post-tool-hook.sh"

echo ""
echo -e "${YELLOW}UserPromptSubmit:${NC}"
echo "  • Action: Add context to prompts"
echo "  • Script: ~/.codemie/test-hooks/prompt-hook.sh"

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Clear logs for clean test
rm -f ~/.codemie/hook-test.log
rm -f ~/.codemie/tool-usage.log
echo -e "${GREEN}✓ Logs cleared for clean test${NC}"
echo ""

# Show test scenarios
echo -e "${BLUE}Test Scenarios:${NC}"
echo "━━━━━━━━━━━━━━━━"
echo ""

echo -e "${YELLOW}Scenario 1: PreToolUse Hook Blocks Dangerous Command${NC}"
echo "  Try: \"run the command: rm -rf /tmp/test\""
echo "  Expected: Hook blocks it with error"
echo ""

echo -e "${YELLOW}Scenario 2: PreToolUse Hook Allows Safe Command${NC}"
echo "  Try: \"run the command: echo 'Hello World'\""
echo "  Expected: Command executes normally"
echo ""

echo -e "${YELLOW}Scenario 3: PostToolUse Hook Logs Tools${NC}"
echo "  Try: \"read package.json and show me the name\""
echo "  Expected: Tool usage logged to ~/.codemie/tool-usage.log"
echo ""

echo -e "${YELLOW}Scenario 4: UserPromptSubmit Hook Adds Context${NC}"
echo "  Try any prompt and check if context is added"
echo "  Expected: Agent has context about working directory"
echo ""

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

echo -e "${GREEN}Monitoring:${NC}"
echo "  Watch hooks in real-time:"
echo "  ${BLUE}tail -f ~/.codemie/logs/debug-\$(date +%Y-%m-%d).log | grep -i hook${NC}"
echo ""
echo "  Check hook logs after test:"
echo "  ${BLUE}cat ~/.codemie/hook-test.log${NC}"
echo "  ${BLUE}cat ~/.codemie/tool-usage.log${NC}"
echo ""

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Ask if user wants to set API key
echo -e "${YELLOW}⚠ Important: You need a valid API key to run codemie-code${NC}"
echo ""
echo "Options:"
echo "  1. Set CODEMIE_API_KEY environment variable"
echo "  2. Update ~/.codemie/codemie-cli.config.json with your key"
echo "  3. Run: codemie setup"
echo ""

read -p "Do you have an API key configured? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "${YELLOW}Please configure your API key first:${NC}"
    echo "  export CODEMIE_API_KEY='your-key-here'"
    echo ""
    echo "Then run:"
    echo "  ${BLUE}codemie-code${NC}"
    echo ""
    exit 0
fi

echo ""
echo -e "${GREEN}Starting codemie-code with hooks enabled...${NC}"
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Start codemie-code
codemie-code
