import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface OpenCodeServiceConfig {
  baseUrl: string;
  authHeader: string;
  password?: string;
}

export class OpenCodeConnector {
  private serviceConfig: OpenCodeServiceConfig | null = null;

  constructor(customUrl?: string, customPassword?: string) {
    this.serviceConfig = this.resolveServiceConfig(customUrl, customPassword);
  }

  /**
   * Auto-discover OpenCode v2 background service from ~/.config/opencode/service.json
   */
  public resolveServiceConfig(customUrl?: string, customPassword?: string): OpenCodeServiceConfig | null {
    const baseUrl = customUrl || process.env.OPENCODE_SERVER_URL || 'http://127.0.0.1:49374';
    let password = customPassword || process.env.OPENCODE_SERVER_PASSWORD;

    if (!password) {
      const configPaths = [
        path.join(os.homedir(), '.config', 'opencode', 'service.json'),
        path.join(os.homedir(), '.opencode', 'service.json'),
      ];

      for (const p of configPaths) {
        if (fs.existsSync(p)) {
          try {
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (raw.password) {
              password = raw.password;
              break;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }

    if (!password) {
      return null;
    }

    const authHeader = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
    return {
      baseUrl,
      authHeader,
      password,
    };
  }

  public isAvailable(): boolean {
    return this.serviceConfig !== null;
  }

  public getServiceConfig(): OpenCodeServiceConfig | null {
    return this.serviceConfig;
  }

  /**
   * Fetch active providers from OpenCode v2
   */
  public async getProviders(): Promise<any[]> {
    if (!this.serviceConfig) throw new Error('OpenCode v2 service credentials not found');
    const res = await fetch(`${this.serviceConfig.baseUrl}/api/provider`, {
      headers: { Authorization: this.serviceConfig.authHeader },
    });
    if (!res.ok) throw new Error(`OpenCode provider fetch failed [${res.status}]`);
    const json = (await res.json()) as any;
    return json.data || [];
  }

  }
