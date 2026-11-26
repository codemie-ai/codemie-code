# EPMCDME-17853: show the effective model and mark a CODEMIE_MODEL override

## Intent

`codemie profile status` prints the stored profile model (`src/cli/commands/profile/index.ts:116-172`, `display.ts:130`), while a launch uses `CODEMIE_MODEL` from the shell or `<cwd>/.env` when it is set (`src/utils/config.ts:197-257`). So for the same active profile the banner and status show different models, and neither one says why. After this change both show the model a launch actually uses, both say when `CODEMIE_MODEL` replaced the profile model and where that value came from, and they word it the same way.

## Behaviour

- **The override.** `ConfigLoader` runs its layer merge once, in one internal resolve. Per key, that resolve keeps the value, the layer it came from, its env origin, and the value before the env layer. `load()` returns only the merged config, so its shape and its ~25 callers do not change. `loadWithSources()` and the override check both read the same result. So the profile-name and `--model` filters (`config.ts:214-257`) live in one place, and `--show-sources` can no longer read env before `.env` is loaded (today `:1594` runs before `:1648`). An override is in effect when the merged model came from the env layer and differs from the value before env.
- **Where the value came from.** There are three origins: `shell`, `dotenv`, `saved`. One dependency-free module owns the origin type, the two new variable names and their parser, like `src/utils/project-binding.ts:16-26`. The shared helper is the only place that maps an origin to text.
  - `dotenv`: `ConfigLoader` records each key and value that dotenv added to `process.env`. A key that was already present is not recorded, because dotenv never overwrites one (`config.ts:200`). So when the shell and `.env` both set the key, the shell wins. The "was it present" snapshot is taken in the same synchronous block as `dotenv.config`.
  - `saved`: `bin/codemie-copilot.js` records, in-process, the value it copies from its saved pick into `CODEMIE_MODEL` (`:90-96`). The record is not an environment variable, so a child process never inherits it.
  - Either record counts only while `process.env.CODEMIE_MODEL` still equals the recorded value. Both last for the process, and tests can reset them.
  - Any other non-empty `CODEMIE_MODEL` is `shell`, including a value inherited from a parent CodeMie session.
- **One format.** A shared helper builds the model text for status and banner, the same way `describeProjectBinding()` builds the Project text (`project-binding.ts:46-61`). It takes the effective model, the origin and the profile model:
  - `claude-opus-4-8[1m] (CODEMIE_MODEL from shell env overrides profile: claude-sonnet-5)`
  - `claude-opus-4-8[1m] (CODEMIE_MODEL from .env overrides profile: claude-sonnet-5)`
  - `claude-opus-4-8[1m] (your saved codemie-copilot --model pick, overrides profile: claude-sonnet-5)`. The user chose this model in a menu and never set the variable, so this marker does not name `CODEMIE_MODEL`.
  - With no origin, or with the model equal to the profile model, the text is just the model name.
  - An empty profile model shows `N/A`.
  - `renderProfileInfo()` (`src/utils/profile.ts:17-107`) does not change.
- **Plain `profile status`.** The Model row shows the helper's text. Status takes the effective model and the profile model from the merge's result (the pre-env value), never from `listProfiles()`, whose local profile replaces a global one of the same name as a whole record (`config.ts:1048-1059`). The text reaches `formatStatus` through `ProfileIdentityDisplay` (`display.ts:27-30`).
- **`profile status --show-sources`** labels a shell value `(env)` as today, and a `.env` value with a new `(.env)` label. This applies to every key it lists.
- **Config lookup in status.** `handleStatus` and `handleStatusWithSources` call `findNearestConfigDir(process.cwd())` the way the launcher does (`AgentCLI.ts:233-235`) and pass `configDir` and `envDir = process.cwd()` into `ConfigLoader`. `loadWithSources()` gains an optional `envDir`. `config.ts` does not import `event-fields/identity-fields.js`, which imports `ConfigLoader` (that would create an import cycle).
- **Launch.** `AgentCLI` sets `CODEMIE_MODEL_SOURCE='env'` only when the launch used the env model. Today it sets `'env'` whenever `CODEMIE_MODEL` is set (`AgentCLI.ts:440-444`). An env value equal to the profile model still counts as `'env'`. `AgentCLI` sets two more variables on every launch:
  - `CODEMIE_MODEL_ENV_ORIGIN` (`shell` | `dotenv` | `saved`) and `CODEMIE_PROFILE_MODEL` (the pre-env model) are filled whenever the source is `env`, and empty otherwise.
  - Both are decided from the launch env after `exportProviderEnvVars` (`AgentCLI.ts:411`). Both stay empty when the provider blanked `CODEMIE_MODEL` (`anthropic-subscription.template.ts:121-125`).
  - The banner (`BaseAgentAdapter.ts:635-659`) builds its model text from `CODEMIE_MODEL` and these two variables with the shared helper. Every agent that shows a banner gets the marker.

