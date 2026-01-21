#!/bin/bash

# Detect operating system and architecture
OS_NAME=$(uname -s)
OS_ARCH=$(uname -m)
NODE_VERSION=$(node --version 2>/dev/null || echo "not installed")

# Return as additional context (will be injected as system message)
echo "{
  \"decision\": \"allow\",
  \"additionalContext\": \"Operating System: $OS_NAME\\nArchitecture: $OS_ARCH\\nNode.js: $NODE_VERSION\"
}"
