export class QueueFullError extends Error {
  readonly status = 429;
  readonly code = "queue_full";

  constructor(adapter: string, maxQueue: number) {
    super(`Adapter ${adapter} queue is full (${maxQueue} waiting requests)`);
    this.name = "QueueFullError";
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

class Semaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly adapter: string,
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
    private readonly onIdle?: () => void,
  ) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(Object.assign(new Error("Aborted while waiting for adapter capacity"), { code: "ABORT_ERR" }));
    }
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new QueueFullError(this.adapter, this.maxQueue));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(Object.assign(new Error("Aborted while waiting for adapter capacity"), { code: "ABORT_ERR" }));
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  snapshot(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
      if (this.active === 0 && this.queue.length === 0) this.onIdle?.();
    };
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const waiter = this.queue.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(Object.assign(new Error("Aborted while waiting for adapter capacity"), { code: "ABORT_ERR" }));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseOnce());
    }
  }
}

export class AdapterLimiter {
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(
    readonly maxConcurrent = 2,
    readonly maxQueue = 16,
    private readonly cleanupIdle = false,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64) {
      throw new Error("maxConcurrency must be an integer between 1 and 64");
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 0 || maxQueue > 10_000) {
      throw new Error("maxQueue must be an integer between 0 and 10000");
    }
  }

  acquire(adapter: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(Object.assign(new Error("Aborted while waiting for adapter capacity"), { code: "ABORT_ERR" }));
    }
    return this.forAdapter(adapter).acquire(signal);
  }

  snapshot(): Record<string, { active: number; queued: number }> {
    return Object.fromEntries([...this.semaphores].map(([id, semaphore]) => [id, semaphore.snapshot()]));
  }

  private forAdapter(adapter: string): Semaphore {
    let semaphore = this.semaphores.get(adapter);
    if (!semaphore) {
      let created: Semaphore;
      created = new Semaphore(adapter, this.maxConcurrent, this.maxQueue, this.cleanupIdle
        ? () => {
            if (this.semaphores.get(adapter) === created) this.semaphores.delete(adapter);
          }
        : undefined);
      semaphore = created;
      this.semaphores.set(adapter, semaphore);
    }
    return semaphore;
  }
}
