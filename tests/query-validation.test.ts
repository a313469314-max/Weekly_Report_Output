import { describe, expect, it } from 'vitest';
import { createQueryValidationSnapshot, isQueryValidationSnapshotCurrent } from '../src/shared/query-validation';

describe('query validation snapshot', () => {
  it('invalidates the snapshot when PID input changes', () => {
    const snapshot = createQueryValidationSnapshot('2170', '2170-CN', '2170304');
    expect(isQueryValidationSnapshotCurrent(snapshot, '2170', '2170-CN', '2170305')).toBe(false);
  });

  it('invalidates the snapshot when gameid changes', () => {
    const snapshot = createQueryValidationSnapshot('2170', '2170-CN', '2170304');
    expect(isQueryValidationSnapshotCurrent(snapshot, '2171', '2170-CN', '2170304')).toBe(false);
  });

  it('invalidates the snapshot when gameVersion changes', () => {
    const snapshot = createQueryValidationSnapshot('2170', '2170-CN-A', '2170304');
    expect(isQueryValidationSnapshotCurrent(snapshot, '2170', '2170-CN-B', '2170304')).toBe(false);
  });

  it('compares normalized PID lists instead of separators', () => {
    const snapshot = createQueryValidationSnapshot('2170', '2170-CN', '2170304, 2170405');
    expect(isQueryValidationSnapshotCurrent(snapshot, '2170', '2170-CN', '2170304\n2170405')).toBe(true);
  });
});
