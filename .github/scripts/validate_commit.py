#!/usr/bin/env python3
"""Validate commit message format and length.

This script validates that commit messages follow a specific pattern and
that all lines are within a maximum length limit.

Example:
    python3 validate_commit.py --pattern "^PROJ-\\d+:.*" --max-length 300
"""

import argparse
import re
import subprocess
import sys
from typing import List, Tuple


def get_commit_message(commit_ref: str = "HEAD") -> str:
    """Fetch commit message from git log.

    Args:
        commit_ref: Git reference to fetch (default: HEAD).

    Returns:
        The commit message as a string.

    Raises:
        SystemExit: If git command fails.
    """
    result = subprocess.run(
        ["git", "log", "--format=%B", "-n", "1", commit_ref],
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        print(f"ERROR: Failed to fetch commit message: {result.stderr}")
        sys.exit(1)

    return result.stdout.strip()


def validate_pattern(first_line: str, pattern: str) -> bool:
    """Validate commit message first line against regex pattern.

    Args:
        first_line: The first line of the commit message.
        pattern: The regex pattern to match against.

    Returns:
        True if pattern matches, False otherwise.
    """
    # Allow merge commits (e.g., "Merge <hash> into <hash>")
    if first_line.startswith("Merge "):
        return True

    # Allow revert commits (e.g., "Revert "feat: something"")
    if first_line.startswith("Revert "):
        return True

    return bool(re.match(pattern, first_line))


def validate_line_lengths(
    lines: List[str], max_length: int
) -> Tuple[bool, int, str]:
    """Validate that all lines are within max length.

    Args:
        lines: List of lines to validate.
        max_length: Maximum allowed line length.

    Returns:
        Tuple of (is_valid, line_number, line_content).
    """
    for i, line in enumerate(lines, start=1):
        if len(line) > max_length:
            return False, i, line
    return True, 0, ""


def main() -> None:
    """Main validation logic."""
    parser = argparse.ArgumentParser(
        description="Validate commit message format and length"
    )
    parser.add_argument(
        "--pattern",
        required=True,
        help="Regex pattern that commit message must match",
    )
    parser.add_argument(
        "--max-length",
        type=int,
        default=300,
        help="Maximum allowed line length (default: 300)",
    )
    parser.add_argument(
        "--commit-ref",
        default="HEAD",
        help="Git reference to validate (default: HEAD)",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose output",
    )

    args = parser.parse_args()

    commit_message = get_commit_message(args.commit_ref)
    lines = commit_message.split("\n")
    first_line = lines[0] if lines else ""

    if args.verbose:
        print("Validating commit message...")
        print(f"Pattern: {args.pattern}")
        print(f"Commit message:\n{commit_message}\n")
        print(f"First line: {first_line}")

    if not validate_pattern(first_line, args.pattern):
        print("FAILED: Commit message is invalid.")
        print(f"Expected pattern: {args.pattern}")
        print(f"First line: {first_line}")
        sys.exit(1)

    # Skip length validation for merge and revert commits
    if not (first_line.startswith("Merge ") or first_line.startswith("Revert ")):
        is_valid, line_num, line_content = validate_line_lengths(
            lines, args.max_length
        )
        if not is_valid:
            print(
                f"FAILED: Line {line_num} exceeds {args.max_length} "
                f"characters (length: {len(line_content)})"
            )
            print(f"Line content: {line_content}")
            sys.exit(1)

    print("PASSED: Commit message is valid!")


if __name__ == "__main__":
    main()
