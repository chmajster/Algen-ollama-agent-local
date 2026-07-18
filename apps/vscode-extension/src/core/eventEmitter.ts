export interface DisposableLike {
  dispose(): void;
}

export class EventEmitter<T> implements DisposableLike {
  private readonly listeners = new Set<(event: T) => void>();

  public readonly event = (listener: (event: T) => void): DisposableLike => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  public fire(event: T): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  public dispose(): void {
    this.listeners.clear();
  }
}
