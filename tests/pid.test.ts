import { describe, expect, it } from 'vitest';
import { createDefaultProjectConfig } from '../src/shared/defaults';
import { classifyDeliveryType, inferPackageName, inferPidClassification, isMixedPidName, parsePidInput, removePidFromInput, validatePids, validateRealtimePids } from '../src/domain/pid';

describe('PID validation', () => {
  it('infers package from the backend PID name', () => {
    expect(inferPackageName('王国大作战-安卓-头条')).toBe('APK');
    expect(inferPackageName('王国大作战-IOS-TAP')).toBe('IOS');
    expect(inferPackageName('王国大作战-微小')).toBe('微小');
    expect(inferPackageName('王国大作战-抖小')).toBe('抖小');
    expect(inferPackageName('王国大作战-鸿蒙')).toBe('鸿蒙');
  });

  it('infers operating system for each channel', () => {
    expect(inferPidClassification('王国大作战-APK-安卓')).toEqual({ channel: 'APK', operatingSystem: '安卓' });
    expect(inferPidClassification('王国大作战-IOS')).toEqual({ channel: 'IOS', operatingSystem: 'IOS' });
    expect(inferPidClassification('王国大作战-微小-安卓')).toEqual({ channel: '微小', operatingSystem: '安卓' });
    expect(inferPidClassification('王国大作战-微小-IOS')).toEqual({ channel: '微小', operatingSystem: 'IOS' });
    expect(inferPidClassification('王国大作战-抖小-安卓')).toEqual({ channel: '抖小', operatingSystem: '安卓' });
    expect(inferPidClassification('王国大作战-抖小-IOS')).toEqual({ channel: '抖小', operatingSystem: 'IOS' });
    expect(inferPidClassification('王国大作战-鸿蒙')).toEqual({ channel: '鸿蒙', operatingSystem: '鸿蒙' });
    expect(inferPidClassification('王国大作战-微小')).toBeNull();
  });

  it('only treats explicitly marked micro and dou channel names as mixed delivery', () => {
    const config = createDefaultProjectConfig();
    const result = validatePids('2170', '2170405', [{ id: '2170405', name: '测试微小渠道' }], config);
    expect(result.entries[0].packageName).toBe('微小');
    expect(result.entries[0].operatingSystem).toBeNull();
    expect(result.issues.some((issue) => issue.code === 'unrecognized_operating_system')).toBe(true);
    expect(isMixedPidName('测试微小渠道')).toBe(false);
    expect(isMixedPidName('测试微小渠道-混端投放')).toBe(true);
    expect(isMixedPidName('测试抖小-混投')).toBe(true);
    expect(isMixedPidName('测试微小-IOS')).toBe(false);
    expect(isMixedPidName('测试APK渠道')).toBe(false);
  });

  it('does not infer mixed delivery from a directory system value alone', () => {
    const config = createDefaultProjectConfig();
    const result = validatePids('2170', '2170405', [{
      id: '2170405', name: '后台名称未包含标准关键词', channel: '微小', operatingSystem: 'IOS',
    }], config);
    expect(result.entries[0].packageName).toBe('微小');
    expect(result.entries[0].operatingSystem).toBe('IOS');
  });

  it('splits commas, spaces and new lines', () => {
    expect(parsePidInput('2170405, 2170304\n2170305')).toEqual(['2170405', '2170304', '2170305']);
    expect(removePidFromInput('2170405, 2170304\n2170405', '2170405')).toBe('2170304');
  });

  it('validates numeric PID ownership and labels live and information-flow PIDs', () => {
    const config = createDefaultProjectConfig();
    config.pidPackageMap = { '2170405': 'APK', '2170305': 'APK' };
    const result = validatePids('2170', '2170405,2170405,2170305,1170001', [
      { id: '2170405', name: '测试微小安卓渠道' },
      { id: '2170305', name: '测试直播渠道' },
    ], config);
    expect(result.accepted).toEqual(['2170405', '2170305']);
    expect(result.entries.map((entry) => entry.status)).toEqual(['ok', 'duplicate', 'ok', 'invalid']);
    expect(result.entries.map((entry) => entry.deliveryType)).toEqual(['信息流', '信息流', '直播', '未识别']);
    expect(result.entries[0].packageName).toBe('微小');
    expect(result.entries[0].operatingSystem).toBe('安卓');
    expect(result.issues.map((issue) => issue.code)).toEqual(['duplicate_pid', 'invalid_pid']);
    expect(classifyDeliveryType('普通渠道', 'tt_ll_jh_agent_zb_custom')).toBe('直播');
    expect(classifyDeliveryType('普通渠道', 'tt_ll_jh_agent_zebra_custom')).toBe('信息流');
  });

  it('labels natural-volume PID names before other delivery types', () => {
    expect(classifyDeliveryType('王国大作战-自然量')).toBe('自然量');
    expect(classifyDeliveryType('王国大作战-自然流')).toBe('自然量');
    expect(classifyDeliveryType('王国大作战-自然')).toBe('自然量');
    expect(classifyDeliveryType('王国大作战-自然 量-直播')).toBe('自然量');
  });

  it('validates realtime PIDs independently from report live-PID settings', () => {
    const result = validateRealtimePids('2170', '2170305,2170305,1170001', [{ id: '2170305', name: '测试直播渠道' }]);
    expect(result.accepted).toEqual(['2170305']);
    expect(result.pidNames).toEqual({ '2170305': '测试直播渠道' });
    expect(result.issues.map((issue) => issue.code)).toEqual(['duplicate_pid', 'invalid_pid']);
  });
});
