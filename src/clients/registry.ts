import { GitHubClientAdapter } from './adapters/github.js';
import { GitLabClientAdapter } from './adapters/gitlab.js';

export interface ClientAdapter {
  name: string;
  displayName: string;
  description: string;
  cliCommand: string; // The actual CLI command (gh, glab)

  install(): Promise<void>;
  uninstall(): Promise<void>;
  isInstalled(): Promise<boolean>;
  getVersion(): Promise<string | null>;

  // Optional authentication
  isAuthenticated?(): Promise<boolean>;
  authenticate?(): Promise<void>;
}

export class ClientRegistry {
  private static adapters: Map<string, ClientAdapter> = new Map<string, ClientAdapter>([
    ['github', new GitHubClientAdapter()],
    ['gitlab', new GitLabClientAdapter()]
  ]);

  static getClient(name: string): ClientAdapter | undefined {
    return ClientRegistry.adapters.get(name);
  }

  static getAllClients(): ClientAdapter[] {
    return Array.from(ClientRegistry.adapters.values());
  }

  static getClientNames(): string[] {
    return Array.from(ClientRegistry.adapters.keys());
  }

  static async getInstalledClients(): Promise<ClientAdapter[]> {
    const clients: ClientAdapter[] = [];
    for (const adapter of ClientRegistry.adapters.values()) {
      if (await adapter.isInstalled()) {
        clients.push(adapter);
      }
    }
    return clients;
  }
}
