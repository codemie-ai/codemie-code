/**
 * MCP Auth Proxy — outbound HTTP client.
 *
 * Streaming forward for the MCP pass-through (no buffering, abort propagation) plus a
 * small buffered fetchJson for OAuth metadata discovery. Honors HTTP(S)_PROXY env like
 * the SSO proxy's outbound client. TLS verification is intentionally ON: this client
 * relays OAuth traffic to the enterprise IdP.
 */
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { logger } from '../../utils/logger.js';
import type { JsonObject } from './types.js';

const FETCH_JSON_TIMEOUT_MS = 5000;
const FETCH_JSON_MAX_BYTES = 256 * 1024;

function getProxyEnvUrl(protocol: string): string | undefined {
  if (protocol === 'https:') {
    return (
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy
    );
  }
  return process.env.HTTP_PROXY || process.env.http_proxy;
}

export interface BeginOptions {
  method: string;
  headers: http.OutgoingHttpHeaders;
  /** Streaming request body (MCP pass-through). Mutually exclusive with `body`. */
  bodyStream?: Readable;
  /** Buffered request body (rewritten OAuth payloads). */
  body?: Buffer;
}

export interface UpstreamExchange {
  request: http.ClientRequest;
  response: Promise<http.IncomingMessage>;
}

export class UpstreamClient {
  private readonly httpsAgent: https.Agent;
  private readonly httpAgent: http.Agent;

  constructor() {
    const agentOptions = { keepAlive: true, maxSockets: 50 };
    const httpsProxyUrl = getProxyEnvUrl('https:');
    const httpProxyUrl = getProxyEnvUrl('http:');
    this.httpsAgent = httpsProxyUrl
      ? new HttpsProxyAgent(httpsProxyUrl, agentOptions)
      : new https.Agent(agentOptions);
    this.httpAgent = httpProxyUrl
      ? new HttpProxyAgent(httpProxyUrl, agentOptions)
      : new http.Agent(agentOptions);
    if (httpsProxyUrl || httpProxyUrl) {
      logger.debug('[mcp-auth-proxy] Using corporate proxy from environment for upstream calls');
    }
  }

  /**
   * Open an upstream request. `response` rejects on network errors; callers destroy
   * `request` to propagate client aborts. Timeout 0 — MCP SSE streams are long-lived.
   */
  begin(url: URL, options: BeginOptions): UpstreamExchange {
    const isHttps = url.protocol === 'https:';
    const protocol = isHttps ? https : http;
    const agent = isHttps ? this.httpsAgent : this.httpAgent;

    let request!: http.ClientRequest;
    const response = new Promise<http.IncomingMessage>((resolve, reject) => {
      request = protocol.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: options.method,
          headers: options.headers,
          agent,
          timeout: 0,
        },
        resolve
      );
      request.on('error', reject);
    });

    if (options.bodyStream) {
      pipeline(options.bodyStream, request).catch((error: unknown) => {
        request.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    } else if (options.body !== undefined) {
      request.end(options.body);
    } else {
      request.end();
    }

    return { request, response };
  }

  /** Buffered GET returning parsed JSON. Non-2xx, oversized, or non-object → throws. */
  async fetchJson(url: string): Promise<JsonObject> {
    const target = new URL(url);
    const { request, response } = this.begin(target, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const timer = setTimeout(
      () => request.destroy(new Error(`Timed out fetching metadata from ${target.host}`)),
      FETCH_JSON_TIMEOUT_MS
    );
    try {
      const res = await response;
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        throw new Error(`GET ${target.host}${target.pathname} returned ${status}`);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res) {
        const buf = Buffer.from(chunk as Buffer);
        size += buf.length;
        if (size > FETCH_JSON_MAX_BYTES) {
          res.destroy();
          throw new Error(`Metadata document from ${target.host} exceeds ${FETCH_JSON_MAX_BYTES} bytes`);
        }
        chunks.push(buf);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Metadata document from ${target.host} is not a JSON object`);
      }
      return parsed as JsonObject;
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
  }
}
