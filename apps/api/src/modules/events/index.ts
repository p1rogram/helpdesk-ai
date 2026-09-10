import type { EventBus } from './bus.js';
import { KafkaEventBus } from './kafka.js';
import { MemoryEventBus } from './memory.js';

export * from './bus.js';
export { KafkaEventBus } from './kafka.js';
export { MemoryEventBus } from './memory.js';

export interface EventBusConfig {
  kind: 'memory' | 'kafka';
  brokers: string;
  clientId: string;
  log: { info(msg: string): void; error(obj: unknown, msg?: string): void };
}

export async function createEventBus(cfg: EventBusConfig): Promise<EventBus> {
  if (cfg.kind === 'kafka') {
    const bus = new KafkaEventBus({
      brokers: cfg.brokers.split(',').map((s) => s.trim()),
      clientId: cfg.clientId,
      log: cfg.log,
    });
    await bus.ensureTopics();
    cfg.log.info(`event bus: kafka (${cfg.brokers})`);
    return bus;
  }
  cfg.log.info('event bus: in-memory');
  return new MemoryEventBus((err) => cfg.log.error(err, 'memory bus handler failed'));
}
