import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { DingTalkLoginQrCredentials, DingTalkLoginQrInput, DingTalkLoginQrStatus } from '../shared/contracts';

interface StoredDingTalkLoginQrV2 {
  version: 2;
  appKey: string;
  appSecret: string;
  robotCode: string;
  openConversationId: string;
}

interface StoredDingTalkLoginQrV3 {
  version: 3;
  appKey: string;
  appSecret: string;
  robotCode: string;
  openConversationId?: string;
}

type StoredDingTalkLoginQr = StoredDingTalkLoginQrV2 | StoredDingTalkLoginQrV3;

interface EncryptedDingTalkLoginQrStore {
  version: 1;
  ciphertext: string;
}

function isStoredDingTalkLoginQr(value: unknown): value is StoredDingTalkLoginQr {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const commonFieldsValid = typeof item.appKey === 'string'
    && typeof item.appSecret === 'string'
    && typeof item.robotCode === 'string';
  if (!commonFieldsValid) return false;
  if (item.version === 2) return typeof item.openConversationId === 'string';
  return item.version === 3 && (item.openConversationId === undefined || typeof item.openConversationId === 'string');
}

export class DingTalkLoginQrVault {
  private get filePath(): string {
    return join(app.getPath('userData'), 'dingtalk-login-qr-credentials.bin');
  }

  private async read(): Promise<StoredDingTalkLoginQr | null> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE');
    try {
      const stored = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as EncryptedDingTalkLoginQrStore;
      if (stored.version !== 1 || typeof stored.ciphertext !== 'string') return null;
      const decoded = JSON.parse(safeStorage.decryptString(Buffer.from(stored.ciphertext, 'base64'))) as unknown;
      return isStoredDingTalkLoginQr(decoded) ? decoded : null;
    } catch (error) {
      if (error instanceof Error && error.message === 'ENCRYPTION_UNAVAILABLE') throw error;
      return null;
    }
  }

  async status(): Promise<DingTalkLoginQrStatus> {
    const value = await this.read();
    return {
      configured: Boolean(value?.appKey && value.appSecret && value.robotCode),
      groupBound: Boolean(value?.openConversationId),
    };
  }

  async get(): Promise<DingTalkLoginQrCredentials | null> {
    const value = await this.read();
    if (!value?.appKey || !value.appSecret || !value.robotCode || !value.openConversationId) return null;
    return {
      appKey: value.appKey,
      appSecret: value.appSecret,
      robotCode: value.robotCode,
      openConversationId: value.openConversationId,
    };
  }

  async getBindingConfig(): Promise<DingTalkLoginQrInput | null> {
    const value = await this.read();
    if (!value?.appKey || !value.appSecret || !value.robotCode) return null;
    return { appKey: value.appKey, appSecret: value.appSecret, robotCode: value.robotCode };
  }

  async set(input: DingTalkLoginQrInput): Promise<DingTalkLoginQrStatus> {
    const appKey = input.appKey.trim();
    const appSecret = input.appSecret.trim();
    const robotCode = input.robotCode.trim();
    if (!appKey || !appSecret || !robotCode) throw new Error('INVALID_DINGTALK_LOGIN_QR');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE');
    const ciphertext = safeStorage.encryptString(JSON.stringify({ version: 3, appKey, appSecret, robotCode } satisfies StoredDingTalkLoginQrV3));
    const payload: EncryptedDingTalkLoginQrStore = { version: 1, ciphertext: ciphertext.toString('base64') };
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(payload), 'utf8');
    return { configured: true, groupBound: false };
  }

  async bindGroup(openConversationId: string): Promise<DingTalkLoginQrStatus> {
    const value = await this.read();
    const groupId = openConversationId.trim();
    if (!value?.appKey || !value.appSecret || !value.robotCode || !groupId) throw new Error('DINGTALK_QR_CONFIG_REQUIRED');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE');
    const ciphertext = safeStorage.encryptString(JSON.stringify({
      version: 3,
      appKey: value.appKey,
      appSecret: value.appSecret,
      robotCode: value.robotCode,
      openConversationId: groupId,
    } satisfies StoredDingTalkLoginQrV3));
    const payload: EncryptedDingTalkLoginQrStore = { version: 1, ciphertext: ciphertext.toString('base64') };
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(payload), 'utf8');
    return { configured: true, groupBound: true };
  }

  async clear(): Promise<void> {
    try { await fs.unlink(this.filePath); } catch { /* no stored QR configuration */ }
  }
}
