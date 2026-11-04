# Pages for codemie-analytics

Read this only when the codemie-analytics skill invoked this one. Everything in SKILL.md still
holds; this adds the contract its scripts depend on.

- Every JS variable that holds data from an API response is a placeholder, never inline values:
  `const LEADERBOARD = /*__DATA:leaderboard-top__*/;`. The name is the JSON file's name without
  `.json`. A wrong name is skipped silently, and the page renders with no data.
- Never mix a placeholder and inline values in one declaration. Lookup tables you write yourself
  (tier colours, dimension labels) stay ordinary JS.
- The style placeholder is still `/* __CODEMIE_CSS__ */`, whatever the calling skill calls it.
- Order: write the page source; fill it with `scripts/inject-data.mjs` in this skill's folder (the
  folder SKILL.md gives), as `node <this skill's folder>/scripts/inject-data.mjs page.src.html
  <data-dir>`, where `<data-dir>` is the
  folder of JSON files codemie-analytics saved; then build it with `scripts/build.mjs`, so the
  build and its checks see the finished page. A value that holds `</script>` cannot break out of
  its script: the injection escapes it.
- Text that a script writes at run time is invisible to the slop scan. Keep the title, headings,
  card titles and stat labels in the HTML; let scripts fill only the values.
- The numbers come from the injected files, so the claim ledger checks against them: state the
  period and base the API returned, and add no trend or comparison the files do not contain.
