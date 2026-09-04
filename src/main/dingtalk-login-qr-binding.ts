import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream';
import type { DingTalkLoginQrInput } from '../shared/contracts';

const BINDING_MESSAGE = '绑定二维码';

interface DingTalkStreamClient {
  registerCallbackListener(topic: string, callback: (message: DWClientDownStream) => void): unknown;
  connect(): Promise<void>;
  disconnect(): void;
}

export class DingTalkLoginQrBindingError extends Error {
  constructor(readonly code: 'DINGTALK_BIND_TIMEOUT' | 'DINGTALK_BIND_CONNECTION_FAILED' | 'DINGTALK_BIND_ALREADY_RUNNING') {
    super(code);
  }
}

export interface DingTalkLoginQrBindingOptions {
  createClient?: (credentials: DingTalkLoginQrInput) => DingTalkStreamClient;
  timeoutMs?: number;
}

interface DingTalkRobotBindingMessage {
  conversationId?: unknown;
  conversationType?: unknown;
  robotCode?: unknown;
  msgtype?: unknown;
  text?: { content?: unknown };
}

function normalizeBindingText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s/gu, '') : '';
}

export function bindingConversationId(payload: string, robotCode: string): string | null {
  let message: DingTalkRobotBindingMessage;
  try {
    message = JSON.parse(payload) as DingTalkRobotBindingMessage;
  } catch {
    return null;
  }
  if (message.conversationType !== '2' || message.robotCode !== robotCode || message.msgtype !== 'text') return null;
  if (normalizeBindingText(message.text?.content) !== BINDING_MESSAGE) return null;
  return typeof message.conversationId === 'string' && message.conversationId.trim() ? message.conversationId.trim() : null;
}

export class DingTalkLoginQrBindingService {
  private active = false;
  private readonly createClient: (credentials: DingTalkLoginQrInput) => DingTalkStreamClient;
  private readonly timeoutMs: number;

  constructor(options: DingTalkLoginQrBindingOptions = {}) {
    this.createClient = options.createClient ?? ((credentials) => new DWClient({
      clientId: credentials.appKey,
      clientSecret: credentials.appSecret,
      debug: false,
      keepAlive: true,
    }));
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async bind(credentials: DingTalkLoginQrInput): Promise<string> {
    if (this.active) throw new DingTalkLoginQrBindingError('DINGTALK_BIND_ALREADY_RUNNING');
    this.active = true;
    let client: DingTalkStreamClient | null = null;
    try {
      const streamClient = this.createClient(credentials);
      client = streamClient;
      return await new Promise<string>((resolve, reject) => {
        let finished = false;
        const finish = (result: () => void) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          result();
        };
        const timeout = setTimeout(() => {
          finish(() => reject(new DingTalkLoginQrBindingError('DINGTALK_BIND_TIMEOUT')));
        }, this.timeoutMs);

        streamClient.registerCallbackListener(TOPIC_ROBOT, (message) => {
          const conversationId = bindingConversationId(message.data, credentials.robotCode);
          if (conversationId) finish(() => resolve(conversationId));
        });
        void streamClient.connect().catch(() => finish(() => reject(new DingTalkLoginQrBindingError('DINGTALK_BIND_CONNECTION_FAILED'))));
      });
    } finally {
      client?.disconnect();
      this.active = false;
    }
  }
}
