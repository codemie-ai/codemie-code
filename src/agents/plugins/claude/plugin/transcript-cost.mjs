export function priceFromGatewayCost(cost) {
  if (cost?.input == null) {
    return null;
  }
  const input = cost.input * 1_000_000;
  const output = (cost.output ?? 0) * 1_000_000;
  const cacheRead =
    cost.cache_read_input_token_cost != null
      ? cost.cache_read_input_token_cost * 1_000_000
      : input * 0.1;
  const cacheCreation =
    cost.cache_creation_input_token_cost != null
      ? cost.cache_creation_input_token_cost * 1_000_000
      : input * 1.25;
  return { input, output, cacheRead, cacheCreation, cacheWrite1h: input * 2 };
}

/** Key models identically on both sides of the price map: lowercased, dots folded to dashes. */
export function normalizeModelKey(model) {
  return String(model || "")
    .toLowerCase()
    .replace(/\./g, "-");
}

/**
 * Rates for `model` from `gatewayPrices`, or null when the tenant's gateway does not list it
 * (caller treats the model as unpriced).
 */
export function lookupPrice(model, gatewayPrices) {
  return gatewayPrices?.[normalizeModelKey(model)] ?? null;
}

/** USD for one model's usage. Rates are per 1,000,000 tokens. */
function costForUsage(usage, price) {
  const tokens1h = Math.min(usage.cacheCreation1h, usage.cacheCreation);
  const tokens5m = usage.cacheCreation - tokens1h;
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      tokens1h * price.cacheWrite1h +
      tokens5m * price.cacheCreation) /
    1_000_000
  );
}

/**
 * Usage per model, counting each API response once. Claude Code writes one response across
 * several JSONL rows (`thinking` + `text`, or `text` + `tool_use`) that each repeat the full
 * usage, so rows are keyed by `message.id` + `requestId` and the most complete row wins.
 */
export function sumTranscriptUsage(text) {
  const byKey = new Map();
  const unkeyed = [];
  for (const line of String(text).split("\n")) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const u = row?.message?.usage;
    if (!u) continue;
    const model = row.message.model;
    if (!model || model === "<synthetic>") continue;
    const usage = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
      cacheCreation1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    };
    const weight =
      usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
    const id = row.message.id;
    const reqId = row.requestId;
    if (!id && !reqId) {
      unkeyed.push({ model, usage });
      continue;
    }
    const key = `${id ?? ""}::${reqId ?? ""}`;
    const current = byKey.get(key);
    if (!current || weight > current.weight) {
      byKey.set(key, { model, usage, weight });
    }
  }

  const byModel = new Map();
  for (const { model, usage } of [...byKey.values(), ...unkeyed]) {
    const acc = byModel.get(model);
    if (!acc) {
      byModel.set(model, { ...usage });
      continue;
    }
    acc.input += usage.input;
    acc.output += usage.output;
    acc.cacheRead += usage.cacheRead;
    acc.cacheCreation += usage.cacheCreation;
    acc.cacheCreation1h += usage.cacheCreation1h;
  }
  return byModel;
}

/**
 * Session cost in USD, or null when no usage row prices against `gatewayPrices` so the caller
 * can fall back rather than render $0.
 */
export function transcriptCostUSD(text, gatewayPrices) {
  let total = 0;
  let priced = false;
  for (const [model, usage] of sumTranscriptUsage(text)) {
    const price = lookupPrice(model, gatewayPrices);
    if (!price) continue;
    priced = true;
    total += costForUsage(usage, price);
  }
  return priced ? total : null;
}
