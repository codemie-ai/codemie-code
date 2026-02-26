/**
 * SSL Bootstrap
 *
 * Shared SSL initialization that must run before any network calls.
 * Imported as the first static import in every CLI entry point.
 */

// Immediate env-var check — runs synchronously before other module code
if (process.env.CODEMIE_SSL_NO_VERIFY === 'true' || process.env.CODEMIE_SSL_NO_VERIFY === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// Full SSL init: env vars + Windows cert store
// Profile-based sslVerify is handled later in AgentCLI.handleRun() after config load
try {
  const { initSSL } = await import('../dist/utils/ssl.js');
  await initSSL();
} catch (err) {
  // Expected during development (dist/ not built yet) — skip silently
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') {
    console.error('[SSL] Initialization failed:', err?.message ?? err);
  }
}
