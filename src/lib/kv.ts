import { getCloudflareContext } from '@opennextjs/cloudflare';
import debug from 'debug';

const log = debug('umami:kv-client');

export const DELETED = '__DELETED__';
export const DEFAULT_TTL = 3600;
// Workers KV enforces a 60s minimum TTL on writes.
const MIN_KV_TTL = 60;

function getKV(): KVNamespace {
  const { env } = getCloudflareContext();
  if (!env?.CACHE) {
    throw new Error('CACHE KV binding is not configured on this Worker');
  }
  return env.CACHE as KVNamespace;
}

/**
 * Cloudflare Workers KV-backed shim with the same surface as UmamiRedisClient
 * in src/lib/redis.ts. Used when running under @opennextjs/cloudflare with the
 * CACHE binding present.
 *
 * Semantics worth knowing:
 *   - KV is eventually consistent (~60s globally). Tokens may briefly survive
 *     a logout; acceptable here because JWT TTLs still bound the blast radius.
 *   - Minimum TTL is 60s. Shorter TTLs are clamped up.
 *   - No atomic incr. rateLimit() is best-effort and racy under contention.
 */
class UmamiKVClient {
  async get(key: string) {
    try {
      return await getKV().get(key, 'json');
    } catch (err) {
      log('kv get error:', err);
      return null;
    }
  }

  async set(key: string, value: any, time?: number) {
    const ttl = time && time > 0 ? time : DEFAULT_TTL;
    const expirationTtl = Math.max(ttl, MIN_KV_TTL);
    return getKV().put(key, JSON.stringify(value), { expirationTtl });
  }

  async del(key: string) {
    return getKV().delete(key);
  }

  async incr(key: string) {
    // Best-effort: get-modify-put. Not atomic — concurrent writers can lose
    // updates. Nothing in the umami codebase relies on this for correctness;
    // kept for API parity with UmamiRedisClient.
    const current = (await this.get(key)) as number | null;
    const next = (typeof current === 'number' ? current : 0) + 1;
    await this.set(key, next);
    return next;
  }

  async expire(key: string, seconds: number) {
    // KV has no separate TTL update; round-trip the value with a new TTL.
    const value = await this.get(key);
    if (value === null) return;
    await this.set(key, value, seconds);
  }

  async rateLimit(key: string, limit: number, seconds: number): Promise<boolean> {
    // Best-effort. For real rate limiting on Workers use Durable Objects or
    // Cloudflare's Rate Limiting binding instead.
    const res = await this.incr(key);
    if (res === 1) {
      await this.expire(key, seconds);
    }
    return res >= limit;
  }

  async fetch(key: string, query: () => Promise<any>, time?: number) {
    const result = await this.get(key);
    if (result === DELETED) return null;
    if (!result && query) {
      const data = await query();
      if (data) {
        await this.set(key, data, time);
      }
      return data;
    }
    return result;
  }

  async remove(key: string, soft = false) {
    return soft ? this.set(key, DELETED) : this.del(key);
  }
}

let cachedClient: UmamiKVClient | null = null;

export function getKVClient() {
  if (!cachedClient) {
    cachedClient = new UmamiKVClient();
  }
  return cachedClient;
}

export function isKVAvailable(): boolean {
  try {
    const { env } = getCloudflareContext({ async: false });
    return !!env?.CACHE;
  } catch {
    return false;
  }
}
