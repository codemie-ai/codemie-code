/**
 * CodeMie SSO Proxy Example
 *
 * This example demonstrates how to use @codemieai/code package
 * to integrate SSO authentication and proxy functionality into
 * your own applications.
 *
 * Features:
 * - SSO authentication via browser
 * - HTTP proxy server with plugin system
 * - Request/response logging
 * - Usage metrics collection and syncing
 * - Profile management
 */

import dotenv from 'dotenv';
import { CodeMieSSO, CodeMieProxy, ConfigLoader, logger, SessionStore, getPluginRegistry } from '@codemieai/code';
import { MetricsCollectorPlugin } from './metrics-collector-plugin.js';

// Load environment variables from .env file
dotenv.config();

// Configuration from environment
const SSO_URL = process.env.CODEMIE_SSO_URL || 'https://codemie.lab.epam.com';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '0', 10);
const PROXY_TIMEOUT = parseInt(process.env.PROXY_TIMEOUT || '300000', 10);
const DEBUG = process.env.CODEMIE_DEBUG === '1';

// Profile configuration
const PROFILE_NAME = 'plugin-sso';

/**
 * Main application flow
 */
async function main() {
  console.log('\n🚀 CodeMie SSO Proxy Example\n');
  console.log('═'.repeat(60));

  let proxy = null;

  try {
    // Step 1: Initialize SSO authentication
    console.log('\n📝 Step 1: SSO Authentication');
    console.log('─'.repeat(60));

    const sso = new CodeMieSSO();

    // Check if we have stored credentials
    let credentials = await sso.getStoredCredentials(SSO_URL);

    if (credentials) {
      console.log('✅ Found stored SSO credentials');
      console.log(`   API URL: ${credentials.apiUrl}`);
      console.log(`   Expires: ${credentials.expiresAt ? new Date(credentials.expiresAt).toLocaleString() : 'Unknown'}`);

      // Check if credentials are expired
      if (credentials.expiresAt && Date.now() > credentials.expiresAt) {
        console.log('⚠️  Credentials expired, re-authenticating...');
        credentials = null;
      }
    }

    if (!credentials) {
      console.log('🔐 Starting SSO authentication...');
      console.log(`   SSO URL: ${SSO_URL}`);
      console.log('   A browser window will open for authentication.');

      const authResult = await sso.authenticate({
        codeMieUrl: SSO_URL,
        timeout: 120000 // 2 minutes
      });

      if (!authResult.success) {
        throw new Error(`SSO authentication failed: ${authResult.error}`);
      }

      credentials = await sso.getStoredCredentials(SSO_URL);

      if (!credentials) {
        throw new Error('Failed to retrieve stored credentials after authentication');
      }

      console.log('✅ SSO authentication successful!');
      console.log(`   API URL: ${credentials.apiUrl}`);
    }

    // Step 2: Create or update profile
    console.log('\n📝 Step 2: Profile Configuration');
    console.log('─'.repeat(60));

    const profile = {
      name: PROFILE_NAME,
      provider: 'ai-run-sso',
      baseUrl: credentials.apiUrl,
      codeMieUrl: SSO_URL,
      authMethod: 'sso',
      model: 'claude-3-5-sonnet-20241022', // Default model
      timeout: PROXY_TIMEOUT,
      debug: DEBUG
    };

    await ConfigLoader.saveProfile(PROFILE_NAME, profile);
    console.log(`✅ Profile '${PROFILE_NAME}' created/updated`);
    console.log(`   Provider: ${profile.provider}`);
    console.log(`   API URL: ${profile.baseUrl}`);
    console.log(`   Model: ${profile.model}`);

    // Step 3: Create session file (required for metrics sync)
    console.log('\n📝 Step 3: Creating Session File');
    console.log('─'.repeat(60));

    const sessionId = generateSessionId();
    
    // Initialize logger with session ID (required for metrics collection)
    logger.setSessionId(sessionId);

    // Create session file - this is required for metrics sync to work
    const sessionStore = new SessionStore();
    const session = {
      sessionId,
      agentName: 'external-app',
      provider: 'ai-run-sso',
      startTime: Date.now(),
      workingDirectory: process.cwd(),
      status: 'active',
      correlation: {
        status: 'matched', // Set to 'matched' for external usage (no agent correlation needed)
        retryCount: 0
      }
    };

    await sessionStore.saveSession(session);
    console.log(`✅ Session file created: ${sessionId}`);

    // Step 3.5: Register custom metrics collector plugin
    console.log('\n📝 Step 3.5: Registering Custom Metrics Collector');
    console.log('─'.repeat(60));
    
    const registry = getPluginRegistry();
    const metricsPlugin = new MetricsCollectorPlugin();
    registry.register(metricsPlugin);
    console.log(`✅ Custom metrics collector plugin registered: ${metricsPlugin.name}`);
    console.log(`   Plugin ID: ${metricsPlugin.id}, Priority: ${metricsPlugin.priority}`);
    
    // Verify registration
    const allPlugins = registry.getAll();
    console.log(`   Total plugins registered: ${allPlugins.length}`);
    allPlugins.forEach(p => {
      console.log(`     - ${p.id} (priority: ${p.priority})`);
    });

    // Step 4: Start proxy server
    console.log('\n📝 Step 4: Starting Proxy Server');
    console.log('─'.repeat(60));

    const proxyConfig = {
      targetApiUrl: credentials.apiUrl,
      port: PROXY_PORT,
      provider: 'ai-run-sso',
      clientType: 'external-app',
      sessionId: sessionId,
      timeout: PROXY_TIMEOUT,
      profile: PROFILE_NAME,
      model: profile.model,
      version: '1.0.0',
      profileConfig: profile
    };

    proxy = new CodeMieProxy(proxyConfig);
    const { port, url } = await proxy.start();

    console.log('✅ Proxy server started successfully!');
    console.log(`   URL: ${url}`);
    console.log(`   Port: ${port}`);
    console.log(`   Target API: ${credentials.apiUrl}`);
    console.log('\n💡 All requests to this proxy will be forwarded to the CodeMie backend');
    console.log('   with SSO authentication and metrics collection enabled.');

    // Step 5: Demonstrate proxy usage with test requests
    console.log('\n📝 Step 5: Testing Proxy (Making Sample Requests)');
    console.log('─'.repeat(60));

    await demonstrateProxyUsage(url, port);

    // Step 6: Keep proxy running
    console.log('\n📝 Step 6: Proxy Running');
    console.log('─'.repeat(60));
    console.log('✅ Proxy is now running and ready to handle requests');
    console.log('   Press Ctrl+C to stop the proxy and exit');
    console.log('\n📊 Features active:');
    console.log('   • SSO Authentication: Cookies injected automatically');
    console.log('   • Request Logging: All requests logged to ~/.codemie/logs/');
    console.log('   • Metrics Collection: Usage metrics collected and synced');
    console.log('   • Session Tracking: All requests tracked by session ID');

    // Keep the process running
    await new Promise(() => {}); // Infinite promise

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (DEBUG) {
      console.error('\nStack trace:', error.stack);
    }
    process.exit(1);
  } finally {
    // Cleanup on exit
    if (proxy) {
      console.log('\n🛑 Stopping proxy server...');
      await proxy.stop();
      console.log('✅ Proxy stopped successfully');
    }
  }
}

