# Deferred from code review — 2026-08-11-epmcdme-14072-extend-the-codemie-cli-s-managed-mcp (2026-08-11)

Real findings, each confirmed reachable by the batched verifier, held back because they are
pre-existing rather than introduced by this change. Worth a follow-up ticket.

- **Partial validation failure revokes the dropped entries** — `src/cli/commands/proxy/connectors/managed-mcp-remote.ts:158-170` — when only *some* backend entries fail validation, the fetch returns a non-null subset, so `orgFetchSucceeded` is true, `previouslyManagedNames` is read, and a previously-managed entry that failed validation this run is deleted from the user's Desktop config even though the org still publishes it. Verifier confirmed by simulation. Pre-existing: the spec's error-handling table deliberately specifies "some entries invalid, some valid → valid subset returned, invalid dropped"; the new all-or-nothing guard (§7) was scoped to the total-failure case only, so the smaller-scale version of the same hazard predates and outlives this change.

- **URL collision is unnormalized, allowing double registration** — `src/cli/commands/proxy/connectors/desktop.ts:556-559` — names are compared case-insensitively but URLs are compared as exact strings, so a backend URL differing from a bundled default only by a trailing slash or host case matches neither predicate. Verifier simulation writes both `{name:'Notion', url:'https://mcp.notion.com/mcp', oauth:true}` and `{name:'notion-internal', url:'https://mcp.notion.com/mcp/', oauth:false}` — the same endpoint registered twice with conflicting auth. Especially likely against the slash-less defaults (`https://mcp.box.com`, `https://mcp.vercel.com`, `https://mcp.miro.com`). Pre-existing: the removed `orgDeduped` filter compared URLs exactly too, so a trailing-slash variant escaped suppression before the flip as well.

  **Consequence recorded at Stage 6, round 5.** Both review lenses independently pointed out a second
  effect of this same gap: a backend entry at a URL variant of a default's endpoint displaces that
  default *by name* while escaping the endpoint-scoped downgrade report, so a genuine same-endpoint
  auth downgrade goes unwarned. Fixing that by normalizing URLs was considered and rejected for this
  task — normalization changes which entries displace which, which touches AC5 and contradicts spec
  §5's "URL comparison stays case-sensitive, matching the existing convention". The residual harm was
  reduced instead of eliminated: `displacedDefaults` / `displacedDefaultCount` on the write-time info
  record now name every bundled default that disappeared, whichever arm of the collision test dropped
  it, so the case is reported rather than silent. **When this finding is picked up, the right fix is
  one normalizing comparison inside `sameManagedEndpoint` — comparison only, never changing the URL
  that gets written — which closes the double-registration case and the unwarned-downgrade case
  together.**

- **`authorizationUrl` / `tokenUrl` accepted as any non-empty string** — `src/cli/commands/proxy/connectors/managed-mcp-remote.ts:41-43, 54-55` — no `new URL()` parse, no scheme allowlist, no https requirement, so `javascript:…`, `http://…` or a non-URL string reaches the written Desktop config and drives a real authorization flow. Pre-existing trust model, and consistent with it: the verifier found the sibling `url` field (the MCP server endpoint itself) is validated *more* weakly still — `typeof e.url === 'string'` at line 70, which does not even reject the empty string. Hardening only the OAuth URLs would be inconsistent; the whole catalog-trust boundary deserves one deliberate pass.

- **`callbackHost` is not restricted to loopback** — `src/cli/commands/proxy/connectors/managed-mcp-remote.ts:57` — type-checked as a string only, while the paired `callbackPort` gets a full integer + 1..65535 range check. A non-loopback value survives validation and reaches the written config. Mitigating context: under resolved decision 1 the CLI never runs the OAuth flow — Claude Desktop does — so whether the host is honoured is outside this codebase. Pre-existing: the spec defined the gate as non-empty strings plus optional type checks.

- **CR-009 — `reconcileManagedMcpServers` maps an unreadable stored list to `[]`** —
  `src/cli/commands/proxy/connectors/desktop.ts:526` — adjudicated at Stage 6 and moved here. The
  blind lens read the asymmetry with `selectDefaultsForFailedFetch` (which seeds nothing when the
  stored value is unreadable) as new data loss; the acceptance lens read it as neutral. The
  acceptance reading is the correct one, on two grounds. First, it is **pre-existing**: `parseJsonArray`
  behaved identically before this branch, and the reconcile path's use of it is unchanged. Second,
  the asymmetry is **intentional and each half is the conservative answer to its own question** —
  `selectDefaultsForFailedFetch` asks "which names and URLs are already claimed?", where *unknown*
  must mean "assume all of them"; `reconcileManagedMcpServers` asks "which existing entries must be
  preserved?", where an unreadable value yields no identifiable entries, and a non-array value cannot
  be written back into a field Claude Desktop reads as an array. The disputed sub-case — a stored
  value that is decodable JSON but not an array — has no recoverable content for that reason. A
  comment at the call site now records this so a fourth review round does not re-raise it. Worth a
  follow-up ticket only if a future Desktop release starts storing a non-array shape there.

- **Org catalog is never deduped against itself** — `src/cli/commands/proxy/connectors/desktop.ts:561` — `managedSet` spreads the whole org array with no self-comparison, and `reconcileManagedMcpServers` re-spreads all of `managed` unfiltered (desktop.ts:389), so two backend rows sharing a name or URL are both written, with the duplicate carried into `managedNames` in the marker state. Pre-existing: the removed `orgDeduped` filter only tested each org row against the bundled defaults, never against sibling org rows.
