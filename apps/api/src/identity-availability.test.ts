import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Database } from '@windows-ai-notes/db';
import { createServer } from './server.js';

const issuer = 'https://identity.example.test';
const subject = randomUUID();
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let alternate: Awaited<ReturnType<typeof generateKeyPair>>;
let key: Awaited<ReturnType<typeof exportJWK>>;
let alternateKey: Awaited<ReturnType<typeof exportJWK>>;
let db: Database;
let app: Awaited<ReturnType<typeof createServer>>;
let jwks: FastifyInstance;
let lookups: number;
let release: () => void;
let mode:
  | 'healthy'
  | 'http'
  | 'held-http'
  | 'invalid-json'
  | 'invalid-set'
  | 'invalid-key'
  | 'reset'
  | 'timeout'
  | 'multiple';

beforeAll(async () => {
  [pair, alternate] = await Promise.all([
    generateKeyPair('RS256'),
    generateKeyPair('RS256'),
  ]);
  key = {
    ...(await exportJWK(pair.publicKey)),
    kid: 'primary',
    alg: 'RS256',
    use: 'sig',
  };
  alternateKey = {
    ...(await exportJWK(alternate.publicKey)),
    kid: 'primary',
    alg: 'RS256',
    use: 'sig',
  };
});

beforeEach(async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mode = 'healthy';
  lookups = 0;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  jwks = Fastify({ logger: false, forceCloseConnections: true });
  jwks.get('/jwks', async (request, reply) => {
    lookups++;
    const current = mode;
    if (current === 'held-http') await stalled;
    if (current === 'http' || current === 'held-http')
      return reply.code(503).send('private-provider-response-marker');
    if (current === 'invalid-json')
      return reply.type('application/json').send('private-invalid-json-marker');
    if (current === 'invalid-set')
      return { private_provider_marker: 'private-provider-document-marker' };
    if (current === 'invalid-key')
      return {
        keys: [{ kty: 'RSA', kid: 'primary', e: 'AQAB', alg: 'RS256' }],
      };
    if (current === 'reset') {
      reply.hijack();
      request.raw.socket.destroy();
      return reply;
    }
    if (current === 'timeout') await stalled;
    return { keys: current === 'multiple' ? [alternateKey, key] : [key] };
  });
  const base = await jwks.listen({ host: '127.0.0.1', port: 0 });
  db = new Database('postgres://unused:unused@127.0.0.1:1/unused');
  vi.spyOn(db, 'assertReady').mockResolvedValue(undefined);
  vi.spyOn(db, 'identify').mockResolvedValue(randomUUID());
  app = await createServer(db, {
    mode: 'oidc',
    host: '127.0.0.1',
    issuer,
    audience: 'notes',
    jwksUrl: `${base}/jwks`,
    requiredScope: 'notes:read',
  });
});

afterEach(async () => {
  release?.();
  try {
    await app?.close();
  } finally {
    try {
      await jwks?.close();
    } finally {
      try {
        await db?.close();
      } finally {
        vi.restoreAllMocks();
      }
    }
  }
});

async function token(claims: JWTPayload = {}, kid = 'primary') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: 'notes',
    sub: subject,
    iat: now,
    exp: now + 300,
    scope: 'notes:read',
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .sign(pair.privateKey);
}

function request(value: string) {
  return app.inject({
    url: '/v1/me?private=private-query-marker',
    headers: { authorization: `Bearer ${value}` },
  });
}

function forge(value: string) {
  const offset = value.lastIndexOf('.') + 1;
  return `${value.slice(0, offset)}${value[offset] === 'A' ? 'B' : 'A'}${value.slice(offset + 1)}`;
}

