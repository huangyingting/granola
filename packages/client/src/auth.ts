import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createLocalJWKSet, jwtVerify, errors, type JWTPayload } from 'jose';
import { z } from 'zod';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import {
  oidcClientConfigurationSchema,
  type OidcClientConfiguration,
} from '@windows-ai-notes/contracts/server';
import { LocalError, LocalStore } from '@windows-ai-notes/local';
import { ApiClient, ClientError, responseJson, serverUrl } from './http.js';

const opaque = z
  .string()
  .min(1)
  .max(32_768)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const jwt = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const metadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
  revocation_endpoint: z.string().optional(),
  response_types_supported: z.array(z.string()),
  id_token_signing_alg_values_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});
type Metadata = z.infer<typeof metadataSchema>;
const tokenResponseSchema = z.object({
  access_token: jwt.max(8185),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: opaque.optional(),
  id_token: jwt.max(16_384).optional(),
});
const tokenSetSchema = z.strictObject({
  access_token: jwt.max(8185),
  refresh_token: opaque,
  subject: z.string().min(1).max(1024),
  id_subject: z.string().min(1).max(1024),
  login_nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expires_at: z.number().int().positive(),
});
export type TokenSet = z.infer<typeof tokenSetSchema>;
const sessionSchema = z.discriminatedUnion('status', [
  tokenSetSchema.extend({ status: z.literal('active') }),
  z.strictObject({
    status: z.enum(['refreshing', 'reauth_required']),
    subject: z.string().min(1).max(1024),
    id_subject: z.string().min(1).max(1024),
  }),
]);
type Session = z.infer<typeof sessionSchema>;
export type SessionSummary = {
  status: 'signed_out' | 'active' | 'reauth_required';
  subject: string | null;
};

