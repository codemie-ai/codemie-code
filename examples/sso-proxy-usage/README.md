# CodeMie SSO Proxy - Usage Example

This example demonstrates how to integrate **SSO authentication** and **HTTP proxy functionality** from the `@codemieai/code` package into your own Node.js applications.

## 📋 Features

This example showcases:

- ✅ **SSO Authentication**: Browser-based SSO authentication with credential storage
- ✅ **HTTP Proxy Server**: Plugin-based proxy with zero-buffering streaming
- ✅ **Request Logging**: Comprehensive request/response logging
- ✅ **Metrics Collection**: Automatic usage metrics tracking and syncing
- ✅ **Profile Management**: Create and manage CodeMie profiles programmatically
- ✅ **Session Tracking**: Track all requests by session ID

## 🚀 Quick Start

### Prerequisites

- Node.js >= 20.0.0
- npm
- Access to CodeMie SSO endpoint (default: `https://codemie.lab.epam.com`)

### Installation

#### Using Local Package (Development)

This example uses a local build of `@codemieai/code` for development/testing:

1. **Build the main project and create package:**

   ```bash
   # From the root of codemie-code project
   npm pack
   ```

   This creates `codemieai-code-0.0.31.tgz` in the root directory.

2. **Navigate to the example directory:**

   ```bash
   cd examples/sso-proxy-usage
   ```

3. **Install dependencies:**

   ```bash
   npm install
   ```

   The package.json references the local .tgz file:
   ```json
   {
     "dependencies": {
       "@codemieai/code": "file:../../codemieai-code-0.0.31.tgz"
     }
   }
   ```

#### Using Published Package

Once `@codemieai/code` is published to npm, update `package.json`:

```json
{
  "dependencies": {
    "@codemieai/code": "^0.0.31"
  }
}
```

4. **Configure environment (optional):**

   Copy `.env.example` to `.env` and modify if needed:

   ```bash
   cp .env.example .env
   ```

   Default configuration:
   - `CODEMIE_SSO_URL=https://codemie.lab.epam.com`
   - `PROXY_PORT=0` (auto-assign)
   - `PROXY_TIMEOUT=300000` (5 minutes)
   - `CODEMIE_DEBUG=0` (disabled)

### Running the Example

```bash
npm start
```

### Expected Output

```
🚀 CodeMie SSO Proxy Example

════════════════════════════════════════════════════════════

📝 Step 1: SSO Authentication
────────────────────────────────────────────────────────────
🔐 Starting SSO authentication...
   SSO URL: https://codemie.lab.epam.com
   A browser window will open for authentication.

Opening browser for authentication...
✅ SSO authentication successful!
   API URL: https://codemie.lab.epam.com/code-assistant-api

📝 Step 2: Profile Configuration
────────────────────────────────────────────────────────────
✅ Profile 'plugin-sso' created/updated
   Provider: ai-run-sso
   API URL: https://codemie.lab.epam.com/code-assistant-api
   Model: claude-3-5-sonnet-20241022

📝 Step 3: Starting Proxy Server
────────────────────────────────────────────────────────────
✅ Proxy server started successfully!
   URL: http://localhost:54321
   Port: 54321
   Target API: https://codemie.lab.epam.com/code-assistant-api

💡 All requests to this proxy will be forwarded to the CodeMie backend
   with SSO authentication and metrics collection enabled.

📝 Step 4: Testing Proxy (Making Sample Requests)
────────────────────────────────────────────────────────────

🧪 Making test requests through the proxy...

Test 1: Fetching configuration...
✅ Config fetched: window.REACT_APP_CONFIG = {...

Test 2: Fetching available models...
✅ Models fetched: {"models":[...

💡 All requests were:
   • Authenticated with SSO cookies
   • Logged to debug files
   • Tracked for metrics collection
   • Forwarded through the proxy to the backend

📝 Step 5: Proxy Running
────────────────────────────────────────────────────────────
✅ Proxy is now running and ready to handle requests
   Press Ctrl+C to stop the proxy and exit

📊 Features active:
   • SSO Authentication: Cookies injected automatically
   • Request Logging: All requests logged to ~/.codemie/logs/
   • Metrics Collection: Usage metrics collected and synced
   • Session Tracking: All requests tracked by session ID
```

## 📖 Code Walkthrough

### 1. Import Required Modules

```javascript
import { CodeMieSSO, CodeMieProxy, ConfigLoader, logger } from '@codemieai/code';
```

### 2. Authenticate with SSO

```javascript
const sso = new CodeMieSSO();

// Check for stored credentials
let credentials = await sso.getStoredCredentials(SSO_URL);

if (!credentials) {
  // Authenticate via browser
  const authResult = await sso.authenticate({
    codeMieUrl: SSO_URL,
    timeout: 120000
  });

  credentials = await sso.getStoredCredentials(SSO_URL);
}
```

### 3. Create Profile

```javascript
const profile = {
  name: 'plugin-sso',
  provider: 'ai-run-sso',
  baseUrl: credentials.apiUrl,
  codeMieUrl: SSO_URL,
  authMethod: 'sso',
  model: 'claude-3-5-sonnet-20241022',
  timeout: 300000
};

await ConfigLoader.saveProfile('plugin-sso', profile);
```

### 4. Start Proxy Server

```javascript
const proxyConfig = {
  targetApiUrl: credentials.apiUrl,
  port: 0, // auto-assign
  provider: 'ai-run-sso',
  clientType: 'external-app',
  sessionId: generateSessionId(),
  timeout: 300000,
  profile: 'plugin-sso',
  profileConfig: profile
};

const proxy = new CodeMieProxy(proxyConfig);
const { port, url } = await proxy.start();

console.log(`Proxy running at: ${url}`);
```

### 5. Make Requests Through Proxy

