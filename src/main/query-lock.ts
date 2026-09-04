export class MutexTaskCancelledError extends Error {
  constructor() {
    super('TASK_CANCELLED');
    this.name = 'MutexTaskCancelledError';
  }
}

export class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  async runExclusive<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new MutexTaskCancelledError();
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    try {
      if (signal) await this.waitForTurn(previous, signal);
      else await previous;
      if (signal?.aborted) throw new MutexTaskCancelledError();
      return await task();
    } finally {
      release();
    }
  }

  private async waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return previous;
    if (signal.aborted) throw new MutexTaskCancelledError();
    await new Promise<void>((resolve, reject) => {
      const complete = () => {
        signal.removeEventListener('abort', cancel);
        resolve();
      };
      const cancel = () => {
        signal.removeEventListener('abort', cancel);
        reject(new MutexTaskCancelledError());
      };
      signal.addEventListener('abort', cancel, { once: true });
      void previous.then(complete, complete);
    });
  }
}
