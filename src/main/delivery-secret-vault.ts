import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface DeliverySecret {
  webhookUrl: string;
  signingSecret: string;
}

interface EncryptedDeliverySecretStore {
  version: 1;
  ciphertext: string;
}

function isDeliverySecret(value: unknown): value is DeliverySecret {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.webhookUrl === 'string' && typeof item.signingSecret === 'string';
}

export class DeliverySecretVault {
  private get filePath(): string {
    return join(app.getPath('userData'), 'scheduled-delivery-secrets.bin');
  }

  private async read(): Promise<Record<string, DeliverySecret>> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE');
    try {
      const stored = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as EncryptedDeliverySecretStore;
      if (stored.version !== 1 || typeof stored.ciphertext !== 'string') return {};
      const plaintext = safeStorage.decryptString(Buffer.from(stored.ciphertext, 'base64'));
      const decoded = JSON.parse(plaintext) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(decoded).flatMap(([id, secret]) => id.trim() && isDeliverySecret(secret)
        ? [[id.trim(), { webhookUrl: secret.webhookUrl, signingSecret: secret.signingSecret }]]
        : []));
    } catch (error) {
      if (error instanceof Error && error.message === 'ENCRYPTION_UNAVAILABLE') throw error;
      return {};
    }
  }

  private async write(secrets: Record<string, DeliverySecret>): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE');
    const ciphertext = safeStorage.encryptString(JSON.stringify(secrets));
    const payload: EncryptedDeliverySecretStore = { version: 1, ciphertext: ciphertext.toString('base64') };
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(payload), 'utf8');
  }

  async get(secretId: string): Promise<DeliverySecret | null> {
    const secrets = await this.read();
    return secrets[secretId] ?? null;
  }

  async set(secretId: string, secret: DeliverySecret): Promise<void> {
    const id = secretId.trim();
    if (!id || !secret.webhookUrl.trim() || !secret.signingSecret.trim()) throw new Error('INVALID_DELIVERY_SECRET');
    const secrets = await this.read();
    secrets[id] = { webhookUrl: secret.webhookUrl.trim(), signingSecret: secret.signingSecret.trim() };
    await this.write(secrets);
  }

  async remove(secretId: string): Promise<void> {
    const id = secretId.trim();
    if (!id) return;
    const secrets = await this.read();
    if (!(id in secrets)) return;
    delete secrets[id];
    await this.write(secrets);
  }
}
