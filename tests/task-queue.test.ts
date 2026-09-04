import { describe, expect, it } from 'vitest';
import { TaskQueue } from '../src/main/task-queue';

describe('task queue', () => {
  it('runs only one BI query at a time while allowing completed-query work to overlap', async () => {
    const queue = new TaskQueue();
    const events: string[] = [];
    let releaseFirstProcessing!: () => void;
    let releaseSecondProcessing!: () => void;
    const first = queue.enqueue({
      name: 'first',
      kind: 'report',
      run: async ({ releaseBiQuery }) => {
        events.push('first-query');
        releaseBiQuery();
        await new Promise<void>((resolve) => { releaseFirstProcessing = resolve; });
        events.push('first-export');
        return 'first';
      },
    });
    const second = queue.enqueue({
      name: 'second',
      kind: 'realtime',
      run: async ({ releaseBiQuery }) => {
        events.push('second-query');
        releaseBiQuery();
        await new Promise<void>((resolve) => { releaseSecondProcessing = resolve; });
        events.push('second-send');
        return 'second';
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first-query', 'second-query']);
    expect(queue.snapshot().filter((item) => item.status === 'running')).toHaveLength(2);
    releaseFirstProcessing();
    releaseSecondProcessing();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('reorders and removes pending tasks without affecting the running task', async () => {
    const queue = new TaskQueue();
    let releaseFirst!: () => void;
    const first = queue.enqueue({
      name: 'first',
      kind: 'report',
      run: async () => new Promise<void>((resolve) => { releaseFirst = resolve; }),
    });
    const second = queue.enqueue({ name: 'second', kind: 'realtime', run: async ({ releaseBiQuery }) => { releaseBiQuery(); return 'second'; } });
    const third = queue.enqueue({ name: 'third', kind: 'scheduled', run: async ({ releaseBiQuery }) => { releaseBiQuery(); return 'third'; } });

    await Promise.resolve();
    const queued = queue.snapshot().filter((item) => item.status === 'queued');
    expect(queued.map((item) => item.name)).toEqual(['second', 'third']);
    expect(queue.move(queued[1].id, -1)).toBe(true);
    const reordered = queue.snapshot().filter((item) => item.status === 'queued');
    expect(reordered.map((item) => item.name)).toEqual(['third', 'second']);
    expect(queue.remove(reordered[1].id)).toBe(true);
    await expect(second).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    releaseFirst();
    await first;
    await expect(third).resolves.toBe('third');
  });
});
