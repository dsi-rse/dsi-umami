import path from 'node:path';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { browserName, detectOS } from 'detect-browser';
import ipaddr from 'ipaddr.js';
import { UAParser } from 'ua-parser-js';
import { getIpAddress, stripPort } from '@/lib/ip';
import { safeDecodeURIComponent } from '@/lib/url';

// `is-localhost-ip` binds a socket (node:dgram) to test the address, which
// hangs on workerd. ipaddr's range check covers the same loopback, private,
// link-local and unique-local ranges synchronously.
const LOCAL_RANGES = ['unspecified', 'loopback', 'private', 'linkLocal', 'uniqueLocal'];

function isLocalIp(ip: string): boolean {
  if (!ip) return true;
  // Try the address as-is first: stripPort mangles IPv4-mapped IPv6.
  for (const candidate of [ip, stripPort(ip).replace(/^\[|\]$/g, '')]) {
    if (ipaddr.isValid(candidate)) {
      return LOCAL_RANGES.includes(ipaddr.process(candidate).range());
    }
  }
  return false;
}

// On Cloudflare Workers, request.cf always carries geo; the cf-ip* headers only
// include region and city when the zone enables the visitor-location Managed
// Transform. Outside Workers there is no context, so this returns undefined.
function getCloudflareGeo() {
  try {
    return getCloudflareContext().cf;
  } catch {
    return undefined;
  }
}

const MAXMIND = 'maxmind';

const PROVIDER_HEADERS = [
  // Umami custom headers (cloud mode only)
  ...(process.env.CLOUD_MODE
    ? [
        {
          countryHeader: 'x-umami-client-country',
          regionHeader: 'x-umami-client-region',
          cityHeader: 'x-umami-client-city',
        },
      ]
    : []),
  // Cloudflare headers
  {
    countryHeader: 'cf-ipcountry',
    regionHeader: 'cf-region-code',
    cityHeader: 'cf-ipcity',
  },
  // Vercel headers
  {
    countryHeader: 'x-vercel-ip-country',
    regionHeader: 'x-vercel-ip-country-region',
    cityHeader: 'x-vercel-ip-city',
  },
  // CloudFront headers
  {
    countryHeader: 'cloudfront-viewer-country',
    regionHeader: 'cloudfront-viewer-country-region',
    cityHeader: 'cloudfront-viewer-city',
  },
  // EdgeOne headers (requires custom request headers in Rule Priorities, see: https://edgeone.ai/document/46151)
  {
    countryHeader: 'eo-ipcountry',
    regionHeader: 'eo-region-code',
    cityHeader: 'eo-ipcity',
  },
];

export function getDevice(userAgent: string, screen: string = '') {
  const { device } = UAParser(userAgent);

  const [width] = screen.split('x');

  const type = device?.type || 'desktop';

  if (type === 'desktop' && screen && +width <= 1920) {
    return 'laptop';
  }

  return type;
}

function getRegionCode(country: string, region: string) {
  if (!country || !region) {
    return undefined;
  }

  return region.includes('-') ? region : `${country}-${region}`;
}

function decodeHeader(s: string | undefined | null): string | undefined | null {
  if (s === undefined || s === null) {
    return s;
  }

  return Buffer.from(s, 'latin1').toString('utf-8');
}

export async function getLocation(ip: string = '', headers: Headers, skipHeaders: boolean) {
  const cleanIp = stripPort(ip);

  // Ignore local or invalid ips
  if (isLocalIp(ip) || !cleanIp || !ipaddr.isValid(cleanIp)) {
    return null;
  }

  if (!skipHeaders && !process.env.SKIP_LOCATION_HEADERS) {
    const cf = getCloudflareGeo();
    if (cf?.country) {
      return {
        country: cf.country,
        region: getRegionCode(cf.country, cf.regionCode),
        city: cf.city,
      };
    }

    for (const provider of PROVIDER_HEADERS) {
      const countryHeader = headers.get(provider.countryHeader);
      if (countryHeader) {
        const country = decodeHeader(countryHeader);
        const region = decodeHeader(headers.get(provider.regionHeader));
        const city = decodeHeader(headers.get(provider.cityHeader));

        return {
          country,
          region: getRegionCode(country, region),
          city,
        };
      }
    }
  }

  // Database lookup — lazy-import maxmind so the worker bundle stays small
  // on serverless runtimes (e.g. Cloudflare Workers) that get geo from
  // request headers and never reach this fallback.
  if (!globalThis[MAXMIND]) {
    const { default: maxmind } = await import('maxmind');
    const dir = path.join(process.cwd(), 'geo');

    // No GeoLite database is bundled on Workers; a lookup we can't do means
    // "unknown location", not a failed event.
    globalThis[MAXMIND] = await maxmind
      .open(process.env.GEOLITE_DB_PATH || path.resolve(dir, 'GeoLite2-City.mmdb'))
      .catch(() => null);
  }

  const result = globalThis[MAXMIND]?.get(cleanIp);

  if (result) {
    const country = result.country?.iso_code ?? result?.registered_country?.iso_code;
    const region = result.subdivisions?.[0]?.iso_code;
    const city = result.city?.names?.en;

    return {
      country,
      region: getRegionCode(country, region),
      city,
    };
  }
}

export async function getClientInfo(request: Request, payload: Record<string, any>) {
  const userAgent = payload?.userAgent || request.headers.get('user-agent');
  const ip = payload?.ip || getIpAddress(request.headers);
  const location = await getLocation(ip, request.headers, !!payload?.ip);
  const country = safeDecodeURIComponent(location?.country);
  const region = safeDecodeURIComponent(location?.region);
  const city = safeDecodeURIComponent(location?.city);
  const browser = payload?.browser ?? browserName(userAgent);
  const os = payload?.os ?? (detectOS(userAgent) as string);
  const device = payload?.device ?? getDevice(userAgent, payload?.screen);

  return { userAgent, browser, os, ip, country, region, city, device };
}

export function hasBlockedIp(clientIp: string) {
  const ignoreIps = process.env.IGNORE_IP;

  if (!clientIp || !ignoreIps) {
    return false;
  }

  const ips = ignoreIps.split(',').map(n => n.trim());

  return ips.some(ip => {
    if (ip === clientIp) {
      return true;
    }

    // CIDR notation
    if (ip.indexOf('/') > 0) {
      try {
        const addr = ipaddr.parse(clientIp);
        const range = ipaddr.parseCIDR(ip);

        if (addr.kind() === range[0].kind() && addr.match(range)) {
          return true;
        }
      } catch {
        // Ignore parsing errors
      }
    }

    return false;
  });
}
