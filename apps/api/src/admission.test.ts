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

it('rejects exhausted OIDC traffic before fetching JWKS or looking up identity', async () => {
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
    });
    for (let index = 0; index < 120; index++)
      expect((await app.inject('/v1/me')).statusCode).toBe(401);
    const authorization = { authorization: `Bearer ${token}` };
    expect(
      (await app.inject({ url: '/v1/me', headers: authorization })).statusCode,
    ).toBe(429);
    expect(lookups).toBe(0);
    expect(db.identify).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          url: '/v1/me',
          headers: authorization,
          remoteAddress: '127.0.0.2',
        })
      ).statusCode,
    ).toBe(200);
    expect(lookups).toBe(1);
    expect(db.identify).toHaveBeenCalledExactlyOnceWith(issuer, subject);
  } finally {
    await jwks.close();
  }
});
