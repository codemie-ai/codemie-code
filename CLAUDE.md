# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Critical First Step: ALWAYS Read Documentation

**MANDATORY**: Before writing ANY code, you MUST:
1. Read the `README.md` file - this is your PRIMARY source of truth
2. Review this CLAUDE.md for architectural patterns and conventions
3. Study reference implementations mentioned in this guide

## Common Commands

```bash
# Installation & Setup
npm install                 # Install dependencies
npm link                    # Link globally for local testing

# Building
npm run build              # Compile TypeScript
npm run dev                # Watch mode for development

# Code Quality
npm run lint               # Check code style with ESLint
npm run lint:fix           # Fix linting issues automatically

# Development Workflow
npm run build && npm link  # Build and link for testing
codemie doctor             # Verify installation and configuration

# Release & Publishing
git tag -a v0.0.1 -m "Release version 0.0.1"  # Create release tag
git push origin v0.0.1                         # Push tag to trigger publish
```

## Core Principles

**ALWAYS follow these fundamental principles:**

### KISS (Keep It Simple, Stupid)
- Write simple, straightforward code that's easy to understand
- Avoid over-engineering and unnecessary complexity
- Remove redundant code, scripts, and configuration
- If something can be done in fewer lines/steps, do it
- Question every piece of complexity - is it truly needed?

### DRY (Don't Repeat Yourself)
- Never duplicate code, logic, or configuration
- Extract common patterns into reusable functions/utilities
- Reuse existing utilities from \`src/utils/\` before creating new ones
- If you find yourself copying code, refactor it into a shared function
- One source of truth for each piece of knowledge

**Remember:** Simple, clean code is better than clever, complex code.

## Project Overview

**CodeMie** is a unified CLI wrapper for managing multiple AI coding agents (Claude Code, Codex, etc.).
