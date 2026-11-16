# CodeMie providers — oh-my-pi extension

`index.js` is copied into `~/.codemie/omp/extensions/codemie-providers/` before every `codemie omp`
run and loaded with `omp -e <path>/index.js`. It reads the provider/model list the wrapper wrote for
this run (`CODEMIE_OMP_PROVIDERS` → JSON, built by Pi's `buildPiModelsConfig`) and calls
`pi.registerProvider` for each provider, so `--model codemie-proxy/<id>` resolves while the user's
own `~/.omp` stays untouched.

The same load-failure constraints as the run-ledger asset apply (node builtins only, everything
wrapped in `try/catch`, never throws, never logs) — see `../../pi/extension/README.md`.

`package.json` declares `"type": "module"` so the file loads as ESM wherever it is materialized.