## Acceptance criteria

1. With the model from `CODEMIE_MODEL`, `codemie profile status` shows the effective model with the override marker and the profile model it replaced.
2. The marker says `CODEMIE_MODEL from shell env` or `CODEMIE_MODEL from .env`, matching where the value came from, or `your saved codemie-copilot --model pick` for a Copilot saved pick. When both are set, the shell wins. Inside an agent session, an inherited value reads `CODEMIE_MODEL from shell env`.
3. `codemie profile status --show-sources` labels a shell model `(env)` and a `.env` model `(.env)`.
4. When the launch uses an env model that differs from the profile model, the launch banner shows the same marker text as status. This includes a local profile laid over a global one of the same name.
5. (a) With no `CODEMIE_MODEL`, an empty one, or one equal to the profile model, status and banner show the same model in the same directory and neither shows a marker. (b) With `--profile` or `--model` given, or with a provider that blanks the model, the banner shows no marker.
6. `CODEMIE_MODEL_SOURCE` is `env` only when the launch used the env model. With `--profile` and `CODEMIE_MODEL` set, it is `default`.
7. Run from a repo subfolder, status reports the profile and model from the same `.codemie` the launcher uses.
8. Tests cover a shell override, a `.env` override and the no-override case. For each, they check the status model text, and the `CODEMIE_MODEL_SOURCE`, `CODEMIE_MODEL_ENV_ORIGIN` and `CODEMIE_PROFILE_MODEL` that `AgentCLI` passes to `run`, together with the helper's text for those values. They write real `.env` files in temp folders and save and restore `process.env`, following `src/agents/core/__tests__/project-parity.test.ts:77-107,399-411`. Setup clears ambient `CODEMIE_MODEL` and resets the origin records.
9. A `codemie-copilot` launch whose model came from its saved pick shows `<model> (your saved codemie-copilot --model pick, overrides profile: <profile model>)` in the banner. The text does not name `CODEMIE_MODEL`.

## Non-goals

- Printing the CLI version in `profile status` (ticket AC 5).
- Blocking inheritance of `CODEMIE_MODEL` into child processes of a managed session.
- Warning about unreadable (for example UTF-16) `.env` files.
- Override markers for other fields an env variable can override: provider, base URL, API key.
- Changing the values of `CODEMIE_MODEL_SOURCE` (`cli`/`env`/`default`) or its readers (`claude.models.ts`, `codex-models.ts`, `copilot-cli.models.ts`, `copilot-cli.plugin.ts`). `bin/codemie-copilot.js` changes only to record that it set `CODEMIE_MODEL` from its saved pick.
- Changing env-over-profile precedence, or dotenv's rule of not overwriting existing keys.
- Reading `.env.local` or a `.env` in a parent folder.
- Showing in the banner a model that Claude's `beforeRun` auto-heal picks later (`BaseAgentAdapter.ts:680`).
- Status reading the `codemie-copilot` saved-model file: status keeps showing the profile model for a saved pick.
- Status modelling a provider that hands the model choice to the agent (anthropic-subscription): status shows the configured model and marker; the banner shows `unknown`.
- A separate "CodeMie session" origin.

