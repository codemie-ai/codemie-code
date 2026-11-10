// ESM loader hook: makes `import('keytar')` fail so the CLI falls back to its file credential store
// (under the temp CODEMIE_HOME) and never touches the real OS keychain / Windows Credential Vault.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'keytar') {
    return { url: 'data:text/javascript,throw new Error("keytar disabled by the live test suite");', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
