#!/usr/bin/env node

import { CodeMieSSO } from "@/providers/plugins/sso/sso.auth.js";

const codeMieUrl = process.argv[2];

if (!codeMieUrl) {
  process.exit(1);
}

await new CodeMieSSO().authenticate({ codeMieUrl, timeout: 120_000 });

process.exit(0);
