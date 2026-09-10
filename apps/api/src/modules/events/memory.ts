import type { EventBus, TopicName, TopicPayloads } from './bus.js';

type Handler = (event: unknown) => Promise<void>;

/** In-process bus. Same semantics as Kafka minus durability - for dev, tests and single-node demos. */
export class MemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, Handler[]>();

  constructor(private readonly onError: (err: unknown) => void = () => {}) {}

  async publish<T extends TopicName>(topic: T, _key: string, event: TopicPayloads[T]) {
    const list = this.handlers.get(topic) ?? [];
    // Fire-and-forget like a real broker: the publisher never waits for consumers.
    for (const h of list) {
      void h(event).catch(this.onError);
    }
  }

  async subscribe<T extends TopicName>(
    topic: T,
    _groupId: string,
    handler: (event: TopicPayloads[T]) => Promise<void>,
  ) {
    const list = this.handlers.get(topic) ?? [];
    list.push(handler as Handler);
    this.handlers.set(topic, list);
  }

  async close() {
    this.handlers.clear();
  }
}
