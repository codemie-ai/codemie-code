---
# ❌ BAD COMMAND EXAMPLE
# Score: ~4/20 pts (Grade F)
#
# ❌ C1.1: Frontmatter missing description field
# ❌ C1.2: Uses $ARGUMENTS in body but no argument-hint in frontmatter
# ❌ C1.3: No phases or structured workflow — just a list of bullets
# ❌ C1.4: No usage examples section
# ❌ C2.1: No error handling for failures
# ❌ C2.2: No output format defined
# ❌ C2.3: No validation gates or confirmation step
# ❌ C2.4: $ARGUMENTS used but no parsing logic shown
name: jira
---

# Jira Ticket Creator

Create a jira ticket using this command. Just describe what you want and
the ticket will be created in Jira.

The command will figure out the type and priority automatically based on
what you write.

Make sure JIRA_TOKEN is set before using this.

Steps:
- Figure out what kind of ticket $ARGUMENTS is asking for
- Write a description
- Create the ticket
- Tell the user the ticket ID
