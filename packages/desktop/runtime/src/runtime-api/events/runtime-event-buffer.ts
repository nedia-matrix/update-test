export interface RuntimeEventEnvelope<T> {
  cursor: number;
  events: T[];
  reset: boolean;
}

interface StoredRuntimeEvent<T> {
  sequence: number;
  value: T;
}

interface EventWaiter {
  finish(): void;
}

export class RuntimeEventBuffer<T> {
  private readonly entries: StoredRuntimeEvent<T>[] = [];
  private readonly waiters = new Set<EventWaiter>();
  private closed = false;
  private sequence = 0;

  constructor(private readonly capacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError("Runtime event capacity must be a positive integer");
    }
  }

  append(value: T): number {
    const sequence = ++this.sequence;
    this.entries.push({ sequence, value });
    if (this.entries.length > this.capacity) this.entries.shift();
    for (const waiter of [...this.waiters]) waiter.finish();
    return sequence;
  }

  async poll(
    after: number,
    timeoutMs: number,
  ): Promise<RuntimeEventEnvelope<T>> {
    validateCursor(after);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("Runtime event timeout must be non-negative");
    }
    if (this.closed || this.sequence !== after || timeoutMs === 0) {
      return this.snapshot(after);
    }
    await new Promise<void>((resolve) => {
      const waiter: EventWaiter = {
        finish: () => {
          clearTimeout(timeout);
          this.waiters.delete(waiter);
          resolve();
        },
      };
      const timeout = setTimeout(waiter.finish, timeoutMs);
      this.waiters.add(waiter);
    });
    return this.snapshot(after);
  }

  close(): void {
    this.closed = true;
    for (const waiter of [...this.waiters]) waiter.finish();
  }

  open(): void {
    this.closed = false;
  }

  private snapshot(after: number): RuntimeEventEnvelope<T> {
    const oldest = this.entries[0]?.sequence ?? this.sequence + 1;
    return {
      cursor: this.sequence,
      events: this.entries
        .filter(({ sequence }) => sequence > after)
        .map(({ value }) => value),
      reset: after > this.sequence || after < oldest - 1,
    };
  }
}

function validateCursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Runtime event cursor must be a non-negative integer");
  }
}
