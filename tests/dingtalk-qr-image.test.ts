import { describe, expect, it } from 'vitest';
import { findDingTalkQrImageRect } from '../src/main/dingtalk-qr-image';

describe('DingTalk QR screenshot detection', () => {
  it('returns null for an empty or invalid bitmap', () => {
    expect(findDingTalkQrImageRect(new Uint8Array(), 0, 0)).toBeNull();
    expect(findDingTalkQrImageRect(new Uint8Array(4), 2, 2)).toBeNull();
  });
});
