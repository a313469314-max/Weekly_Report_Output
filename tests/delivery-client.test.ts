import { describe, expect, it } from 'vitest';
import { buildDeliveryPayload } from '../src/main/delivery-client';

describe('delivery payload formatting', () => {
  it('uses DingTalk plain text so line breaks survive message rendering', () => {
    expect(buildDeliveryPayload('dingtalk', '标题\n消耗：100\n激活数：10\n\n下一个 PID')).toEqual({
      msgtype: 'text',
      text: { content: '标题\n消耗：100\n激活数：10\n\n下一个 PID' },
    });
  });

  it('keeps Feishu plain text payload unchanged', () => {
    expect(buildDeliveryPayload('feishu', '标题\n消耗：100')).toEqual({
      msg_type: 'text',
      content: { text: '标题\n消耗：100' },
    });
  });

});
