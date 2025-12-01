#!/usr/bin/env python3
"""Validate pull request title format and length.

This script validates that PR titles follow a specific pattern and
are within a maximum length limit.

Example:
    python3 validate_pr_title.py --pattern "^PROJ-\\d+:.*" --max-length 300 \
        --pr-number 123 --repo owner/repo
"""

import argparse
import json
import re
import subprocess
import sys


def fetch_pr_title(pr_number: str, repo: str) -> str:
    """Fetch PR title using GitHub CLI.

    Args:
        pr_number: The pull request number.
        repo: The repository in format 'owner/repo'.

    Returns:
        The PR title as a string.

    Raises:
        SystemExit: If gh command fails or JSON parsing fails.
    """
    result = subprocess.run(
        ["gh", "pr", "view", pr_number, "--json", "title", "--repo", repo],
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        print(f"ERROR: Failed to fetch PR title: {result.stderr}")
        sys.exit(1)

    try:
        pr_data = json.loads(result.stdout)
        return pr_data["title"]
    except (json.JSONDecodeError, KeyError) as e:
        print(f"ERROR: Failed to parse PR data: {e}")
        sys.exit(1)


def validate_title_length(title: str, max_length: int) -> bool:
    """Check if title length is within allowed limit.

    Args:
        title: The PR title to validate.
        max_length: Maximum allowed length.

    Returns:
        True if length is valid, False otherwise.
    """
    return len(title) <= max_length


def validate_title_pattern(title: str, pattern: str) -> bool:
    """Validate PR title against regex pattern.

    Args:
        title: The PR title to validate.
        pattern: The regex pattern to match against.

    Returns:
        True if pattern matches, False otherwise.
    """
    return bool(re.match(pattern, title))


def main() -> None:
    """Main validation logic."""
    parser = argparse.ArgumentParser(
        description="Validate pull request title format and length"
    )
    parser.add_argument(
        "--pattern",
        required=True,
        help="Regex pattern that PR title must match",
    )
    parser.add_argument(
        "--max-length",
        type=int,
        default=300,
        help="Maximum allowed title length (default: 300)",
    )
    parser.add_argument(
        "--pr-number",
        required=True,
        help="Pull request number",
    )
    parser.add_argument(
        "--repo",
        required=True,
        help="Repository in format 'owner/repo'",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose output",
    )

    args = parser.parse_args()

    pr_title = fetch_pr_title(args.pr_number, args.repo)

    if args.verbose:
        print("Validating PR title...")
        print(f"Pattern: {args.pattern}")
        print(f"PR title: {pr_title}")
        print(f"Length: {len(pr_title)} characters\n")

    if not validate_title_length(pr_title, args.max_length):
        print(
            f"FAILED: PR title exceeds {args.max_length} characters "
            f"(length: {len(pr_title)})"
        )
        print(f"PR title: {pr_title}")
        sys.exit(1)

    if not validate_title_pattern(pr_title, args.pattern):
        print("FAILED: PR title does not match required pattern.")
        print(f"Expected pattern: {args.pattern}")
        print(f"PR title: {pr_title}")
        sys.exit(1)

    print("PASSED: PR title is valid!")


if __name__ == "__main__":
    main()
