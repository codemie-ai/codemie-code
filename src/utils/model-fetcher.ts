import https from 'https';
import http from 'http';
import { URL } from 'url';
import { CodeMieConfigOptions } from './config-loader.js';
import { logger } from './logger.js';
import { fetchCodeMieModelsFromConfig } from './codemie-model-fetcher.js';

/**
 * Model information from provider API
 */
interface ModelInfo {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

interface ModelsResponse {
  object: string;
  data: ModelInfo[];
}

/**
 * Cache for fetched models to avoid repeated API calls
 */
const modelCache = new Map<string, { models: string[]; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch available models from provider API
 */
export async function fetchAvailableModels(config: CodeMieConfigOptions): Promise<string[]> {
  // Handle ai-run-sso provider
  if (config.provider === 'ai-run-sso') {
    try {
      return await fetchCodeMieModelsFromConfig();
    } catch (error) {
      logger.debug(`Failed to fetch CodeMie models: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  // Check cache first for other providers
  const cacheKey = `${config.baseUrl}:${config.provider}`;
  const cached = modelCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.models;
  }

  try {
    const models = await fetchModelsFromAPI(config);

    // Cache the results
    modelCache.set(cacheKey, {
      models,
      timestamp: Date.now()
    });

    return models;
  } catch (error) {
    logger.debug(`Failed to fetch models: ${error instanceof Error ? error.message : String(error)}`);
    // Return empty array on error - caller will use fallback
    return [];
  }
}

/**
 * Make HTTP request to /v1/models endpoint
 */
async function fetchModelsFromAPI(config: CodeMieConfigOptions): Promise<string[]> {
  if (!config.baseUrl) {
    throw new Error('Base URL not configured');
  }

  // Ensure baseUrl ends with / for proper path joining
  const normalizedBase = config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/';
  const url = new URL('v1/models', normalizedBase);
  const isHttps = url.protocol === 'https:';
  const client = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 5000 // 5 second timeout
    };

    const req = client.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }

          const response: ModelsResponse = JSON.parse(data);

          if (!response.data || !Array.isArray(response.data)) {
            reject(new Error('Invalid response format'));
            return;
          }

          const modelIds = response.data
            .filter(m => m.id) // Ensure model has an ID
            .map(m => m.id)
            .sort(); // Sort alphabetically

          resolve(modelIds);
        } catch (error) {
          reject(new Error(`Failed to parse response: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

/**
 * Filter models based on agent compatibility rules
 */
export function filterModelsByAgent(
  models: string[],
  agentName: string,
  blockedPatterns: RegExp[]
): string[] {
  if (blockedPatterns.length === 0) {
    // No restrictions - return all models
    return models;
  }

  // Filter out blocked models
  return models.filter(model => {
    return !blockedPatterns.some(pattern => pattern.test(model));
  });
}

/**
 * Categorize models into recommended and other
 */
export function categorizeModels(models: string[]): {
  recommended: string[];
  other: string[];
} {
  // Patterns for recommended models (latest versions)
  const recommendedPatterns = [
    /^gpt-5/i,
    /^gpt-4\.1/i,
    /^claude-4-5/i,
  ];

  const recommended: string[] = [];
  const other: string[] = [];

  for (const model of models) {
    if (recommendedPatterns.some(pattern => pattern.test(model))) {
      recommended.push(model);
    } else {
      other.push(model);
    }
  }

  return { recommended, other };
}

/**
 * Clear the model cache (useful for testing or forcing refresh)
 */
export function clearModelCache(): void {
  modelCache.clear();
}
