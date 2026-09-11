import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import { TOPICS } from '@helpdesk/shared';
import type { EventBus, TopicName, TopicPayloads } from './bus.js';

export interface KafkaBusOptions {
  brokers: string[];
  clientId: string;
  log?: { info(msg: string): void; error(obj: unknown, msg?: string): void };
}

/**
 * AI: Kafka-backed bus (KRaft cluster, no ZooKeeper). Partition key = ticketId keeps per-ticket
 * ordering; consumer groups give horizontal scaling of workers.
 */
export class KafkaEventBus implements EventBus {
  private readonly kafka: Kafka;
  private producer: Producer | null = null;
  private readonly consumers: Consumer[] = [];

  constructor(private readonly opts: KafkaBusOptions) {
    this.kafka = new Kafka({
      clientId: opts.clientId,
      brokers: opts.brokers,
      logLevel: logLevel.WARN,
      retry: { initialRetryTime: 300, retries: 8 },
    });
  }

  /** AI: Idempotent: creates topics with sane partition counts if they do not exist. */
  async ensureTopics(): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const existing = new Set(await admin.listTopics());
      const wanted = Object.values(TOPICS).filter((t) => !existing.has(t));
      if (wanted.length) {
        await admin.createTopics({
          waitForLeaders: true,
          topics: wanted.map((topic) => ({
            topic,
            numPartitions: 6,
            replicationFactor: 1,
            configEntries: [{ name: 'retention.ms', value: String(7 * 24 * 3600 * 1000) }],
          })),
        });
        this.opts.log?.info(`kafka: created topics ${wanted.join(', ')}`);
      }
    } finally {
      await admin.disconnect();
    }
  }

  private async getProducer(): Promise<Producer> {
    if (!this.producer) {
      const p = this.kafka.producer({ allowAutoTopicCreation: false, idempotent: true });
      await p.connect();
      this.producer = p;
    }
    return this.producer;
  }

  async publish<T extends TopicName>(topic: T, key: string, event: TopicPayloads[T]) {
    const producer = await this.getProducer();
    await producer.send({
      topic,
      messages: [
        {
          key,
          value: JSON.stringify(event),
          headers: { type: (event as { type?: string }).type ?? '' },
        },
      ],
    });
  }

  async subscribe<T extends TopicName>(
    topic: T,
    groupId: string,
    handler: (event: TopicPayloads[T]) => Promise<void>,
  ) {
    const consumer = this.kafka.consumer({ groupId });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        try {
          await handler(JSON.parse(message.value.toString()) as TopicPayloads[T]);
        } catch (err) {
          // AI: Poison messages must not stall the partition; log and move on.
          this.opts.log?.error(err, `kafka: handler failed for ${topic}`);
        }
      },
    });
    this.consumers.push(consumer);
  }

  async close() {
    await Promise.all(this.consumers.map((c) => c.disconnect()));
    await this.producer?.disconnect();
  }
}
