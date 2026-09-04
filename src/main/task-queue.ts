import { randomUUID } from 'node:crypto';
import type { TaskQueueItem, TaskQueueKind, TaskQueueStatus } from '../shared/contracts';

export class TaskQueueCancelledError extends Error {
  readonly code = 'TASK_CANCELLED';

  constructor() {
    super('当前任务已终止。');
    this.name = 'TaskQueueCancelledError';
  }
}

export interface TaskQueueRunContext {
  signal: AbortSignal;
  releaseBiQuery(): void;
}

interface QueueEntry<T> extends TaskQueueItem {
  run: (context: TaskQueueRunContext) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  controller?: AbortController;
}

export interface EnqueueTaskOptions<T> {
  name: string;
  kind: TaskQueueKind;
  run: (context: TaskQueueRunContext) => Promise<T>;
}

export class TaskQueue {
  private readonly pending: QueueEntry<unknown>[] = [];
  private readonly running = new Map<string, QueueEntry<unknown>>();
  private readonly history: TaskQueueItem[] = [];
  private activeBiQuery: QueueEntry<unknown> | null = null;
  private readonly listeners = new Set<(items: TaskQueueItem[]) => void>();

  onChange(listener: (items: TaskQueueItem[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): TaskQueueItem[] {
    const running = [...this.running.values()];
    const active = this.activeBiQuery;
    const orderedRunning = active
      ? [active, ...running.filter((entry) => entry.id !== active.id)]
      : running;
    return [...orderedRunning.map((entry) => this.toItem(entry)), ...this.pending.map((entry) => this.toItem(entry)), ...this.history];
  }

  hasRunningTask(): boolean {
    return this.running.size > 0;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  async enqueue<T>(options: EnqueueTaskOptions<T>): Promise<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry: QueueEntry<T> = {
      id: randomUUID(),
      name: options.name,
      kind: options.kind,
      status: 'queued',
      message: '排队等待 BI 查询',
      createdAt: new Date().toISOString(),
      run: options.run,
      resolve,
      reject,
    };
    this.pending.push(entry as QueueEntry<unknown>);
    this.emit();
    this.startNextBiTask();
    return promise;
  }

  move(id: string, direction: -1 | 1): boolean {
    const index = this.pending.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const target = index + direction;
    if (target < 0 || target >= this.pending.length) return false;
    [this.pending[index], this.pending[target]] = [this.pending[target], this.pending[index]];
    this.emit();
    return true;
  }

  remove(id: string): boolean {
    const pendingIndex = this.pending.findIndex((entry) => entry.id === id);
    if (pendingIndex >= 0) {
      const [entry] = this.pending.splice(pendingIndex, 1);
      entry.status = 'cancelled';
      entry.message = '已从队列删除';
      entry.finishedAt = new Date().toISOString();
      entry.reject(new TaskQueueCancelledError());
      this.emit();
      return true;
    }
    const historyIndex = this.history.findIndex((entry) => entry.id === id);
    if (historyIndex < 0) return false;
    this.history.splice(historyIndex, 1);
    this.emit();
    return true;
  }

  cancel(id: string): boolean {
    const running = this.running.get(id);
    if (running) {
      running.controller?.abort();
      return true;
    }
    return this.remove(id);
  }

  cancelActiveBiTask(): boolean {
    if (!this.activeBiQuery) return false;
    return this.cancel(this.activeBiQuery.id);
  }

  cancelCurrentTask(): boolean {
    if (this.activeBiQuery) return this.cancel(this.activeBiQuery.id);
    const running = this.running.values().next().value as QueueEntry<unknown> | undefined;
    return running ? this.cancel(running.id) : false;
  }

  private startNextBiTask(): void {
    if (this.activeBiQuery || this.pending.length === 0) return;
    const entry = this.pending.shift();
    if (!entry) return;
    this.activeBiQuery = entry;
    this.running.set(entry.id, entry);
    entry.status = 'running';
    entry.message = '正在读取 BI 数据';
    entry.startedAt = new Date().toISOString();
    entry.controller = new AbortController();
    this.emit();
    void this.execute(entry);
  }

  private async execute(entry: QueueEntry<unknown>): Promise<void> {
    let biQueryReleased = false;
    const releaseBiQuery = () => {
      if (biQueryReleased) return;
      biQueryReleased = true;
      if (this.activeBiQuery?.id === entry.id) {
        this.activeBiQuery = null;
        if (entry.status === 'running') entry.message = 'BI 读取完成，正在处理结果';
        this.emit();
        this.startNextBiTask();
      }
    };
    try {
      const result = await entry.run({ signal: entry.controller!.signal, releaseBiQuery });
      entry.status = 'success';
      entry.message = '执行完成';
      entry.finishedAt = new Date().toISOString();
      entry.resolve(result);
    } catch (error) {
      entry.status = entry.controller?.signal.aborted || error instanceof TaskQueueCancelledError ? 'cancelled' : 'failed';
      entry.message = entry.status === 'cancelled' ? '已终止' : '执行失败';
      entry.finishedAt = new Date().toISOString();
      entry.reject(error);
    } finally {
      releaseBiQuery();
      this.running.delete(entry.id);
      this.history.unshift(this.toItem(entry));
      this.history.splice(30);
      this.emit();
    }
  }

  private emit(): void {
    const items = this.snapshot();
    for (const listener of this.listeners) listener(items);
  }

  private toItem(entry: QueueEntry<unknown>): TaskQueueItem {
    const { run: _run, resolve: _resolve, reject: _reject, controller: _controller, ...item } = entry;
    return item;
  }
}

export function taskQueueStatusLabel(status: TaskQueueStatus): string {
  if (status === 'queued') return '排队中';
  if (status === 'running') return '执行中';
  if (status === 'success') return '已完成';
  if (status === 'cancelled') return '已终止';
  return '失败';
}
