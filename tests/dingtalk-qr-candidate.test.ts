import { describe, expect, it } from 'vitest';
import { hasVisibleLoginPageContent, isLikelyDingTalkQrCandidate } from '../src/main/q1-connector';

describe('DingTalk QR candidate selection', () => {
  it('does not mistake the account-login container for a QR code before scan login is selected', () => {
    expect(isLikelyDingTalkQrCandidate({
      tagName: 'DIV',
      className: 'login-code-panel',
      id: '',
      alt: '',
      width: 280,
      height: 280,
    })).toBe(false);
  });

  it('accepts a square QR canvas or explicitly named QR container after scan login is selected', () => {
    expect(isLikelyDingTalkQrCandidate({ tagName: 'CANVAS', className: '', id: '', alt: '', width: 180, height: 180 })).toBe(true);
    expect(isLikelyDingTalkQrCandidate({ tagName: 'DIV', className: 'qrcode-box', id: '', alt: '', width: 180, height: 180 })).toBe(true);
    expect(isLikelyDingTalkQrCandidate({ tagName: 'DIV', className: 'scan-box', id: '', alt: '', backgroundImage: 'url(data:image/png;base64,...)', width: 180, height: 180 })).toBe(true);
  });

  it('does not treat a generic square SVG as a QR code', () => {
    expect(isLikelyDingTalkQrCandidate({ tagName: 'SVG', className: 'brand-logo', id: '', alt: '', width: 180, height: 180 })).toBe(false);
  });
});

describe('automatic login blank-page detection', () => {
  it('treats an empty page as blank', () => {
    expect(hasVisibleLoginPageContent({ hasVisibleText: false, interactiveElementCount: 0, visualElementCount: 0 })).toBe(false);
  });

  it('accepts a page once it has visible login content', () => {
    expect(hasVisibleLoginPageContent({ hasVisibleText: true, interactiveElementCount: 0, visualElementCount: 0 })).toBe(true);
    expect(hasVisibleLoginPageContent({ hasVisibleText: false, interactiveElementCount: 2, visualElementCount: 0 })).toBe(true);
  });
});
