import { describe, expect, it, vi } from 'vitest';
import type { DWClientDownStream } from 'dingtalk-stream';
import { bindingConversationId, DingTalkLoginQrBindingService } from '../src/main/dingtalk-login-qr-binding';

const credentials = { appKey: 'app-key', appSecret: 'app-secret', robotCode: 'robot-code' };

function robotMessage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    conversationId: 'cid-target-group',
    conversationType: '2',
    robotCode: 'robot-code',
    msgtype: 'text',
    text: { content: '绑定二维码' },
    ...overrides,
  });
}

describe('DingTalk login QR group binding', () => {
  it('only accepts the binding instruction from the configured bot in a group', () => {
    expect(bindingConversationId(robotMessage({ text: { content: ' 绑定 二维码 ' } }), 'robot-code')).toBe('cid-target-group');
    expect(bindingConversationId(robotMessage({ conversationType: '1' }), 'robot-code')).toBeNull();
    expect(bindingConversationId(robotMessage({ robotCode: 'other-bot' }), 'robot-code')).toBeNull();
    expect(bindingConversationId(robotMessage({ text: { content: '绑定报告' } }), 'robot-code')).toBeNull();
    expect(bindingConversationId('not-json', 'robot-code')).toBeNull();
  });

  it('disconnects as soon as it receives a matching group binding instruction', async () => {
    let callback: ((message: DWClientDownStream) => void) | undefined;
    const client = {
      registerCallbackListener: vi.fn((_topic: string, next: (message: DWClientDownStream) => void) => { callback = next; }),
      connect: vi.fn(async () => { callback?.({ data: robotMessage() } as DWClientDownStream); }),
      disconnect: vi.fn(),
    };
    const service = new DingTalkLoginQrBindingService({ createClient: () => client, timeoutMs: 1000 });

    await expect(service.bind(credentials)).resolves.toBe('cid-target-group');
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
});
