import { app, safeStorage, session } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PARTITION = 'ops-q1-memory';

interface EncryptedCookieStore {
  createdAt: string;
  ciphertext: string;
}

export class SessionVault {
  readonly browserSession = session.fromPartition(PARTITION);

  private get filePath(): string {
    return join(app.getPath('userData'), 'ops-session.bin');
  }

  async restore(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) return;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const stored = JSON.parse(raw) as EncryptedCookieStore;
      if (Date.now() - Date.parse(stored.createdAt) > MAX_AGE_MS) {
        await this.clear();
        return;
      }
      const plaintext = safeStorage.decryptString(Buffer.from(stored.ciphertext, 'base64'));
      const cookies = JSON.parse(plaintext) as Array<Record<string, unknown>>;
      for (const cookie of cookies) {
        const domain = String(cookie.domain ?? 'ops.q1.com');
        const url = `${cookie.secure === false ? 'http' : 'https'}://${domain.replace(/^\./u, '')}${String(cookie.path ?? '/')}`;
        await this.browserSession.cookies.set({
          url,
          name: String(cookie.name),
          value: String(cookie.value),
          domain: cookie.domain ? String(cookie.domain) : undefined,
          path: cookie.path ? String(cookie.path) : '/',
          secure: cookie.secure !== false,
          httpOnly: cookie.httpOnly === true,
          expirationDate: typeof cookie.expirationDate === 'number' ? cookie.expirationDate : undefined,
        });
      }
    } catch {
      await this.clear();
    }
  }

  async save(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) return;
    const cookies = (await this.browserSession.cookies.get({})).filter((cookie) => (cookie.domain ?? '').endsWith('q1.com'));
    const ciphertext = safeStorage.encryptString(JSON.stringify(cookies));
    const payload: EncryptedCookieStore = { createdAt: new Date().toISOString(), ciphertext: ciphertext.toString('base64') };
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(payload), 'utf8');
  }

  async clear(): Promise<void> {
    try { await fs.unlink(this.filePath); } catch { /* no stored session */ }
    await this.browserSession.clearStorageData({ storages: ['cookies'] });
  }
}
