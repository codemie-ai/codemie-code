import { MessageInterceptor } from './apply-to-messages.js';

export class InterceptorRegistry {
  private interceptors: Map<string, MessageInterceptor> = new Map();

  register(interceptor: MessageInterceptor): void {
    this.interceptors.set(interceptor.id, interceptor);
  }

  unregister(id: string): void {
    this.interceptors.delete(id);
  }

  getAll(): MessageInterceptor[] {
    return Array.from(this.interceptors.values());
  }

  has(id: string): boolean {
    return this.interceptors.has(id);
  }

  clear(): void {
    this.interceptors.clear();
  }
}

export function createInterceptorRegistry(): InterceptorRegistry {
  return new InterceptorRegistry();
}
