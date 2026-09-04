import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserHost } from '../src/main/q1-connector';
import { hasVisibleLoginScreenshotPixels, Q1Connector } from '../src/main/q1-connector';

function browserHost(stop: () => void): BrowserHost {
  return {
    webContents: {
      getURL: () => 'https://ops.q1.com/',
      isDestroyed: () => false,
      stop,
      executeJavaScript: vi.fn(),
    } as never,
    isDestroyed: () => false,
    focus: () => undefined,
    loadURL: async () => undefined,
  };
}

describe('task cancellation', () => {
  afterEach(() => vi.useRealTimers());

  it('does not turn a cancelled login check into a logged-out state', async () => {
    const connector = new Q1Connector(browserHost(() => undefined));
    const controller = new AbortController();
    connector.setTaskAbortSignal(controller.signal);
    controller.abort();

    await expect(connector.isLoggedIn()).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
  });

  it('still cancels when stopping the embedded browser throws', () => {
    const connector = new Q1Connector(browserHost(() => { throw new Error('navigation already stopped'); }));
    const controller = new AbortController();
    connector.setTaskAbortSignal(controller.signal);

    expect(() => controller.abort()).not.toThrow();
  });

  it('uses cache-bypassing refreshes for a blank automatic login page', async () => {
    vi.useFakeTimers();
    const reloadIgnoringCache = vi.fn();
    const host: BrowserHost = {
      webContents: {
        getURL: () => 'https://sso-auth.q1.com/#/login',
        isDestroyed: () => false,
        stop: () => undefined,
        reloadIgnoringCache,
        executeJavaScript: vi.fn().mockRejectedValue(new Error('renderer unavailable')),
      } as never,
      isDestroyed: () => false,
      focus: () => undefined,
      loadURL: async () => undefined,
    };
    const diagnostics = { event: vi.fn(async () => undefined), error: vi.fn(async () => undefined) } as never;
    const connector = new Q1Connector(host, diagnostics);
    const statuses: string[] = [];
    const recovery = connector.recoverBlankAutoLoginPage((message) => statuses.push(message)).catch((error) => error);

    await vi.advanceTimersByTimeAsync(120_100);

    await expect(recovery).resolves.toMatchObject({ code: 'LOGIN_PAGE_BLANK' });
    expect(reloadIgnoringCache).toHaveBeenCalledTimes(3);
    expect(statuses).toContain('登录页白屏，正在第 1/3 次强制刷新…');
    expect(statuses).toContain('登录页连续强制刷新 3 次后仍为空白。');
  });

  it('recognizes a visible login page when page script execution is unavailable', async () => {
    const bitmap = Buffer.alloc(4 * 1600, 255);
    for (let index = 0; index < 4 * 400; index += 4) bitmap[index] = 20;
    expect(hasVisibleLoginScreenshotPixels(bitmap)).toBe(true);

    const reloadIgnoringCache = vi.fn();
    const host: BrowserHost = {
      webContents: {
        getURL: () => 'https://sso-auth.q1.com/#/login',
        isDestroyed: () => false,
        stop: () => undefined,
        reloadIgnoringCache,
        capturePage: vi.fn().mockResolvedValue({ isEmpty: () => false, toBitmap: () => bitmap }),
        executeJavaScript: vi.fn().mockRejectedValue(new Error('renderer unavailable')),
      } as never,
      isDestroyed: () => false,
      focus: () => undefined,
      loadURL: async () => undefined,
    };
    const diagnostics = { event: vi.fn(async () => undefined), error: vi.fn(async () => undefined) } as never;
    const connector = new Q1Connector(host, diagnostics);

    await expect(connector.recoverBlankAutoLoginPage()).resolves.toBeUndefined();
    expect(reloadIgnoringCache).not.toHaveBeenCalled();
  });
});
