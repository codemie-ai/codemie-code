# EPMCDME-13925 — Adjust codemie-code release skill to include agent tests in the release process

**Link:** https://jiraeu.epam.com/browse/EPMCDME-13925
**Type:** Task
**Status:** Ready for dev
**Assignee:** Nikita Levyankov
**Epic:** EPMCDME-13286 — Developer Tooling & Agent Runtime

## Summary

Adjust the `codemie-code` release skill to include agent test execution as part of the release process.

## Description

The `codemie-code` release skill should be updated to include agent test execution as part of the release process. When the release skill is running, it should attempt to include the agent tests run step if technically possible. If agent tests cannot be run automatically because of restrictions related to how the agent runs tests, the release skill should clearly notify the user that agent tests must be run manually. In that case, the release process must not proceed until the user confirms that the agent tests were executed.

## Acceptance Criteria

- The `codemie-code` release skill includes an agent tests validation step in the release process.
- If automatic agent test execution is possible, the release skill runs the required agent tests.
- If automatic execution is restricted, the release skill clearly instructs the user to run agent tests manually.
- The release skill does not proceed until the user confirms that agent tests were run.
- The release process clearly communicates why the agent tests step is required.
- The updated release flow is documented in the skill instructions or release process notes.
- The release process cannot silently skip the agent tests validation step.
