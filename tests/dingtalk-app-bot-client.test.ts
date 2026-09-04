import { describe, expect, it } from 'vitest';
import { sendDingTalkAppBotImage, sendDingTalkAppBotText } from '../src/main/dingtalk-app-bot-client';

const credentials = {
  appKey: 'app-key',
  appSecret: 'app-secret',
  robotCode: 'robot-code',
  openConversationId: 'cid-group',
};

describe('DingTalk enterprise bot delivery', () => {
  it('uploads the in-memory QR image and sends its media id to the configured group', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return new Response(JSON.stringify({ accessToken: 'access-token' }), { status: 200 });
      if (calls.length === 2) return new Response(JSON.stringify({ errcode: 0, media_id: '@media-id' }), { status: 200 });
      return new Response(JSON.stringify({ processQueryKey: 'accepted' }), { status: 200 });
    };

    await sendDingTalkAppBotImage(credentials, Buffer.from([1, 2, 3]), { fetcher });

    expect(calls).toHaveLength(3);
    expect(calls[1].url).toContain('/media/upload');
    expect(calls[1].init?.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      robotCode: 'robot-code',
      openConversationId: 'cid-group',
      msgKey: 'sampleImageMsg',
      msgParam: JSON.stringify({ photoURL: '@media-id' }),
    });
  });

  it('uses the enterprise bot text template for an explicit text test', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetcher: typeof fetch = async (_url, init) => {
      calls.push(init);
      return new Response(JSON.stringify(calls.length === 1 ? { accessToken: 'access-token' } : { processQueryKey: 'accepted' }), { status: 200 });
    };

    await sendDingTalkAppBotText(credentials, '测试消息', { fetcher });

    expect(JSON.parse(String(calls[1]?.body))).toMatchObject({ msgKey: 'sampleText', msgParam: JSON.stringify({ content: '测试消息' }) });
  });
});
