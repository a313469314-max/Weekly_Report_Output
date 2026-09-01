import { describe, expect, it } from 'vitest';
import { buildPidSearchKeyEvents, REPORT_FRAME_CLICK_MODES } from '../src/main/q1-connector';

describe('browser input routes', () => {
  it('only permits Electron and CDP mouse input routes', () => {
    expect(REPORT_FRAME_CLICK_MODES).toEqual(['web-contents', 'debugger']);
    expect(REPORT_FRAME_CLICK_MODES).not.toContain('native');
  });

  it('types a PID through individual keyboard events instead of assigning the whole value', () => {
    const events = buildPidSearchKeyEvents('2170304');
    expect(events.slice(0, 4).map((event) => `${event.type}:${event.key}`)).toEqual([
      'keyDown:Control', 'keyDown:a', 'keyUp:a', 'keyUp:Control',
    ]);
    expect(events.slice(4).filter((event) => event.type === 'keyDown').map((event) => event.text)).toEqual(['2', '1', '7', '0', '3', '0', '4']);
    expect(events.some((event) => event.text === '2170304')).toBe(false);
    expect(() => buildPidSearchKeyEvents('2170a04')).toThrow('digits only');
  });
});