```javascript
// All requests through the proxy are automatically:
// - Authenticated with SSO cookies
// - Logged for debugging
// - Tracked for metrics collection

const response = await fetch(`${url}/v1/models`);
const data = await response.json();
```

### 6. Stop Proxy (Cleanup)

```javascript
await proxy.stop();
```

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEMIE_SSO_URL` | `https://codemie.lab.epam.com` | SSO provider URL |
| `PROXY_PORT` | `0` (auto-assign) | Port for proxy server |
| `PROXY_TIMEOUT` | `300000` (5 min) | Request timeout in milliseconds |
| `CODEMIE_DEBUG` | `0` | Enable debug logging (0=off, 1=on) |

### Proxy Configuration Options

```javascript
{
  targetApiUrl: string,      // Backend API URL (from SSO)
  port?: number,             // Proxy port (0 = auto-assign)
  provider?: string,         // Provider name (e.g., 'ai-run-sso')
  clientType?: string,       // Client identifier
  sessionId?: string,        // Unique session ID
  timeout?: number,          // Request timeout in ms
  profile?: string,          // Profile name
  model?: string,            // Model name
  version?: string,          // Client version
  profileConfig?: object     // Full profile configuration
}
```

## 📊 Proxy Features

### Automatic Plugin System

The proxy automatically enables the following plugins:

1. **EndpointBlockerPlugin** (Priority 5)
   - Blocks unwanted endpoints (e.g., telemetry)

2. **SSOAuthPlugin** (Priority 10)
   - Injects SSO cookies into all requests

3. **HeaderInjectionPlugin** (Priority 20)
   - Adds custom headers (X-CodeMie-*)

4. **LoggingPlugin** (Priority 50)
   - Comprehensive request/response logging
   - Logs to `~/.codemie/logs/debug-YYYY-MM-DD.log`

5. **SSOSessionSyncPlugin** (Priority 100)
   - Collects usage metrics
   - Syncs to backend every 2 minutes
   - Final sync on proxy shutdown

### Request Flow

```
Client Request
    ↓
[EndpointBlockerPlugin] → Check if blocked
    ↓
[SSOAuthPlugin] → Inject SSO cookies
    ↓
[HeaderInjectionPlugin] → Add custom headers
    ↓
Forward to Backend (with streaming)
    ↓
[LoggingPlugin] → Log request/response
    ↓
[SSOSessionSyncPlugin] → Collect metrics
    ↓
Client Response
```

## 🧪 Testing

### Test Requests

The example includes sample test requests:

```javascript
// Test 1: Config endpoint
const config = await fetch(`${proxyUrl}/config.js`);

// Test 2: Models endpoint
const models = await fetch(`${proxyUrl}/v1/models`);
```

### Integration with Your App

```javascript
// Use the proxy URL for all API calls
const PROXY_URL = 'http://localhost:54321';

// Example: Chat completion
const response = await fetch(`${PROXY_URL}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'claude-3-5-sonnet-20241022',
    messages: [{ role: 'user', content: 'Hello!' }],
    stream: true
  })
});
```

## 📁 File Structure

```
examples/sso-proxy-usage/
├── package.json      # Dependencies and scripts
├── .env              # Environment configuration
├── .env.example      # Example environment file
├── index.js          # Main application code
└── README.md         # This file
```

## 🔍 Debugging

### Enable Debug Logging

Set `CODEMIE_DEBUG=1` in `.env`:

```bash
CODEMIE_DEBUG=1
```

Debug logs are written to:
- `~/.codemie/logs/debug-YYYY-MM-DD.log`

### View Logs in Real-Time

```bash
tail -f ~/.codemie/logs/debug-$(date +%Y-%m-%d).log
```

### Common Issues

**Issue: SSO authentication timeout**
- Solution: Check SSO URL is accessible
- Solution: Increase timeout in `.env`

**Issue: Proxy port already in use**
- Solution: Set `PROXY_PORT=0` for auto-assign
- Solution: Specify different port in `.env`

**Issue: Credentials expired**
- Solution: Delete stored credentials and re-authenticate:
  ```bash
  rm ~/.codemie/credentials/*
  ```

## 📚 API Reference

### CodeMieSSO

```javascript
import { CodeMieSSO } from '@codemieai/code';

const sso = new CodeMieSSO();

// Authenticate
await sso.authenticate({ codeMieUrl, timeout });

// Get stored credentials
await sso.getStoredCredentials(baseUrl);

// Clear credentials
await sso.clearStoredCredentials(baseUrl);
```

### CodeMieProxy

```javascript
import { CodeMieProxy } from '@codemieai/code';

const proxy = new CodeMieProxy(config);

// Start proxy
const { port, url } = await proxy.start();

// Stop proxy
await proxy.stop();
```

### ConfigLoader

```javascript
import { ConfigLoader } from '@codemieai/code';

// Save profile
await ConfigLoader.saveProfile(name, profile);

// Get profile
const profile = await ConfigLoader.getProfile(name);

// List profiles
const profiles = await ConfigLoader.listProfiles();

// Delete profile
await ConfigLoader.deleteProfile(name);
```

## 🎯 Use Cases

This example can be adapted for:

- **Custom AI Agents**: Build your own AI agent with SSO authentication
- **API Gateways**: Add SSO authentication to existing APIs
- **Monitoring Tools**: Track and log all AI API requests
- **Development Tools**: Local proxy for testing SSO-protected APIs
- **Integration Platforms**: Connect SSO-based services to your applications

## 📝 License

Apache-2.0

## 🤝 Contributing

This example is part of the `@codemieai/code` project. For issues or improvements, please open an issue in the main repository.

## 📞 Support

For questions or issues:
- Check the main project README
- Review debug logs in `~/.codemie/logs/`
- Open an issue in the repository
