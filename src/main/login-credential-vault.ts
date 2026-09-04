import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { LoginCredentialInput, LoginCredentialStatus } from '../shared/contracts';

interface StoredLoginCredentials {
  version: 1;
  username: string;
  password: string;
}

interface EncryptedLoginCredentialStore {
  version: 1;
  ciphertext: string;
}

function isStoredLoginCredentials(value: unknown): value is StoredLoginCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.version === 1 && typeof item.username === 'string' && typeof item.password === 'string';
}

export class LoginCredentialVault {
  private get filePath(): string {
    return join(app.getPath('userData'), 'ops-login-credentials.bin');
  }

  private async read(): Promise<StoredLoginCredentials | null> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE');
    try {
      const stored = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as EncryptedLoginCredentialStore;
      if (stored.version !== 1 || typeof stored.ciphertext !== 'string') return null;
      const decoded = JSON.parse(safeStorage.decryptString(Buffer.from(stored.ciphertext, 'base64'))) as unknown;
      return isStoredLoginCredentials(decoded) ? decoded : null;
    } catch (error) {
      if (error instanceof Error && error.message === 'ENCRYPTION_UNAVAILABLE') throw error;
      return null;
    }
  }

  async status(): Promise<LoginCredentialStatus> {
    const credentials = await this.read();
    return { configured: Boolean(credentials?.username && credentials.password), username: credentials?.username ?? '' };
  }

  async get(): Promise<LoginCredentialInput | null> {
    const credentials = await this.read();
    if (!credentials?.username || !credentials.password) return null;
    return { username: credentials.username, password: credentials.password };
  }

  async set(input: LoginCredentialInput): Promise<LoginCredentialStatus> {
    const username = input.username.trim();
    const password = input.password;
    if (!username || !password) throw new Error('INVALID_LOGIN_CREDENTIALS');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE');
    const ciphertext = safeStorage.encryptString(JSON.stringify({ version: 1, username, password } satisfies StoredLoginCredentials));
    const payload: EncryptedLoginCredentialStore = { version: 1, ciphertext: ciphertext.toString('base64') };
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(payload), 'utf8');
    return { configured: true, username };
  }

  async clear(): Promise<void> {
    try { await fs.unlink(this.filePath); } catch { /* no stored credentials */ }
  }
}
