import type { DingTalkLoginQrCredentials } from '../shared/contracts';

const ACCESS_TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const MEDIA_UPLOAD_URL = 'https://oapi.dingtalk.com/media/upload';
const GROUP_MESSAGE_URL = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';

export class DingTalkAppBotError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number, readonly providerCode?: string) {
    super(code);
  }
}

export interface DingTalkAppBotClientOptions {
  fetcher?: typeof fetch;
}

function providerCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const candidate = item.errcode ?? item.code ?? item.errorCode;
  const code = typeof candidate === 'number' ? String(candidate) : typeof candidate === 'string' ? candidate : '';
  return /^[A-Za-z0-9._-]{1,80}$/u.test(code) ? code : undefined;
}

function responseFailed(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.errcode === 'number') return item.errcode !== 0;
  if (typeof item.errcode === 'string') return item.errcode !== '0';
  if (typeof item.code === 'number') return item.code !== 0;
  if (typeof item.code === 'string') return item.code !== '0';
  return false;
}

async function requestJson(url: string, init: RequestInit, failureCode: string, options: DingTalkAppBotClientOptions): Promise<unknown> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch {
    throw new DingTalkAppBotError('DINGTALK_APP_BOT_NETWORK_ERROR');
  }
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new DingTalkAppBotError(failureCode, response.status, providerCode(body));
  if (body === undefined) throw new DingTalkAppBotError(`${failureCode}_RESPONSE_INVALID`, response.status);
  if (responseFailed(body)) throw new DingTalkAppBotError(failureCode, response.status, providerCode(body));
  return body;
}

async function accessToken(credentials: DingTalkLoginQrCredentials, options: DingTalkAppBotClientOptions): Promise<string> {
  const body = await requestJson(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ appKey: credentials.appKey, appSecret: credentials.appSecret }),
  }, 'DINGTALK_APP_BOT_TOKEN_FAILED', options);
  const token = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).accessToken : undefined;
  if (typeof token !== 'string' || !token) throw new DingTalkAppBotError('DINGTALK_APP_BOT_TOKEN_RESPONSE_INVALID');
  return token;
}

async function uploadImage(token: string, image: Buffer, options: DingTalkAppBotClientOptions): Promise<string> {
  const form = new FormData();
  form.append('access_token', token);
  form.append('type', 'image');
  form.append('media', new Blob([Uint8Array.from(image)], { type: 'image/png' }), 'q1-login-qr.png');
  const body = await requestJson(MEDIA_UPLOAD_URL, { method: 'POST', body: form }, 'DINGTALK_APP_BOT_MEDIA_UPLOAD_FAILED', options);
  const mediaId = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).media_id : undefined;
  if (typeof mediaId !== 'string' || !mediaId) throw new DingTalkAppBotError('DINGTALK_APP_BOT_MEDIA_RESPONSE_INVALID');
  return mediaId;
}

async function sendGroupMessage(token: string, credentials: DingTalkLoginQrCredentials, msgKey: string, msgParam: Record<string, string>, options: DingTalkAppBotClientOptions): Promise<void> {
  await requestJson(GROUP_MESSAGE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-acs-dingtalk-access-token': token,
    },
    body: JSON.stringify({
      robotCode: credentials.robotCode,
      openConversationId: credentials.openConversationId,
      msgKey,
      msgParam: JSON.stringify(msgParam),
    }),
  }, 'DINGTALK_APP_BOT_MESSAGE_SEND_FAILED', options);
}

export async function sendDingTalkAppBotText(credentials: DingTalkLoginQrCredentials, text: string, options: DingTalkAppBotClientOptions = {}): Promise<void> {
  const token = await accessToken(credentials, options);
  await sendGroupMessage(token, credentials, 'sampleText', { content: text }, options);
}

export async function sendDingTalkAppBotImage(credentials: DingTalkLoginQrCredentials, image: Buffer, options: DingTalkAppBotClientOptions = {}): Promise<void> {
  const token = await accessToken(credentials, options);
  const mediaId = await uploadImage(token, image, options);
  await sendGroupMessage(token, credentials, 'sampleImageMsg', { photoURL: mediaId }, options);
}
