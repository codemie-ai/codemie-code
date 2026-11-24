DONE
Commit: 323a5c25
Changed: docs/SHELL-COMPLETIONS.md (new), README.md, docs/COMMANDS.md, .github/workflows/ci.yml
Notes: measured `time node bin/codemie.js completion bash` ~0.68s wall; documented as "roughly 0.7 s". CI: GitHub runners already set CI=true, so only added an apt-get install zsh fish step in test-ubuntu. README docs list got a link.
