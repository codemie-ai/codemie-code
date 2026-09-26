#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ConfigLoader } from "@/utils/config.js";
import { ProviderRegistry } from "@/providers/core/registry.js";
import {
  getReauthLock,
  isProcessAlive,
  setReauthLock,
  clearReauthLock,
} from "@/utils/reauth-lock.js";

async function checkAuth(): Promise<void> {
  const workingDir = process.cwd();
  const config = await ConfigLoader.load(workingDir);

  const setupSteps = config.provider
    ? ProviderRegistry.getSetupSteps(config.provider)
    : null;

  if (!setupSteps?.validateAuth) {
    process.exit(0);
  }

  const result = await setupSteps.validateAuth(config);

  if (result.valid) {
    await clearReauthLock();
    process.exit(0);
  }

  const ssoUrl = config.codeMieUrl || config.baseUrl;
  const isSsoProvider = config.provider === "ai-run-sso";

  if (!isSsoProvider || !ssoUrl) {
    console.error("Auth validation failed. Please check setup.");
    process.exit(2);
  }

  try {
    const lock = await getReauthLock();
    const loginInFlight = lock ? isProcessAlive(lock.pid) : false;

    if (!loginInFlight) {
      const runnerPath = fileURLToPath(
        new URL("./reauth-login-runner.js", import.meta.url)
      );
      const child = spawn(process.execPath, [runnerPath, ssoUrl], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      if (child.pid) {
        await setReauthLock(child.pid);
      }
    }
  } catch (error) {
    console.error(
      `Failed to spawn re-authentication process: ${(error as Error).message}`
    );
  }

  console.error(
    [
      "CodeMie SSO authentication is invalid - you are blocked until you re-authenticate.",
      "A browser sign-in window has been opened automatically.",
      "Complete the sign-in, then re-send your prompt.",
    ].join("\n")
  );
  process.exit(2);
}

checkAuth().catch((error) => {
  console.error(`Hook encountered an unhandled error: ${(error as Error).message}`);
  process.exit(0);
});
