import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as tick } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStore } from '@windows-ai-notes/local';
import { createServer } from '@windows-ai-notes/api/server';
import { Database } from '@windows-ai-notes/db';
import { AccountSession, clientConfiguration, OidcClient } from './auth.js';
import { ApiClient } from './http.js';
import { oidcFixture } from './oidc.fixture.js';

describe('native OIDC code/PKCE and encrypted rotating credentials', () => {
  let fixture: Awaited<ReturnType<typeof oidcFixture>>;
  let directory: string;
  let local: LocalStore;
  let session: AccountSession;
  let oidc: OidcClient;
  let key: Buffer;
  beforeEach(async () => {
    fixture = await oidcFixture();
    directory = mkdtempSync(join(tmpdir(), 'windows-notes-oidc-'));
    key = randomBytes(32);
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
    oidc = new OidcClient(fixture.configuration, true);
    session = new AccountSession(local, oidc, 'https://notes.example.test');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    session?.cancel();
    await fixture?.close();
    local?.close();
    key?.fill(0);
    rmSync(directory, { recursive: true, force: true });
    expect(fixture.state.failures).toEqual([]);
  });
  it('uses the real loopback browser redirect, S256, signed tokens and an encrypted main-only session across restart', async () => {
    const result = await session.signIn(fixture.browser);
    expect(result).toEqual({
      status: 'active',
      subject: fixture.state.subject,
    });
    const authorization = await session.authorization();
    expect(authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(fixture.state.tokenCalls).toBe(1);
    expect(fixture.state.submittedFields[0]).toEqual([
      'grant_type',
      'client_id',
      'code',
      'code_verifier',
      'redirect_uri',
    ]);
    expect(
      readFileSync(join(directory, 'notes.sqlite-wal')).includes(
        Buffer.from(authorization.slice(7)),
      ),
    ).toBe(false);
    local.close();
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
    session = new AccountSession(
      local,
      new OidcClient(fixture.configuration, true),
      'https://notes.example.test',
    );
    expect(await session.authorization()).toBe(authorization);
    expect(session.summary().status).toBe('active');
  });
  it.each([
    'nonce',
    'id_audience',
    'access_audience',
    'issuer',
    'scope',
    'expired',
    'future_iat',
    'at_hash',
    'missing_id',
    'azp',
    'signature',
    'algorithm',
  ] as const)(
    'rejects a real signed-provider response with invalid %s without persisting a session',
    async (fault) => {
      fixture.state.fault = fault;
      await expect(session.signIn(fixture.browser)).rejects.toMatchObject({
        code: 'invalid_identity_token',
      });
      expect(session.summary().status).toBe('signed_out');
    },
  );
  it('does not pretend offline refresh is available when the issuer omits the refresh grant', async () => {
    fixture.state.fault = 'missing_refresh';
    await expect(session.signIn(fixture.browser)).rejects.toMatchObject({
      code: 'refresh_not_issued',
    });
    expect(session.summary().status).toBe('signed_out');
  });
  it('rejects wrong state, duplicate state and callback paths without consuming the legitimate sign-in attempt', async () => {
    await session.signIn(async (url) => {
      const authorization = new URL(url);
      const redirect = new URL(authorization.searchParams.get('redirect_uri')!);
      const state = authorization.searchParams.get('state')!;
      const wrong = new URL(redirect);
      wrong.searchParams.set('state', 'incorrect');
      wrong.searchParams.set('code', 'not-issued');
      expect((await fetch(wrong)).status).toBe(400);
      wrong.searchParams.set('state', state);
      wrong.searchParams.append('state', state);
      expect((await fetch(wrong)).status).toBe(400);
      const path = new URL('/unexpected', redirect);
      path.searchParams.set('state', state);
      path.searchParams.set('code', 'not-issued');
      expect((await fetch(path)).status).toBe(400);
      await fixture.browser(url);
    });
    expect(session.summary().status).toBe('active');
    expect(fixture.state.tokenCalls).toBe(1);
  });
  it('handles user denial without accepting callback-supplied tokens', async () => {
    await expect(
      session.signIn(async (url) => {
        const query = new URL(url).searchParams;
        const redirect = new URL(query.get('redirect_uri')!);
        redirect.searchParams.set('state', query.get('state')!);
        redirect.searchParams.set('error', 'access_denied');
        redirect.searchParams.set('access_token', 'not-a-login');
        expect((await fetch(redirect)).status).toBe(400);
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(fixture.state.tokenCalls).toBe(0);
    expect(session.summary().status).toBe('signed_out');
  });
  it('closes its loopback listener on cancellation and never writes credentials after cancellation', async () => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let redirect = '';
    const signing = session.signIn(async (url) => {
      redirect = new URL(url).searchParams.get('redirect_uri')!;
      ready();
    });
    const rejection = expect(signing).rejects.toMatchObject({
      code: 'authentication_cancelled',
    });
    await started;
    session.cancel();
    await rejection;
    await expect(fetch(redirect)).rejects.toThrow();
    expect(session.summary().status).toBe('signed_out');
  });
  it('cancels and closes the callback even if the system-browser opener never resolves', async () => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const signing = session.signIn(async () => {
      ready();
      await new Promise<void>(() => {});
    });
    const rejection = expect(signing).rejects.toMatchObject({
      code: 'authentication_cancelled',
    });
    await started;
    session.cancel();
    await rejection;
    expect(session.summary().status).toBe('signed_out');
  });
  it('rotates refresh credentials once for concurrent callers and accepts a real signing-key rollover', async () => {
    await session.signIn(fixture.browser);
    await fixture.rotate();
    const first = session.authorization(true);
    expect(session.authorization(true)).toBe(first);
    const header = await first;
    expect(header).toMatch(/^Bearer /);
    expect(fixture.state.refreshCalls).toBe(1);
    expect(fixture.state.jwksCalls).toBe(2);
    expect(await session.logout()).toEqual({ remote: 'revoked' });
    expect(fixture.state.revoked).toHaveLength(1);
    expect(session.summary().status).toBe('signed_out');
    await expect(session.authorization()).rejects.toMatchObject({
      code: 'reauthentication_required',
    });
  });
  it('cancels one API credential wait without cancelling a shared provider-committed refresh', async () => {
    await session.signIn(fixture.browser);
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const refresh = oidc.refresh.bind(oidc);
    let refreshSignal: AbortSignal | undefined;
    vi.spyOn(oidc, 'refresh').mockImplementation(async (...args) => {
      refreshSignal = args[1];
      const tokens = await refresh(...args);
      reached();
      await held;
      return tokens;
    });
    const nativeFetch = globalThis.fetch;
    const dispatched: (string | null)[] = [];
    const id = randomUUID();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => {
      if (input === 'https://notes.example.test/v1/me') {
        dispatched.push(new Headers(options?.headers).get('Authorization'));
        return Promise.resolve(Response.json({ id }));
      }
      return nativeFetch(input, options);
    });
    const client = new ApiClient('https://notes.example.test', async () => ({
      Authorization: await session.authorization(),
    }));
    const refreshing = session.authorization(true);
    const observers: Promise<unknown>[] = [refreshing];
    const cancelled = new AbortController();
    const firstResolved = vi.fn();
    const firstRejected = vi.fn();
    const secondResolved = vi.fn();
    const secondRejected = vi.fn();
    try {
      await Promise.race([ready, refreshing]);
      observers.push(
        client.identity(cancelled.signal).then(firstResolved, firstRejected),
        client.identity().then(secondResolved, secondRejected),
      );
      cancelled.abort();
      await tick();
      expect(firstRejected).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'request_cancelled' }),
      );
      expect(firstResolved).not.toHaveBeenCalled();
      expect(secondResolved).not.toHaveBeenCalled();
      expect(secondRejected).not.toHaveBeenCalled();
      expect(refreshSignal?.aborted).toBe(false);
      expect(fixture.state.refreshCalls).toBe(1);
      expect(dispatched).toEqual([]);
    } finally {
      release();
      await Promise.allSettled(observers);
    }
    expect(firstRejected).toHaveBeenCalledTimes(1);
    expect(secondResolved).toHaveBeenCalledExactlyOnceWith({ id });
    expect(secondRejected).not.toHaveBeenCalled();
    expect(dispatched).toEqual([await session.authorization()]);
    expect(session.summary().status).toBe('active');
    expect(fixture.state.refreshCalls).toBe(1);
  });
  it('never replays a rotating refresh after an uncertain committed response, including across restart', async () => {
    await session.signIn(fixture.browser);
    const fetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const response = await fetch(url, options);
      if (String(options?.body).includes('grant_type=refresh_token')) {
        await response.arrayBuffer();
        throw new TypeError('Synthetic lost refresh response.');
      }
      return response;
    });
    await expect(session.authorization(true)).rejects.toMatchObject({
      code: 'identity_service_unavailable',
    });
    expect(session.summary().status).toBe('reauth_required');
    local.close();
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
    session = new AccountSession(
      local,
      new OidcClient(fixture.configuration, true),
      'https://notes.example.test',
    );
    await expect(session.authorization()).rejects.toMatchObject({
      code: 'reauthentication_required',
    });
    expect(fixture.state.refreshCalls).toBe(1);
  });
  it('reuses fresh verification keys but expires their original ten-minute lease despite successful token refreshes', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    await session.signIn(fixture.browser);
    expect(fixture.state.jwksCalls).toBe(1);
    vi.setSystemTime(now + 600_000 - 1);
    await session.authorization(true);
    expect(fixture.state.jwksCalls).toBe(1);
    vi.setSystemTime(now + 600_000);
    await session.authorization(true);
    expect(fixture.state.jwksCalls).toBe(2);
    expect(fixture.state.refreshCalls).toBe(2);
    expect(session.summary().status).toBe('active');
  });
  it('rejects tokens signed by a retired key after cache expiry and never replays the consumed refresh', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    await session.signIn(fixture.browser);
    local.create('offline');
    await fixture.rotate(true);
    vi.setSystemTime(now + 600_000);
    await expect(session.authorization(true)).rejects.toMatchObject({
      code: 'invalid_identity_token',
      status: 401,
    });
    expect(fixture.state.jwksCalls).toBeGreaterThan(1);
    expect(fixture.state.refreshCalls).toBe(1);
    expect(session.summary()).toEqual({
      status: 'reauth_required',
      subject: fixture.state.subject,
    });
    await expect(session.authorization()).rejects.toMatchObject({
      code: 'reauthentication_required',
    });
    expect(fixture.state.refreshCalls).toBe(1);
    expect(local.list('offline')).toHaveLength(1);
  });
  it('checks expired verification keys before consuming a rotating refresh and safely retries after a key-service outage', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    await session.signIn(fixture.browser);
    const original = await session.authorization();
    local.create('offline');
    vi.setSystemTime(now + 600_000);
    fixture.state.keysRejected = true;
    await expect(session.authorization(true)).rejects.toMatchObject({
      code: 'identity_request_rejected',
      status: 503,
      retryable: true,
    });
    expect(fixture.state.refreshCalls).toBe(0);
    expect(session.summary().status).toBe('active');
    expect(await session.authorization()).toBe(original);
    local.close();
    local = new LocalStore(join(directory, 'notes.sqlite'), key);
    session = new AccountSession(
      local,
      new OidcClient(fixture.configuration, true),
      'https://notes.example.test',
    );
    expect(session.summary().status).toBe('active');
    fixture.state.keysRejected = false;
    await expect(session.authorization(true)).resolves.toMatch(/^Bearer /);
    expect(fixture.state.refreshCalls).toBe(1);
    expect(session.summary().status).toBe('active');
    expect(local.list('offline')).toHaveLength(1);
  });
  it('still fences a consumed refresh when a new signing key becomes unavailable after dispatch', async () => {
    await session.signIn(fixture.browser);
    local.create('offline');
    await fixture.rotate();
    fixture.state.keysRejected = true;
    await expect(session.authorization(true)).rejects.toMatchObject({
      code: 'identity_request_rejected',
      status: 503,
      retryable: true,
    });
    expect(session.summary().status).toBe('reauth_required');
    expect(fixture.state.refreshCalls).toBe(1);
    expect(fixture.state.jwksCalls).toBe(2);
    await expect(session.authorization(true)).rejects.toMatchObject({
      code: 'reauthentication_required',
    });
    expect(fixture.state.refreshCalls).toBe(1);
    expect(local.list('offline')).toHaveLength(1);
  });
  it('does not replace the account if a refresh produces a different subject', async () => {
    await session.signIn(fixture.browser);
    fixture.state.fault = 'subject';
    await expect(session.authorization(true)).rejects.toMatchObject({
      code: 'invalid_identity_token',
    });
    expect(session.summary()).toEqual({
      status: 'reauth_required',
      subject: fixture.state.subject,
    });
  });
  it('preserves refresh credentials if discovery fails before any refresh request is sent', async () => {
    await session.signIn(fixture.browser);
    session = new AccountSession(
      local,
      new OidcClient(fixture.configuration, true),
      'https://notes.example.test',
    );
    const fetch = globalThis.fetch;
    const unavailable = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url, options) => {
        if (String(url).endsWith('/.well-known/openid-configuration'))
          throw new TypeError('Synthetic offline discovery.');
        return fetch(url, options);
      });
    await expect(session.authorization(true)).rejects.toMatchObject({
      code: 'identity_service_unavailable',
    });
    expect(session.summary().status).toBe('active');
    expect(fixture.state.refreshCalls).toBe(0);
    unavailable.mockRestore();
    await session.authorization(true);
    expect(fixture.state.refreshCalls).toBe(1);
  });
  it('accepts a refresh without an optional ID token while retaining the verified ID subject', async () => {
    await session.signIn(fixture.browser);
    fixture.state.fault = 'missing_id';
    await expect(session.authorization(true)).resolves.toMatch(/^Bearer /);
    expect(session.summary()).toEqual({
      status: 'active',
      subject: fixture.state.subject,
    });
  });
  it('can clear an unreadable credential record explicitly without resetting local notes', async () => {
    local.create('offline');
    local.putValue(session.profile, 'session', {
      invalid: 'Synthetic corrupt credential record.',
    });
    expect(await session.logout()).toEqual({ remote: 'unconfirmed' });
    expect(session.summary().status).toBe('signed_out');
    expect(local.list('offline')).toHaveLength(1);
  });
  it('does not restore tokens when logout races a provider-committed refresh', async () => {
    await session.signIn(fixture.browser);
    let release!: () => void;
    let ready!: () => void;
    fixture.state.refreshGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    fixture.state.refreshStarted = ready;
    const refreshing = session.authorization(true);
    const rejection = expect(refreshing).rejects.toMatchObject({
      code: 'authentication_cancelled',
    });
    await started;
    expect(await session.logout()).toEqual({ remote: 'unconfirmed' });
    release();
    await rejection;
    expect(session.summary().status).toBe('signed_out');
    expect(
      new AccountSession(local, oidc, 'https://notes.example.test').summary()
        .status,
    ).toBe('signed_out');
  });
  it.each(['unsupported', 'unconfirmed'] as const)(
    'clears local credentials while reporting %s provider revocation explicitly',
    async (remote) => {
      fixture.state.revocationSupported = remote !== 'unsupported';
      fixture.state.revocationRejected = remote === 'unconfirmed';
      await session.signIn(fixture.browser);
      expect(await session.logout()).toEqual({ remote });
      expect(session.summary().status).toBe('signed_out');
    },
  );
  it('does not accept discovery from a different issuer or production HTTP endpoints', async () => {
    expect(() => new OidcClient(fixture.configuration)).toThrow('HTTPS');
    fixture.state.metadataIssuer = 'https://another.example.test/';
    await expect(session.signIn(fixture.browser)).rejects.toMatchObject({
      code: 'invalid_oidc_configuration',
    });
    expect(fixture.state.tokenCalls).toBe(0);
  });
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'authenticates the actual provisioned API using the public native-client configuration',
    async () => {
      const admin = new Database(process.env.TEST_DATABASE_URL!);
      const schema = `notes_oidc_${randomUUID().replaceAll('-', '')}`;
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      const db = new Database(url.href);
      let app: Awaited<ReturnType<typeof createServer>> | null = null;
      try {
        await db.migrate();
        const user = await db.provision(
          fixture.configuration.issuer,
          fixture.state.subject,
        );
        app = await createServer(db, {
          mode: 'oidc',
          host: '127.0.0.1',
          issuer: fixture.configuration.issuer,
          audience: fixture.configuration.audience,
          jwksUrl: `${fixture.state.issuer}keys`,
          requiredScope: 'notes.access',
          desktop: fixture.configuration,
        });
        const base = await app.listen({ host: '127.0.0.1', port: 0 });
        expect(await clientConfiguration(base, true)).toEqual(
          fixture.configuration,
        );
        session = new AccountSession(local, oidc, base, true);
        await session.signIn(fixture.browser);
        const api = new ApiClient(
          base,
          async () => ({ Authorization: await session.authorization() }),
          { allowLoopback: true },
        );
        expect(await api.identity()).toEqual({ id: user.user_id });
        expect(await api.workspaces()).toMatchObject({
          workspaces: [{ id: user.workspace_id }],
        });
        await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
          user.user_id,
        ]);
        await expect(api.identity()).rejects.toMatchObject({
          code: 'identity_not_provisioned',
          status: 403,
        });
      } finally {
        await app?.close();
        await db.close();
        await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      }
    },
  );
});
