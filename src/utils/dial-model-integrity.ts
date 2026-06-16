import { AzureOpenAIModelProxy } from '../providers/plugins/azure-openai/azure-openai.models.js';
import type { CodeMieConfigOptions } from './config.js';
import chalk from 'chalk';

function apiLabel(modelId: string) {
  const id = modelId.toLowerCase();
  if (id.startsWith('openai') || id.startsWith('gpt') || id.startsWith('tts-') || id.startsWith('audio-') || id.includes('embedding')) {
    return 'full api features';
  }
  return 'limited api features';
}

export async function runDialIntegrationTest(config: CodeMieConfigOptions): Promise<boolean> {
  const { baseUrl, apiKey, azureApiVersion = '2024-06-01' } = config;
  if (!baseUrl || !apiKey) {
    console.log(chalk.red('Missing DIAL baseUrl or apiKey.'));
    return false;
  }
  const proxy = new AzureOpenAIModelProxy(baseUrl, apiKey, azureApiVersion);
  let models;
  try {
    models = await proxy.fetchModels({ baseUrl, apiKey, azureApiVersion });
  } catch (err: any) {
    console.log(chalk.red('Failed to list DIAL models: ' + (err?.message || err)));
    return false;
  }
  if (!models || models.length === 0) {
    console.log(chalk.yellow('No DIAL models found.'));
    return false;
  }
  console.log(`\nFound ${models.length} models to test.\n`);
  let success = true;
  let stats = { full: 0, fullOk: 0, limited: 0, limitedOk: 0, errors: 0 };
  let idx = 0;

  for (const m of models) {
    idx++;
    const labelStr = apiLabel(m.id);
    const isLimited = labelStr === 'limited api features';
    if (isLimited) stats.limited++;
    else stats.full++;
    const payload = { model: m.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 };
    const url = `${baseUrl}/openai/deployments/${encodeURIComponent(m.id)}/chat/completions?api-version=${azureApiVersion}`;
    const headers = { 'api-key': apiKey, 'Content-Type': 'application/json' };
    const t0 = Date.now();
    let status = 'ok';
    let msg = '';
    let errLong = '';
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
      const body = await resp.text();
      if (resp.ok) {
        msg = chalk.green(`OK (${Date.now() - t0} ms)`);
        if (isLimited) stats.limitedOk++;
        else stats.fullOk++;
      } else {
        status = 'error';
        success = false;
        errLong = body;
        msg = chalk.red(`HTTP ${resp.status}`);
        stats.errors++;
      }
    } catch (e: any) {
      status = 'error';
      success = false;
      errLong = String(e?.message || e);
      msg = chalk.red('ERROR');
      stats.errors++;
    }
    const icon = status === 'ok' ? chalk.green('✓') : chalk.red('✗');
    const idxStr = chalk.gray(`[${idx}/${models.length}]`);
    const featureStr = chalk.gray(labelStr);
    const line = `${icon} ${idxStr} ${m.name} | ${featureStr} | ${msg}`;
    console.log(line);
    if (status === 'error' && errLong) {
      console.log(chalk.redBright('    Error details: ') + chalk.gray(errLong));
    }
  }
  // Summary finisher
  const statLine = `\n${chalk.gray('[full api features]')}: total ${stats.full}, OK: ${stats.fullOk}` +
                   chalk.gray(' | ') +
                   `${chalk.gray('[limited api features]')}: total ${stats.limited}, OK: ${stats.limitedOk}, errors: ${stats.errors}`;
  console.log(statLine);
  return success;
}