/**
 * Demonstrate proxy usage by making sample HTTP requests
 */
async function demonstrateProxyUsage(proxyUrl, proxyPort) {
  console.log('\n🧪 Making test requests through the proxy...\n');

  try {
    // Test 1: Health check / config endpoint
    console.log('Test 1: Fetching configuration...');
    const configResponse = await fetch(`${proxyUrl}/config.js`);

    if (configResponse.ok) {
      const configText = await configResponse.text();
      console.log(`✅ Config fetched: ${configText.substring(0, 100)}...`);
    } else {
      console.log(`⚠️  Config request failed: ${configResponse.status} ${configResponse.statusText}`);
    }

    // Test 2: Check models endpoint (if available)
    console.log('\nTest 2: Fetching available models...');
    const modelsResponse = await fetch(`${proxyUrl}/v1/models`, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (modelsResponse.ok) {
      const models = await modelsResponse.json();
      console.log(`✅ Models fetched: ${JSON.stringify(models).substring(0, 100)}...`);
    } else {
      console.log(`⚠️  Models request failed: ${modelsResponse.status} ${modelsResponse.statusText}`);
    }

    console.log('\n💡 All requests were:');
    console.log('   • Authenticated with SSO cookies');
    console.log('   • Logged to debug files');
    console.log('   • Tracked for metrics collection');
    console.log('   • Forwarded through the proxy to the backend');

  } catch (error) {
    console.log(`⚠️  Test requests failed: ${error.message}`);
    console.log('   This is normal if the backend endpoints are not accessible.');
  }
}

/**
 * Generate a unique session ID
 */
function generateSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Handle graceful shutdown
 */
process.on('SIGINT', () => {
  console.log('\n\n👋 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n👋 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Run the application
main().catch(error => {
  console.error('\n❌ Unhandled error:', error);
  process.exit(1);
});
