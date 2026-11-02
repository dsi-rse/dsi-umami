import { afterEach, expect, test } from 'vitest';
import { getLocation } from './detect';

// What @opennextjs/cloudflare's getCloudflareContext() reads on Workers.
const CONTEXT = Symbol.for('__cloudflare-context__');
const headers = new Headers({ 'cf-ipcountry': 'US' });

afterEach(() => {
  delete globalThis[CONTEXT];
});

test('getLocation: skips loopback, private, link-local and unique-local addresses', async () => {
  for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1']) {
    expect(await getLocation(ip, headers, false)).toBeNull();
  }
  expect(await getLocation('fd00::1', headers, false)).toBeNull();
  expect(await getLocation('::ffff:10.0.0.1', headers, false)).toBeNull();
});

test('getLocation: uses headers for public addresses', async () => {
  expect(await getLocation('8.8.8.8', headers, false)).toMatchObject({ country: 'US' });
  expect(await getLocation('2002:c000:204::1', headers, false)).toMatchObject({ country: 'US' });
});

test('getLocation: prefers request.cf on Workers (region and city without the Managed Transform)', async () => {
  globalThis[CONTEXT] = { cf: { country: 'US', regionCode: 'IL', city: 'Chicago' }, env: {} };
  expect(await getLocation('8.8.8.8', headers, false)).toEqual({
    country: 'US',
    region: 'US-IL',
    city: 'Chicago',
  });
});

test('getLocation: a missing GeoLite database means no location, not an error', async () => {
  process.env.GEOLITE_DB_PATH = '/nonexistent/GeoLite2-City.mmdb';
  expect(await getLocation('8.8.8.8', new Headers(), true)).toBeUndefined();
  delete process.env.GEOLITE_DB_PATH;
});
