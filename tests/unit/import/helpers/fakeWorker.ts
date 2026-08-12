/**
 * A controllable stand-in for a real Worker.
 *
 * Lifecycle behaviour — settlement, cancellation, stale messages, cleanup —
 * needs to be driven deterministically, which a real worker cannot offer. The
 * real worker is exercised separately by the Playwright integration test.
 */
export class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly posted: unknown[] = [];
  terminated = false;

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  static reset(): void {
    FakeWorker.instances = [];
  }

  /** The most recently constructed instance. */
  static get last(): FakeWorker {
    const worker = FakeWorker.instances.at(-1);
    if (!worker) throw new Error('No FakeWorker has been constructed.');
    return worker;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Total listeners still attached, across every event type. */
  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  /** Delivers a message as the worker would. */
  emitMessage(data: unknown): void {
    this.dispatch('message', { data });
  }

  emitMessageError(): void {
    this.dispatch('messageerror', { data: null });
  }

  emitError(): void {
    this.dispatch('error', { preventDefault: () => {} });
  }

  private dispatch(type: string, event: unknown): void {
    // A terminated worker delivers nothing, exactly like the real thing.
    if (this.terminated) return;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  /** The requestId the client sent, for building matching responses. */
  get sentRequestId(): string {
    const first = this.posted[0] as { requestId?: string } | undefined;
    if (!first?.requestId) throw new Error('No request was posted.');
    return first.requestId;
  }
}

export function fakeWorkerFactory(): () => Worker {
  return () => new FakeWorker() as unknown as Worker;
}

/** A factory whose construction always throws, for the blocked-worker path. */
export function throwingWorkerFactory(): () => Worker {
  return () => {
    throw new Error('Worker construction blocked by policy');
  };
}
