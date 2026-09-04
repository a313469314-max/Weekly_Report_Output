import { describe, expect, it } from 'vitest';
import { AsyncMutex, MutexTaskCancelledError } from '../src/main/query-lock';

describe('AsyncMutex', () => {
  it('runs tasks one at a time and releases the lock after a failure', async () => {
    const lock = new AsyncMutex();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = lock.runExclusive(async () => {
      events.push('first-start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      events.push('first-end');
      throw new Error('first failed');
    });
    const second = lock.runExclusive(async () => {
      events.push('second-start');
      return 'second-result';
    });

    await Promise.resolve();
    expect(events).toEqual(['first-start']);
    releaseFirst();
    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe('second-result');
    expect(events).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('cancels a queued task immediately without blocking later tasks', async () => {
    const lock = new AsyncMutex();
    let releaseFirst!: () => void;
    let cancelledTaskRan = false;
    const first = lock.runExclusive(async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    const controller = new AbortController();
    const cancelled = lock.runExclusive(async () => {
      cancelledTaskRan = true;
    }, controller.signal);

    await Promise.resolve();
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(MutexTaskCancelledError);
    releaseFirst();
    await first;
    await expect(lock.runExclusive(async () => 'next-task')).resolves.toBe('next-task');
    expect(cancelledTaskRan).toBe(false);
  });
});
