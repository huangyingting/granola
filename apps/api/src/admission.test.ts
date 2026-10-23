import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Database } from '@windows-ai-notes/db';
import { principal } from './auth.js';
import { createServer } from './server.js';

let db: Database;
let app: Awaited<ReturnType<typeof createServer>>;
const headers = { 'x-dev-subject': randomUUID() };

beforeEach(async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  db = new Database('postgresql://synthetic:synthetic@127.0.0.1:1/unused');
  vi.spyOn(db, 'assertReady').mockResolvedValue(undefined);
  vi.spyOn(db, 'identify').mockResolvedValue(randomUUID());
  app = await createServer(db, { mode: 'development', host: '127.0.0.1' });
});

afterEach(async () => {
  try {
    await app?.close();
  } finally {
    try {
      await db?.close();
    } finally {
      vi.restoreAllMocks();
    }
  }
});

async function exhaust() {
  for (let index = 0; index < 120; index++)
    expect((await app.inject({ url: '/v1/me', headers })).statusCode).toBe(200);
}

it.each([{ trustedProxies: undefined }, { trustedProxies: ['192.0.2.4'] }])(
  'ignores forged forwarded addresses from an untrusted peer (%j)',
  async ({ trustedProxies }) => {
    await app.close();
    app = await createServer(db, {
      mode: 'development',
      host: '127.0.0.1',
      ...(trustedProxies ? { trustedProxies } : {}),
    });
    for (let index = 0; index < 120; index++)
      expect(
        (
          await app.inject({
            url: '/v1/me',
            headers: {
              ...headers,
              'x-forwarded-for': `198.51.100.${index + 1}`,
            },
          })
        ).statusCode,
      ).toBe(200);
    expect(
      (
        await app.inject({
          url: '/v1/me',
          headers: { ...headers, 'x-forwarded-for': '203.0.113.2' },
        })
      ).statusCode,
    ).toBe(429);
    expect(db.identify).toHaveBeenCalledTimes(120);
  },
);

