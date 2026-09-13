import { createClient, type RedisClientType } from "redis";
import type { RawVenueEvent } from "./adapter.js";

/**
 * Thin wrapper around a Redis Stream used as the internal event bus between
 * venue workers and the normalizer (M0 design doc Section 1: "Redis Streams
 * or Kafka" — Redis Streams chosen for M0 since volume doesn't yet justify
 * Kafka's operational overhead; revisit if/when normalizer consumer lag
 * becomes the bottleneck).
 *
 * One stream per venue so a slow/broken consumer on one venue never blocks
 * ingestion for the others.
 */
const STREAM_PREFIX = "tli:raw-events:";

export function streamNameFor(venue: string): string {
  return `${STREAM_PREFIX}${venue}`;
}

export class EventBus {
  private client: RedisClientType;

  constructor(url: string = process.env.REDIS_URL ?? "redis://localhost:6379") {
    this.client = createClient({ url });
  }

  async connect(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }

  async publish(event: RawVenueEvent): Promise<void> {
    await this.connect();
    await this.client.xAdd(streamNameFor(event.venue), "*", {
      payload: JSON.stringify(event),
    });
  }

  /**
   * Consume via a consumer group so multiple normalizer instances can share
   * load and so unacked messages get redelivered if a consumer crashes
   * mid-processing (at-least-once delivery — normalizer writes must be
   * idempotent, keyed on (venue, txHash, logIndex)).
   */
  async ensureConsumerGroup(venue: string, groupName: string): Promise<void> {
    await this.connect();
    try {
      await this.client.xGroupCreate(streamNameFor(venue), groupName, "0", { MKSTREAM: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("BUSYGROUP")) throw err;
    }
  }

  async readGroup(
    venue: string,
    groupName: string,
    consumerName: string,
    count = 50,
  ): Promise<Array<{ id: string; event: RawVenueEvent }>> {
    await this.connect();
    const result = await this.client.xReadGroup(
      groupName,
      consumerName,
      [{ key: streamNameFor(venue), id: ">" }],
      { COUNT: count, BLOCK: 5000 },
    );
    if (!result) return [];
    const out: Array<{ id: string; event: RawVenueEvent }> = [];
    for (const stream of result) {
      for (const message of stream.messages) {
        const payload = message.message["payload"];
        if (typeof payload === "string") {
          out.push({ id: message.id, event: JSON.parse(payload) as RawVenueEvent });
        }
      }
    }
    return out;
  }

  async ack(venue: string, groupName: string, id: string): Promise<void> {
    await this.connect();
    await this.client.xAck(streamNameFor(venue), groupName, id);
  }
}