function same(left: unknown, right: string): boolean {
  if (typeof left !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function endpoint(value: string, allowLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClientError(
      'invalid_oidc_configuration',
      'The identity service advertised an invalid endpoint.',
    );
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        allowLoopback &&
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ))
  )
    throw new ClientError(
      'invalid_oidc_configuration',
      'Identity endpoints must use HTTPS without embedded credentials.',
    );
  return url;
}
export function clientConfiguration(
  service: string,
  allowLoopback = false,
  signal?: AbortSignal,
) {
  return new ApiClient(service, async () => ({}), { allowLoopback }).request(
    '/v1/client-config',
    oidcClientConfigurationSchema,
    signal ? { signal } : {},
  );
}
export class OidcClient {
  readonly configuration: OidcClientConfiguration;
  private metadataCache: { value: Metadata; until: number } | null = null;
  private keys: {
    url: string;
    verify: ReturnType<typeof createLocalJWKSet>;
    until: number;
  } | null = null;
  constructor(
    configuration: OidcClientConfiguration,
    private readonly allowLoopback = false,
  ) {
    this.configuration = oidcClientConfigurationSchema.parse(configuration);
    const issuer = endpoint(configuration.issuer, allowLoopback);
    if (issuer.search)
      throw new ClientError(
        'invalid_oidc_configuration',
        'The issuer cannot contain a query string.',
      );
  }
  private async fetch(
    url: URL,
    signal: AbortSignal,
    form?: URLSearchParams,
  ): Promise<Response> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        method: form ? 'POST' : 'GET',
        redirect: 'manual',
        signal: bounded,
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(form
            ? { 'Content-Type': 'application/x-www-form-urlencoded' }
            : {}),
        },
        ...(form ? { body: form.toString() } : {}),
      });
    } catch {
      throw new ClientError(
        bounded.aborted
          ? 'authentication_cancelled'
          : 'identity_service_unavailable',
        bounded.aborted
          ? 'Sign-in was cancelled or timed out.'
          : 'The identity service could not be reached.',
        0,
        true,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ClientError(
        response.status >= 300 && response.status < 400
          ? 'identity_redirect_rejected'
          : 'identity_request_rejected',
        'The identity service rejected or redirected this operation.',
        response.status,
        response.status >= 500 || response.status === 429,
      );
    }
    return response;
  }
  private async metadata(signal: AbortSignal): Promise<Metadata> {
    if (this.metadataCache && this.metadataCache.until > Date.now())
      return this.metadataCache.value;
    const issuer = this.configuration.issuer;
    const value = await responseJson(
      await this.fetch(
        endpoint(
          `${issuer.replace(/\/$/u, '')}/.well-known/openid-configuration`,
          this.allowLoopback,
        ),
        signal,
      ),
      metadataSchema,
      65_536,
    );
    if (
      value.issuer !== issuer ||
      !value.response_types_supported.includes('code') ||
      !value.id_token_signing_alg_values_supported.includes('RS256') ||
      (value.code_challenge_methods_supported &&
        !value.code_challenge_methods_supported.includes('S256'))
    )
      throw new ClientError(
        'invalid_oidc_configuration',
        'The identity service does not match the configured issuer or required code/PKCE capabilities.',
      );
    for (const url of [
      value.authorization_endpoint,
      value.token_endpoint,
      value.jwks_uri,
      ...(value.revocation_endpoint ? [value.revocation_endpoint] : []),
    ])
      endpoint(url, this.allowLoopback);
    this.metadataCache = { value, until: Date.now() + 300_000 };
    return value;
  }
  private async verifier(signal: AbortSignal, force = false) {
    const metadata = await this.metadata(signal);
    if (
      force ||
      !this.keys ||
      this.keys.url !== metadata.jwks_uri ||
      this.keys.until <= Date.now()
    ) {
      const jwks = await responseJson(
        await this.fetch(
          endpoint(metadata.jwks_uri, this.allowLoopback),
          signal,
        ),
        z.strictObject({
          keys: z.array(z.record(z.string(), z.unknown())).min(1).max(32),
        }),
        131_072,
      );
      if (
        jwks.keys.some((key) =>
          ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some(
            (field) => field in key,
          ),
        )
      )
        throw new ClientError(
          'invalid_oidc_configuration',
          'The identity service did not return a public verification-key set.',
        );
      this.keys = {
        url: metadata.jwks_uri,
        verify: createLocalJWKSet(jwks),
        until: Date.now() + 600_000,
      };
    }
    return this.keys.verify;
  }
  private async claims(
    token: string,
    audience: string,
    signal: AbortSignal,
  ): Promise<JWTPayload> {
    const options = {
      issuer: this.configuration.issuer,
      audience,
      algorithms: ['RS256'],
      requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat'],
      clockTolerance: 30,
    };
    const verify = async (key: ReturnType<typeof createLocalJWKSet>) => {
      const { payload } = await jwtVerify(token, key, options);
      if (
        typeof payload.iat !== 'number' ||
        payload.iat > Math.floor(Date.now() / 1000) + 30
      )
        throw new ClientError(
          'invalid_identity_token',
          'The identity token has an invalid issuance time.',
          401,
        );
      return payload;
    };
    try {
      let key = await this.verifier(signal);
      try {
        return await verify(key);
      } catch (error) {
        if (!(
          error instanceof errors.JWKSNoMatchingKey ||
          error instanceof errors.JWSSignatureVerificationFailed
        ))
          throw error;
        key = await this.verifier(signal, true);
        return await verify(key);
      }
    } catch (error) {
      if (error instanceof ClientError) throw error;
      if (!(error instanceof errors.JOSEError)) throw error;
      throw new ClientError(
        'invalid_identity_token',
        'The identity token failed signature, issuer, audience or time validation.',
        401,
      );
    }
  }
  private async tokens(
    response: z.infer<typeof tokenResponseSchema>,
    nonce: string,
    signal: AbortSignal,
    previous?: TokenSet,
  ): Promise<TokenSet> {
    const access = await this.claims(
      response.access_token,
      this.configuration.audience,
      signal,
    );
    const scopes =
      typeof access.scp === 'string'
        ? access.scp
        : typeof access.scope === 'string'
          ? access.scope
          : '';
    if (
      !access.sub ||
      !scopes.split(' ').includes(this.configuration.required_scope) ||
      (access.azp !== undefined &&
        access.azp !== this.configuration.client_id) ||
      (access.appid !== undefined &&
        access.appid !== this.configuration.client_id) ||
      (previous && access.sub !== previous.subject)
    )
      throw new ClientError(
        'invalid_identity_token',
        'The access token does not match this application, account or required scope.',
        401,
      );
    let idSubject = previous?.id_subject;
    if (response.id_token) {
      const identity = await this.claims(
        response.id_token,
        this.configuration.client_id,
        signal,
      );
      if (
        !identity.sub ||
        (identity.azp !== undefined &&
          identity.azp !== this.configuration.client_id) ||
        (Array.isArray(identity.aud) &&
          identity.aud.length > 1 &&
          identity.azp !== this.configuration.client_id) ||
        ((!previous || identity.nonce !== undefined) &&
          !same(identity.nonce, nonce)) ||
        (previous && identity.sub !== previous.id_subject) ||
        (identity.at_hash !== undefined &&
          !same(
            identity.at_hash,
            createHash('sha256')
              .update(response.access_token)
              .digest()
              .subarray(0, 16)
              .toString('base64url'),
          ))
      )
        throw new ClientError(
          'invalid_identity_token',
          'The ID token does not match this login, application or account.',
          401,
        );
      idSubject = identity.sub;
    } else if (!previous)
      throw new ClientError(
        'invalid_identity_token',
        'The identity service did not return an ID token.',
        401,
      );
    const refresh = response.refresh_token ?? previous?.refresh_token;
    if (!refresh)
      throw new ClientError(
        'refresh_not_issued',
        'The identity service did not grant offline access. Check the native-client registration.',
      );
    const expires = Math.floor(
      Math.min(access.exp! * 1000, Date.now() + response.expires_in * 1000),
    );
    if (expires <= Date.now() + 15_000)
      throw new ClientError(
        'invalid_identity_token',
        'The access token expires too soon to use.',
        401,
      );
    return tokenSetSchema.parse({
      access_token: response.access_token,
      refresh_token: refresh,
      subject: access.sub,
      id_subject: idSubject,
      login_nonce: nonce,
      expires_at: expires,
    });
  }
  async authorize(
    openBrowser: (url: string) => Promise<void>,
    external: AbortSignal,
  ): Promise<TokenSet> {
    const signal = AbortSignal.any([external, AbortSignal.timeout(180_000)]);
    const metadata = await this.metadata(signal);
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    let accepted = false;
    let resolveCode!: (value: string) => void;
    let rejectCode!: (error: unknown) => void;
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    // Attach a handler before opening the browser, which may finish or cancel asynchronously.
    void code.catch(() => undefined);
    let redirect: URL | null = null;
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (!redirect) {
        response.writeHead(503);
        response.end('Callback not ready.');
        return;
      }
      let callback: URL;
      try {
        callback = new URL(request.url ?? '', redirect);
      } catch {
        response.writeHead(400);
        response.end('Invalid callback.');
        return;
      }
      if (
        accepted ||
        request.method !== 'GET' ||
        request.headers.host !== redirect.host ||
        callback.origin !== redirect.origin ||
        callback.pathname !== redirect.pathname ||
        request.headers['transfer-encoding'] ||
        Number(request.headers['content-length'] ?? 0) !== 0 ||
        callback.searchParams.getAll('state').length !== 1 ||
        !same(callback.searchParams.get('state'), state)
      ) {
        response.writeHead(400);
        response.end('Invalid callback.');
        return;
      }
      const codes = callback.searchParams.getAll('code');
      const denied = callback.searchParams.has('error');
      if (denied || codes.length !== 1 || !codes[0] || codes[0].length > 4096) {
        accepted = true;
        response.writeHead(400);
        response.end('Sign-in was not completed. Return to Windows AI Notes.');
        rejectCode(
          new ClientError(
            'authorization_denied',
            'Sign-in was not completed. Return to the app and try again.',
            401,
          ),
        );
        return;
      }
      accepted = true;
      response.end(
        '<!doctype html><title>Sign-in complete</title><h1>Sign-in complete</h1><p>You can return to Windows AI Notes and close this tab.</p>',
      );
      resolveCode(codes[0]);
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 5000;
    server.keepAliveTimeout = 1000;
    const abort = () =>
      rejectCode(
        new ClientError(
          'authentication_cancelled',
          'Sign-in was cancelled or timed out.',
        ),
      );
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening', { signal });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new ClientError(
          'callback_unavailable',
          'The local sign-in callback could not start.',
        );
      redirect = new URL(
        `http://${this.configuration.loopback_host}:${address.port}/oauth/callback`,
      );
      const url = endpoint(metadata.authorization_endpoint, this.allowLoopback);
      for (const [key, value] of Object.entries({
        client_id: this.configuration.client_id,
        redirect_uri: redirect.href,
        response_type: 'code',
        scope: this.configuration.scope,
        state,
        nonce,
        code_challenge: createHash('sha256')
          .update(verifier)
          .digest('base64url'),
        code_challenge_method: 'S256',
        response_mode: 'query',
      }))
        url.searchParams.set(key, value);
      await Promise.race([openBrowser(url.href), code.then(() => undefined)]);
      const authorizationCode = await code;
      const response = await responseJson(
        await this.fetch(
          endpoint(metadata.token_endpoint, this.allowLoopback),
          signal,
          new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: this.configuration.client_id,
            code: authorizationCode,
            code_verifier: verifier,
            redirect_uri: redirect.href,
          }),
        ),
        tokenResponseSchema,
        65_536,
      );
      return await this.tokens(response, nonce, signal);
    } finally {
      signal.removeEventListener('abort', abort);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }
  async refresh(
    previous: TokenSet,
    signal: AbortSignal,
    beforeRequest: () => void,
  ): Promise<TokenSet> {
    const metadata = await this.metadata(signal);
    await this.verifier(signal);
    signal.throwIfAborted();
    beforeRequest();
    const response = await responseJson(
      await this.fetch(
        endpoint(metadata.token_endpoint, this.allowLoopback),
        signal,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.configuration.client_id,
          refresh_token: previous.refresh_token,
          scope: this.configuration.scope,
        }),
      ),
      tokenResponseSchema,
      65_536,
    );
    return this.tokens(response, previous.login_nonce, signal, previous);
  }
  async revoke(refreshToken: string, signal: AbortSignal): Promise<boolean> {
    const metadata = await this.metadata(signal);
    if (!metadata.revocation_endpoint) return false;
    const response = await this.fetch(
      endpoint(metadata.revocation_endpoint, this.allowLoopback),
      signal,
      new URLSearchParams({
        token: refreshToken,
        token_type_hint: 'refresh_token',
        client_id: this.configuration.client_id,
      }),
    );
    await response.body?.cancel();
    return true;
  }
}
export class AccountSession {
  private operation: AbortController | null = null;
  private generation = 0;
  private refreshing: Promise<string> | null = null;
  readonly profile: string;
  constructor(
    private readonly local: LocalStore,
    private readonly oidc: OidcClient,
    service: string,
    allowLoopback = false,
  ) {
    this.profile = `credentials:${createHash('sha256')
      .update(
        canonicalJson([serverUrl(service, allowLoopback), oidc.configuration]),
      )
      .digest('hex')}`;
  }
  private read(): Session | null {
    return this.local.getValue(this.profile, 'session', sessionSchema);
  }
  summary(): SessionSummary {
    const value = this.read();
    return value
      ? {
          status: value.status === 'active' ? 'active' : 'reauth_required',
          subject: value.subject,
        }
      : { status: 'signed_out', subject: null };
  }
  cancel() {
    this.generation++;
    this.operation?.abort();
    this.operation = null;
    this.refreshing = null;
  }
  async signIn(
    openBrowser: (url: string) => Promise<void>,
  ): Promise<SessionSummary> {
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.operation = controller;
    try {
      const tokens = await this.oidc.authorize(openBrowser, controller.signal);
      if (generation !== this.generation)
        throw new ClientError(
          'authentication_cancelled',
          'This sign-in attempt is no longer active.',
        );
      this.local.putValue(this.profile, 'session', {
        ...tokens,
        status: 'active',
      });
      return this.summary();
    } finally {
      if (generation === this.generation) this.operation = null;
    }
  }
  authorization(forceRefresh = false): Promise<string> {
    if (this.refreshing) return this.refreshing;
    if (this.operation)
      return Promise.reject(
        new ClientError(
          'authentication_in_progress',
          'Finish or cancel the current sign-in attempt.',
        ),
      );
    const current = this.read();
    if (!current || current.status !== 'active')
      return Promise.reject(
        new ClientError(
          'reauthentication_required',
          'Sign in again to reconnect this account.',
          401,
        ),
      );
    if (!forceRefresh && current.expires_at > Date.now() + 60_000)
      return Promise.resolve(`Bearer ${current.access_token}`);
    const generation = this.generation;
    const controller = new AbortController();
    this.operation = controller;
    let requested = false;
    const work = this.oidc
      .refresh(current, controller.signal, () => {
        if (generation !== this.generation)
          throw new ClientError(
            'authentication_cancelled',
            'The account changed while refreshing.',
          );
        this.local.putValue(this.profile, 'session', {
          status: 'refreshing',
          subject: current.subject,
          id_subject: current.id_subject,
        });
        requested = true;
      })
      .then((tokens) => {
        if (generation !== this.generation)
          throw new ClientError(
            'authentication_cancelled',
            'The account changed while refreshing.',
          );
        this.local.putValue(this.profile, 'session', {
          ...tokens,
          status: 'active',
        });
        return `Bearer ${tokens.access_token}`;
      })
      .catch((error: unknown) => {
        if (generation === this.generation && requested)
          this.local.putValue(this.profile, 'session', {
            status: 'reauth_required',
            subject: current.subject,
            id_subject: current.id_subject,
          });
        throw error;
      })
      .finally(() => {
        if (this.refreshing === work) this.refreshing = null;
        if (generation === this.generation) this.operation = null;
      });
    this.refreshing = work;
    return work;
  }
  async logout(
    beforeForget: () => undefined = () => undefined,
    signal: AbortSignal = AbortSignal.timeout(20_000),
  ): Promise<{
    remote: 'revoked' | 'unsupported' | 'unconfirmed';
  }> {
    let current: Session | null = null;
    let unreadable = false;
    try {
      current = this.read();
    } catch (error) {
      if (!(error instanceof LocalError)) throw error;
      unreadable = true;
    }
    this.cancel();
    this.local.atomic(() => {
      beforeForget();
      this.local.deleteValue(this.profile, 'session');
    });
    if (unreadable) return { remote: 'unconfirmed' };
    if (!current || current.status !== 'active')
      return { remote: current ? 'unconfirmed' : 'unsupported' };
    try {
      const revoked = await this.oidc.revoke(
        current.refresh_token,
        AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      );
      return { remote: revoked ? 'revoked' : 'unsupported' };
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      return { remote: 'unconfirmed' };
    }
  }
}
