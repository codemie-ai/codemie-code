#!/bin/bash
# SessionStart hook: remind agent to use codebase-memory-mcp at session boundaries.
# No external dependencies.
cat << 'REMINDER'
CRITICAL - Code Discovery Protocol:
1. ALWAYS use codebase-memory-mcp tools FIRST for ANY code exploration:
   - search_graph(name_pattern/label/qn_pattern) to find functions/classes/routes
   - trace_path(function_name, mode=calls|data_flow|cross_service) for call chains
   - get_code_snippet(qualified_name) to read source (NOT Read/cat)
   - query_graph(query) for complex Cypher patterns
   - get_architecture(aspects) for project structure
   - search_code(pattern) for text search (graph-augmented grep)
2. Fall back to Grep/Glob/Read ONLY for text content, config values, non-code files.
3. If a project is not indexed yet, run index_repository FIRST.
REMINDER