## Decisions

- Both outputs name the source (shell vs .env), not only status. Answers Q1. — user
- A second env variable carries the shell/.env detail, rather than new `CODEMIE_MODEL_SOURCE` values. Answers Q1. — user
- One shared helper builds the text for both outputs, rather than separate wording in each, and `renderProfileInfo()` stays unchanged. Answers Q1. — user
- `--show-sources` uses a new `(.env)` label for `.env` values and keeps `(env)` for the shell. Answers Q1. — user
- No marker when `CODEMIE_MODEL` equals the profile model, though it still counts as an explicit `env` source. Answers Q2. — user
- `CODEMIE_MODEL_SOURCE='env'` is recorded only when the env model was used, not whenever it is set. Answers Q3. — user
- Status finds the project config as the launcher does, rather than reading `<cwd>/.codemie`. `.env` is still read from cwd. Answers Q4. — user
- `ConfigLoader` records the keys `.env` added, rather than guessing the source from `process.env` later. The `load()` return shape stays unchanged. — user
- The codemie-copilot saved pick is its own origin, rather than being labelled shell env. — user, answers AR-1
- The saved-pick marker reads `your saved codemie-copilot --model pick, overrides profile: <profile model>`, rather than naming `CODEMIE_MODEL`, because the user chose the model in a menu. — user
- Status gets no Copilot saved-pick hint, rather than reading the saved-model file. — user
- A value inherited from a parent CodeMie session is labelled `from shell env`, rather than getting a session origin. — user, answers AR-1
- One internal merge is read by `load()`, `--show-sources` and the override check, rather than patching `loadWithSources()` by hand. — user, answers AR-2
- The profile model that was replaced reaches the banner in its own variable (`CODEMIE_PROFILE_MODEL`), rather than the banner resolving config again. This follows the banner's rule of never resolving config itself (`BaseAgentAdapter.ts:641`).
- The two new variables are set on every launch, filled when the source is `env` and empty otherwise, rather than left unset, so a nested launch cannot inherit a stale marker.
- The helper decides the marker from origin and model-versus-profile-model, rather than from `CODEMIE_PROFILE_MODEL` being non-empty, so a profile with no model still shows `N/A`.
- A profile with no model shows `N/A` in the marker, matching status's existing placeholder, rather than dropping the clause.
- Status takes the profile model from the merge's pre-env value, rather than from the profile list.
- The Copilot launcher records its injection in-process, rather than in an environment variable.
- An origin record counts only while `process.env` still holds the recorded value, rather than for the key's name alone.
- The new variables are decided after the provider's env export, rather than from `load()`'s result.
- The `(.env)` label applies to every key in `--show-sources`, not only the model, because the ordering fix affects every key the same way.
- The marker uses the row's normal colour, not a new colour, because `renderProfileInfo()` stays unchanged.

## Left to the plan

The names and signatures of the internal resolve, the origin records and the override check. The helper's module. The internal value of the `.env` source in `ConfigWithSource.source` (`src/env/types.ts:219-222`) and its colour in `getSourceColor()`. How `bin/codemie-copilot.js` reaches the record. The test files. Moving `findNearestConfigDir` into `src/utils/` is optional. The `--show-sources` label lists in `.ai-run/guides/usage/project-config.md:15` and `docs/CONFIGURATION.md` get `(.env)` added.

## Assumptions and risks

- `codemie profile status` run inside a managed session reports the inherited `CODEMIE_MODEL` as a shell override, even when the parent took it from `.env` or a Copilot saved pick. This is the decided behaviour: the variable really is in that terminal's environment.
- For a Copilot saved pick, status and banner still show different models, because status does not read the saved-model file. The banner now names the cause.
- Side effect of Q3: with `--profile`, Claude, Codex and Copilot now treat the profile model as an ordinary profile value, which their auto-heal may replace.
- Tests in `AgentCLI-model-source.test.ts` have failed before because of ambient `CODEMIE_MODEL` from the developer's session (see the earlier task notes cited in the analysis). New tests must clear it.
