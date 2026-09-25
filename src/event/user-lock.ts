/**
 * Serializes asynchronous work for each event owner independently.
 *
 * This is an in-process lock. It protects the owner-scoped event invariants
 * while this application is running as a single Node.js/Bun process.
 */
export class UserLock {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(userId) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.queues.set(userId, current);
    await previous;

    try {
      return await task();
    } finally {
      release();

      if (this.queues.get(userId) === current) {
        this.queues.delete(userId);
      }
    }
  }
}