async function unavailable(value: string) {
  const response = await request(value);
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({
    code: 'identity_provider_unavailable',
    message:
      'The identity provider keys are temporarily unavailable. Retry this request.',
    retryable: true,
    request_id: response.headers['x-request-id'],
  });
  expect(response.headers).toMatchObject({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  expect(response.headers['www-authenticate']).toBeUndefined();
  expect(db.identify).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(
    JSON.stringify({
      code: 'identity_provider_unavailable',
      request_id: response.json().request_id,
    }),
  );
  const diagnostic = JSON.stringify([
    vi.mocked(process.stdout.write).mock.calls,
    vi.mocked(console.error).mock.calls,
    response.body,
  ]);
  expect(diagnostic).not.toContain('private-');
  expect(diagnostic).not.toContain(value);
}

it.each(['http', 'invalid-json', 'invalid-set', 'reset'] as const)(
  'fails closed with a retryable key-service error on %s and recovers on the same resolver',
  async (failure) => {
    mode = failure;
    const value = await token();
    await unavailable(value);
    expect(lookups).toBeGreaterThan(0);
    const failedLookups = lookups;
    mode = 'healthy';
    expect((await request(value)).statusCode).toBe(200);
    expect(lookups).toBe(failedLookups + 1);
    expect(db.identify).toHaveBeenCalledExactlyOnceWith(issuer, subject);
  },
);

it('does not bypass the existing key cache when a selected key cannot be imported', async () => {
  mode = 'invalid-key';
  const value = await token();
  await unavailable(value);
  mode = 'healthy';
  await unavailable(value);
  expect(lookups).toBe(1);
});

it('shares a failing in-flight key fetch and permits a shared recovery fetch', async () => {
  mode = 'held-http';
  const value = await token();
  const pending = Promise.all(Array.from({ length: 8 }, () => request(value)));
  await vi.waitFor(() => expect(lookups).toBe(1));
  release();
  const failed = await pending;
  for (const response of failed) {
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: 'identity_provider_unavailable',
      retryable: true,
    });
  }
  expect(lookups).toBe(1);
  expect(db.identify).not.toHaveBeenCalled();
  mode = 'healthy';
  const recovered = await Promise.all(
    Array.from({ length: 8 }, () => request(value)),
  );
  expect(recovered.map((response) => response.statusCode)).toEqual(
    Array(8).fill(200),
  );
  expect(lookups).toBe(2);
  expect(db.identify).toHaveBeenCalledTimes(8);
});

it('enforces the real five-second key-fetch deadline and then recovers without recreating the API', async () => {
  mode = 'timeout';
  const value = await token();
  const started = performance.now();
  await unavailable(value);
  expect(performance.now() - started).toBeGreaterThanOrEqual(4800);
  expect(lookups).toBe(1);
  release();
  mode = 'healthy';
  expect((await request(value)).statusCode).toBe(200);
  expect(lookups).toBe(2);
  expect(db.identify).toHaveBeenCalledExactlyOnceWith(issuer, subject);
}, 15_000);

it('continues verifying fresh cached keys during an outage without fetching or trusting an unknown kid', async () => {
  const value = await token();
  expect((await request(value)).statusCode).toBe(200);
  mode = 'http';
  expect((await request(value)).statusCode).toBe(200);
  expect((await request(forge(value))).statusCode).toBe(401);
  const unknown = await request(await token({}, 'unknown'));
  expect(unknown.statusCode).toBe(401);
  expect(unknown.json()).toMatchObject({
    code: 'unauthorized',
    retryable: false,
  });
  expect(lookups).toBe(1);
  expect(db.identify).toHaveBeenCalledTimes(2);
});

it('preserves rejection of ambiguous matching keys instead of treating them as a key-service outage', async () => {
  mode = 'multiple';
  const value = await token();
  expect((await request(value)).statusCode).toBe(401);
  expect((await request(forge(value))).statusCode).toBe(401);
  expect(lookups).toBe(1);
  expect(db.identify).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
});

it('keeps a healthy key set without the requested kid an invalid credential, not an outage', async () => {
  const response = await request(await token({}, 'unknown'));
  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({
    code: 'unauthorized',
    retryable: false,
  });
  expect(response.headers['www-authenticate']).toBe('Bearer');
  expect(lookups).toBe(1);
  expect(db.identify).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
});

it.each([
  { name: 'issuer', claims: { iss: 'https://other.example.test' } },
  { name: 'audience', claims: { aud: 'another-api' } },
  { name: 'expiration', claims: { exp: 1 } },
  { name: 'scope', claims: { scope: 'notes:other' } },
])('preserves nonretryable 401 for invalid $name', async ({ claims }) => {
  const response = await request(await token(claims));
  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({
    code: 'unauthorized',
    retryable: false,
  });
  expect(response.headers['www-authenticate']).toBe('Bearer');
  expect(db.identify).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
});

it('does not fetch keys or grant a principal for a malformed token during an outage', async () => {
  mode = 'http';
  expect((await request('private-invalid-token-marker')).statusCode).toBe(401);
  expect(lookups).toBe(0);
  expect(db.identify).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
});
