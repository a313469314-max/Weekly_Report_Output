import { createHmac } from 'node:crypto';
import type { DeliveryPlatform, DeliveryTarget } from '../shared/contracts';
import type { DeliverySecret } from './delivery-secret-vault';

export class DeliveryError extends Error {
  constructor(readonly code: string, readonly providerErrorCode?: string, readonly providerHttpStatus?: number) {
    super(code);
  }
}

export interface DeliveryClientOptions {
  fetcher?: typeof fetch;
  now?: () => number;
}

function signedWebhook(rawUrl: string, signingSecret: string, timestamp: number): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DeliveryError('INVALID_WEBHOOK_URL');
  }
  if (url.protocol !== 'https:') throw new DeliveryError('INVALID_WEBHOOK_URL');
  const stringToSign = `${timestamp}\n${signingSecret}`;
  const sign = createHmac('sha256', signingSecret).update(stringToSign).digest('base64');
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', sign);
  return url.toString();
}

export function buildDeliveryPayload(platform: DeliveryPlatform, text: string): Record<string, unknown> {
  return platform === 'dingtalk'
    ? { msgtype: 'text', text: { content: text } }
    : { msg_type: 'text', content: { text } };
}

function accepted(platform: DeliveryPlatform, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return platform === 'dingtalk'
    ? response.errcode === 0
    : response.StatusCode === 0 || response.code === 0;
}

function dingTalkErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const errcode = (value as Record<string, unknown>).errcode;
  if (typeof errcode === 'number' && Number.isFinite(errcode)) return String(errcode);
  if (typeof errcode === 'string' && /^\d+$/u.test(errcode)) return errcode;
  return undefined;
}

function rejectedDeliveryError(platform: DeliveryPlatform, value: unknown): DeliveryError {
  return new DeliveryError('DELIVERY_REJECTED', platform === 'dingtalk' ? dingTalkErrorCode(value) : undefined);
}

function httpDeliveryError(platform: DeliveryPlatform, response: Response, value: unknown): DeliveryError {
  return new DeliveryError('DELIVERY_HTTP_ERROR', platform === 'dingtalk' ? dingTalkErrorCode(value) : undefined, response.status);
}

export async function sendDeliveryMessage(target: DeliveryTarget, secret: DeliverySecret, text: string, options: DeliveryClientOptions = {}): Promise<void> {
  if (!secret.signingSecret.trim()) throw new DeliveryError('INVALID_SIGNING_SECRET');
  const fetcher = options.fetcher ?? globalThis.fetch;
  const timestamp = (options.now ?? Date.now)();
  const url = signedWebhook(secret.webhookUrl, secret.signingSecret, timestamp);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(buildDeliveryPayload(target.platform, text)),
    });
  } catch {
    throw new DeliveryError('DELIVERY_NETWORK_ERROR');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) throw new DeliveryError('DELIVERY_HTTP_ERROR', undefined, response.status);
    throw new DeliveryError('DELIVERY_RESPONSE_INVALID', undefined, response.status);
  }
  if (!response.ok) throw httpDeliveryError(target.platform, response, body);
  if (!accepted(target.platform, body)) throw rejectedDeliveryError(target.platform, body);
}
