```json
[
  {"kind":"acceptance","item":"AC1: interactive assistants setup with a stale registered assistant completes, warns with name and id, unregisters on save","status":"pending-stage-7","notes":"Code path present (index.ts:106-113,173-176: warning via MESSAGES.SETUP.WARNING_STALE_ASSISTANT, stale id dropped from activeIds so applyChangesAndSave unregisters it); end-to-end run unproven"},
  {"kind":"acceptance","item":"AC2: fetchAssistantsByIds returns { found, missing }; 404 goes to missing, loop continues","status":"pass","notes":"data.ts try/catch on NotFoundError continues; result split into found/missing"},
  {"kind":"acceptance","item":"AC3: found and missing keep selectedIds order; ids in existingAssistants not fetched","status":"pass","notes":"Result built by iterating selectedIds; existingMap skip unchanged; tested with interleaved ids and not.toHaveBeenCalledWith('asst-1')"},
  {"kind":"acceptance","item":"AC4: non-404 rejection propagates unchanged","status":"pass","notes":"catch rethrows non-NotFoundError; test rejects.toThrow('boom')"},
  {"kind":"acceptance","item":"AC5: resolveMissingAssistants returns registered entries for missing registered ids, [] for empty missing","status":"pass","notes":"helpers.ts map over missing; unit tests added"},
  {"kind":"acceptance","item":"AC6: resolveMissingAssistants throws RegistrationItemNotFoundError naming the id for unregistered missing id","status":"pass","notes":"Throws RegistrationItemNotFoundError('assistant', id) for the first unregistered id; tested"},
  {"kind":"acceptance","item":"AC7: headless assistants behavior and tests unchanged","status":"pass","notes":"Diff does not touch setupAssistantsHeadless or headless tests"},
  {"kind":"acceptance","item":"AC8: assistants data.test.ts covers AC2-AC4 with NotFoundError; existing expectations updated; helper unit tests","status":"pass","notes":"Tests present in diff; passing them is Stage 7 evidence"},
  {"kind":"acceptance","item":"AC9: interactive skills setup with a stale registered skill completes, warns with name and id, unregisters on save","status":"pending-stage-7","notes":"Code path present (skills index.ts:156-164,182); end-to-end run unproven"},
  {"kind":"acceptance","item":"AC10: fetchSkillsByIds returns { found, missing }; 404 to missing, others fetched in parallel","status":"pass","notes":"Promise.all with per-id NotFoundError marker"},
  {"kind":"acceptance","item":"AC11: found/missing keep ids order; empty ids returns { found: [], missing: [] }","status":"pass","notes":"Split loop iterates ordered Promise.all results; empty early return updated; tested"},
  {"kind":"acceptance","item":"AC12: non-404 rejection or failed shape assertion propagates unchanged","status":"pass","notes":"assertApiListResponse error is not NotFoundError, so rethrown; non-404 test present"},
  {"kind":"acceptance","item":"AC13: resolveMissingSkills returns registered entries, [] for empty missing","status":"pass","notes":"helpers.ts sibling helper; new helpers.test.ts covers it"},
  {"kind":"acceptance","item":"AC14: resolveMissingSkills throws RegistrationItemNotFoundError naming the id","status":"pass","notes":"Throws RegistrationItemNotFoundError('skill', id); tested"},
  {"kind":"acceptance","item":"AC15: headless skills setup and headless.test.ts unchanged","status":"pass","notes":"Diff does not touch setupSkillsHeadless or headless.test.ts"},
  {"kind":"acceptance","item":"AC16: skills data.test.ts covers AC10-AC12; existing expectations updated; helper unit tests","status":"partial","notes":"404, ordering, empty and non-404 cases covered; no test for the failed response-shape assertion path of AC12"}
]
```

- **AC16 (partial):** `src/cli/commands/skills/setup/__tests__/data.test.ts` has no case where `client.skills.get` resolves a malformed payload and `assertApiListResponse` rejects. AC12's shape-assertion half has no test.