it.each([
  {
    peer: '127.0.0.1',
    proxies: ['127.0.0.1/32', '10.0.0.0/24'],
    suffix: ', 10.0.0.4',
  },
  { peer: '::ffff:127.0.0.1', proxies: ['127.0.0.1'], suffix: '' },
  { peer: '2001:db8:abcd::1', proxies: ['2001:db8:abcd::/64'], suffix: '' },
])(
  'stops at the nearest untrusted client through $peer and ignores forged leftmost hops',
  async ({ peer, proxies, suffix }) => {
    await app.close();
    app = await createServer(db, {
      mode: 'development',
      host: '127.0.0.1',
      trustedProxies: proxies,
    });
    for (let index = 0; index < 120; index++)
      expect(
        (
          await app.inject({
            url: '/v1/me',
            remoteAddress: peer,
            headers: {
              ...headers,
              'x-forwarded-for': `192.0.2.${index + 1}, 198.51.100.2${suffix}`,
            },
          })
        ).statusCode,
      ).toBe(200);
    expect(
      (
        await app.inject({
          url: '/v1/unmatched-admission',
          remoteAddress: peer,
          headers: {
            ...headers,
            'x-forwarded-for': `203.0.113.22, 198.51.100.2${suffix}`,
          },
        })
      ).statusCode,
    ).toBe(429);
    expect(db.identify).toHaveBeenCalledTimes(120);
    expect(
      (
        await app.inject({
          url: '/health/live',
          remoteAddress: peer,
          headers: { 'x-forwarded-for': `198.51.100.2${suffix}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: '/v1/me',
          remoteAddress: peer,
          headers: {
            ...headers,
            'x-forwarded-for': `192.0.2.1, 198.51.100.3${suffix}`,
          },
        })
      ).statusCode,
    ).toBe(200);
  },
);

it.each([
  { trustedProxies: [] },
  { trustedProxies: ['loopback'] },
  { trustedProxies: ['0.0.0.0/0'] },
  { trustedProxies: ['::/0'] },
  { trustedProxies: ['127.0.0.1/32\n'] },
])(
  'also validates programmatic proxy configuration %j before creating a server',
  async ({ trustedProxies }) => {
    await expect(
      createServer(db, {
        mode: 'development',
        host: '127.0.0.1',
        trustedProxies,
      }),
    ).rejects.toThrow('TRUSTED_PROXY_CIDRS');
  },
);

function payloadProbe() {
  const parsed = vi.fn();
  app.addContentTypeParser(
    'application/x-admission-probe',
    { parseAs: 'string' },
    (_request, body, done) => {
      parsed();
      done(null, body);
    },
  );
  app.post('/v1/admission-payload', async (request) => ({
    actor: principal(request).userId,
    payload: request.body,
  }));
  return parsed;
}

it('rejects exhausted business and unmatched requests before identity lookup', async () => {
  await exhaust();
  expect(db.identify).toHaveBeenCalledTimes(120);
  for (const url of ['/v1/me', '/v1/unmatched-admission']) {
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      request_id: response.headers['x-request-id'],
    });
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'retry-after': expect.any(String),
    });
    expect(db.identify).toHaveBeenCalledTimes(120);
  }
});

it.each(['/v1/me', '/v1/unmatched-admission'])(
  'unauthorized requests to %s consume the budget before identity work',
  async (url) => {
    for (let index = 0; index < 120; index++)
      expect((await app.inject(url)).statusCode).toBe(401);
    expect((await app.inject({ url, headers })).statusCode).toBe(429);
    expect(db.identify).not.toHaveBeenCalled();
  },
);

it('authenticated unmatched requests consume the ordinary API budget exactly once', async () => {
  for (let index = 0; index < 120; index++)
    expect(
      (await app.inject({ url: '/v1/unmatched-admission', headers }))
        .statusCode,
    ).toBe(404);
  expect((await app.inject({ url: '/v1/me', headers })).statusCode).toBe(429);
  expect(db.identify).toHaveBeenCalledTimes(120);
});

it('authenticates before parsing and forwards an admitted payload unchanged', async () => {
  const parsed = payloadProbe();
  const request = {
    method: 'POST' as const,
    url: '/v1/admission-payload',
    payload: 'private-admission-body-marker',
    headers: { 'content-type': 'application/x-admission-probe' },
  };
  expect((await app.inject(request)).statusCode).toBe(401);
  expect(parsed).not.toHaveBeenCalled();
  expect(db.identify).not.toHaveBeenCalled();
  const response = await app.inject({
    ...request,
    headers: { ...request.headers, ...headers },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    actor: await vi.mocked(db.identify).mock.results[0]!.value,
    payload: request.payload,
  });
  expect(parsed).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify(vi.mocked(process.stdout.write).mock.calls),
  ).not.toContain('private-');
});

it('rejects an exhausted POST before parsing its body or querying identity', async () => {
  const parsed = payloadProbe();
  await exhaust();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/admission-payload',
        headers: {
          ...headers,
          'content-type': 'application/x-admission-probe',
        },
        payload: 'private-admission-body-marker',
      })
    ).statusCode,
  ).toBe(429);
  expect(parsed).not.toHaveBeenCalled();
  expect(db.identify).toHaveBeenCalledTimes(120);
});

it('preserves authentication priority over malformed JSON while enforcing parsing for an admitted caller', async () => {
  const request = {
    method: 'POST' as const,
    url: '/v1/documents',
    headers: { 'content-type': 'application/json' },
    payload: '{',
  };
  expect((await app.inject(request)).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        ...request,
        headers: { ...request.headers, ...headers },
      })
    ).statusCode,
  ).toBe(400);
  expect(db.identify).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  'rejects exhausted OIDC traffic before fetching JWKS or looking up identity (trusted TCP ingress: %j)',
  async (proxied) => {
    const issuer = 'https://oidc.example.test';
    const subject = randomUUID();
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const key = {
      ...(await exportJWK(publicKey)),
      kid: 'admission-key',
      alg: 'RS256',
      use: 'sig',
    };
    const token = await new SignJWT({ scope: 'notes:read' })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setIssuer(issuer)
      .setAudience('notes')
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const jwks = Fastify({ logger: false });
    let lookups = 0;
    jwks.get('/jwks', async () => {
      lookups++;
      return { keys: [key] };
    });
    try {
      const base = await jwks.listen({ host: '127.0.0.1', port: 0 });
      await app.close();
      app = await createServer(db, {
        mode: 'oidc',
        host: '127.0.0.1',
        issuer,
        audience: 'notes',
        jwksUrl: `${base}/jwks`,
        requiredScope: 'notes:read',
        ...(proxied ? { trustedProxies: ['127.0.0.1/32'] } : {}),
      });
      const api = proxied
        ? await app.listen({ host: '127.0.0.1', port: 0 })
        : null;
      async function status(
        requestHeaders: Record<string, string> = {},
        nextClient = false,
      ) {
        if (api) {
          const response = await fetch(`${api}/v1/me`, {
            headers: {
              ...requestHeaders,
              'x-forwarded-for': nextClient
                ? '198.51.100.3'
                : '192.0.2.1, 198.51.100.2',
            },
          });
          await response.body?.cancel();
          return response.status;
        }
        return (
          await app.inject({
            url: '/v1/me',
            headers: requestHeaders,
            ...(nextClient ? { remoteAddress: '127.0.0.2' } : {}),
          })
        ).statusCode;
      }
      for (let index = 0; index < 120; index++)
        expect(await status()).toBe(401);
      const authorization = { authorization: `Bearer ${token}` };
      expect(await status(authorization)).toBe(429);
      expect(lookups).toBe(0);
      expect(db.identify).not.toHaveBeenCalled();
      expect(await status(authorization, true)).toBe(200);
      expect(lookups).toBe(1);
      expect(db.identify).toHaveBeenCalledExactlyOnceWith(issuer, subject);
    } finally {
      await jwks.close();
    }
  },
);
