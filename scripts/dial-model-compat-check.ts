import { AzureOpenAIModelProxy } from '../src/providers/plugins/azure-openai/azure-openai.models.js';
import { config } from 'dotenv';

config();

async function main() {
  const baseUrl = process.env.DIAL_BASE_URL || process.env.CODEMIE_AZURE_OPENAI_BASE_URL || '';
  const apiKey = process.env.DIAL_API_KEY || process.env.CODEMIE_AZURE_OPENAI_API_KEY || '';
  const apiVersion = process.env.DIAL_API_VERSION || '2024-06-01';
  if (!baseUrl || !apiKey) {
    console.error('[dial-model-compat-check] DIAL_BASE_URL and DIAL_API_KEY required in env');
    process.exit(2);
  }
  const proxy = new AzureOpenAIModelProxy(baseUrl, apiKey, apiVersion);
  const config = { baseUrl, apiKey, azureApiVersion: apiVersion };
  const models = await proxy.fetchModels(config);
  console.log(`Found ${models.length} deployments`);
  const results: Array<{ id: string; name: string; status: string; error?: string; latency?: number }> = [];
  for (const m of models) {
    const testPayload = {
      model: m.id,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16
    };
    const url = `${baseUrl}/openai/deployments/${encodeURIComponent(m.id)}/chat/completions?api-version=${apiVersion}`;
    const headers = {
      'api-key': apiKey,
      'Content-Type': 'application/json'
    };
    const t0 = Date.now();
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(testPayload) });
      const body = await resp.text();
      if (!resp.ok) {
        results.push({ id: m.id, name: m.name, status: 'FAIL', error: `HTTP ${resp.status}: ${body}` });
        console.error(`[${m.name}] FAIL: HTTP ${resp.status}: ${body}`);
      } else {
        const delta = Date.now() - t0;
        results.push({ id: m.id, name: m.name, status: 'OK', latency: delta });
        console.log(`[${m.name}] OK (${delta} ms)`);
      }
    } catch (e: any) {
      results.push({ id: m.id, name: m.name, status: 'ERROR', error: e?.message || String(e) });
      console.error(`[${m.name}] ERROR: ${e?.message || e}`);
    }
  }

  // Print summary table
  console.log('\n--- DIAL Model Compatibility Report ---');
  results.forEach(r => {
    let line = `${r.name.padEnd(26)} | ${r.status}`;
    if (r.latency) line += ` (${r.latency} ms)`;
    if (r.error) line += ` :: ${r.error.substring(0, 80)}`;
    console.log(line);
  });
}

main().catch(e => {
  console.error('[dial-model-compat-check] Fatal:', e);
  process.exit(1);
});
