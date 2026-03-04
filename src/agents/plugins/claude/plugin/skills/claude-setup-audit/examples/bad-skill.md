---
# ❌ BAD SKILL EXAMPLE
# Score: ~8/32 pts (Grade F)
# What's wrong: See inline comments marked ❌
#
# ❌ S1.2: Name "Git Helper" has uppercase and space (should be git-helper)
# ❌ S1.3: Description uses second person ("Use this skill"), vague, no trigger phrases
# ❌ S1.4: No allowed-tools field — no tool restriction
# ❌ S2.1: No methodology or structured workflow
# ❌ S2.2: No output format defined
# ❌ S2.3: No concrete examples
# ❌ S2.4: No actionable checklists
# ❌ S3.1: Hardcoded absolute path /Users/developer/projects
# ❌ S4.1: Multi-purpose (commits AND branches AND rebasing AND PRs)
# ❌ S4.2: No "When to use" or trigger conditions
# ❌ Writing style: second person throughout ("you can", "you should")
---
name: Git Helper
description: Use this skill when you need to do git things like commits and
  pushing code and other git operations.

---

# Git Helper Skill

This skill helps you with git. You can use it for commits, pushes, branches,
and various git operations when working on your projects.

When you need to do git things, this skill will help you do them correctly.
It works with any git repository on your machine.

Instructions:
- Do git status first to see what files you have
- Then you should stage the files you want to commit
- Try to write a good commit message
- Be careful with the commit message format
- You should also check what files are staged
- Make sure everything looks good before committing
- Don't forget to push when you're done

For branches: you can create new branches when needed. Try to use descriptive
names. You should merge or rebase depending on the situation.

Working directory note: this skill assumes you're working in
/Users/developer/projects as the base path for all repositories.

Note: This skill also handles pull requests, rebasing, cherry-picking,
stash management, and GitHub integration.
