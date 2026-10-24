import { createHash, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { OidcClientConfiguration } from '@windows-ai-notes/contracts/server';

type Fault =
  | 'none'
  | 'nonce'
  | 'id_audience'
  | 'access_audience'
  | 'issuer'
  | 'scope'
  | 'expired'
  | 'future_iat'
  | 'subject'
  | 'at_hash'
  | 'missing_id'
  | 'missing_refresh'
  | 'azp'
  | 'signature'
  | 'algorithm';
export async function oidcFixture() {
  let keys = await generateKeyPair('RS256');
  const invalidKeys = await generateKeyPair('RS256');
  let keyId = randomUUID();
  let publishedKeys = keys;
  let publishedKeyId = keyId;
  const codes = new Map<
    string,
    { nonce: string; challenge: string; redirect: string }
  >();
  const refreshes = new Map<string, { nonce: string }>();
  const state = {
    fault: 'none' as Fault,
    issuer: '',
    subject: randomUUID(),
    idSubject: `synthetic-id-${randomUUID()}`,
    tokenCalls: 0,
    refreshCalls: 0,
    jwksCalls: 0,
    keysRejected: false,
    failures: [] as unknown[],
    revoked: [] as string[],
    submittedFields: [] as string[][],
    refreshGate: null as Promise<void> | null,
    refreshStarted: null as (() => void) | null,
    metadataIssuer: null as string | null,
    revocationSupported: true,
    revocationRejected: false,
    revocationGate: null as Promise<void> | null,
    revocationStarted: null as (() => void) | null,
  };
  const clientId = 'synthetic-native-client';
  const audience = 'synthetic-notes-api';
  async function result(nonce: string) {
    const now = Math.floor(Date.now() / 1000);
    const access = await new SignJWT({
      scp: state.fault === 'scope' ? 'unrelated.scope' : 'notes.access',
      azp: state.fault === 'azp' ? 'another-native-client' : clientId,
    })
      .setProtectedHeader({
        alg: state.fault === 'algorithm' ? 'HS256' : 'RS256',
        kid: keyId,
      })
      .setIssuer(
        state.fault === 'issuer'
          ? 'https://incorrect.example.test/'
          : state.issuer,
      )
      .setAudience(state.fault === 'access_audience' ? 'wrong-api' : audience)
      .setSubject(state.fault === 'subject' ? randomUUID() : state.subject)
      .setIssuedAt(state.fault === 'future_iat' ? now + 300 : now)
      .setExpirationTime(state.fault === 'expired' ? now - 300 : now + 3600)
      .sign(
        state.fault === 'algorithm'
          ? Buffer.from('synthetic-hmac-test-key-32-bytes-only')
          : state.fault === 'signature'
            ? invalidKeys.privateKey
            : keys.privateKey,
      );
    const identity = await new SignJWT({
      nonce: state.fault === 'nonce' ? 'incorrect-nonce' : nonce,
      at_hash:
        state.fault === 'at_hash'
          ? 'incorrect-hash'
          : createHash('sha256')
              .update(access)
              .digest()
              .subarray(0, 16)
              .toString('base64url'),
    })
      .setProtectedHeader({ alg: 'RS256', kid: keyId })
      .setIssuer(state.issuer)
      .setAudience(
        state.fault === 'id_audience' ? 'another-native-client' : clientId,
      )
      .setSubject(state.idSubject)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(keys.privateKey);
    const refresh = `synthetic-refresh-${randomUUID()}`;
    refreshes.set(refresh, { nonce });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      ...(state.fault === 'missing_id' ? {} : { id_token: identity }),
      ...(state.fault === 'missing_refresh' ? {} : { refresh_token: refresh }),
    };
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Content-Type', 'application/json');
    const url = new URL(request.url!, state.issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      response.end(
        JSON.stringify({
          issuer: state.metadataIssuer ?? state.issuer,
          authorization_endpoint: `${state.issuer}authorize`,
          token_endpoint: `${state.issuer}token`,
          jwks_uri: `${state.issuer}keys`,
          ...(state.revocationSupported
            ? { revocation_endpoint: `${state.issuer}revoke` }
            : {}),
          response_types_supported: ['code'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
      return;
    }
    if (url.pathname === '/keys') {
      state.jwksCalls++;
      if (state.keysRejected) {
        response.writeHead(503);
        response.end('{"error":"temporarily_unavailable"}');
        return;
      }
      response.end(
        JSON.stringify({
          keys: [
            {
              ...(await exportJWK(publishedKeys.publicKey)),
              kid: publishedKeyId,
              alg: 'RS256',
              use: 'sig',
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname === '/authorize') {
      if (
        url.searchParams.get('response_type') !== 'code' ||
        url.searchParams.get('client_id') !== clientId ||
        url.searchParams.get('code_challenge_method') !== 'S256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(
          url.searchParams.get('code_challenge') ?? '',
        )
      ) {
        response.writeHead(400);
        response.end('{"error":"invalid_request"}');
        return;
      }
      const redirect = new URL(url.searchParams.get('redirect_uri')!);
      if (
        redirect.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(redirect.hostname) ||
        redirect.pathname !== '/oauth/callback'
      )
        throw new Error(
          'The native fixture received an unregistered callback.',
        );
      const code = randomUUID();
      codes.set(code, {
        nonce: url.searchParams.get('nonce')!,
        challenge: url.searchParams.get('code_challenge')!,
        redirect: redirect.href,
      });
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state')!);
      response.writeHead(302, { Location: redirect.href });
      response.end();
      return;
    }
    let text = '';
    for await (const chunk of request) {
      text += String(chunk);
      if (text.length > 65_536) throw new Error('Oversized synthetic request.');
    }
    const form = new URLSearchParams(text);
    state.submittedFields.push([...form.keys()]);
    if (form.has('client_secret'))
      throw new Error('A public client must never send a client secret.');
    if (form.get('client_id') !== clientId) {
      response.writeHead(400);
      response.end('{"error":"invalid_client"}');
      return;
    }
    if (url.pathname === '/token') {
      state.tokenCalls++;
      let nonce: string;
      if (form.get('grant_type') === 'authorization_code') {
        const grant = codes.get(form.get('code')!);
        codes.delete(form.get('code')!);
        if (
          !grant ||
          grant.redirect !== form.get('redirect_uri') ||
          grant.challenge !==
            createHash('sha256')
              .update(form.get('code_verifier') ?? '')
              .digest('base64url')
        ) {
          response.writeHead(400);
          response.end('{"error":"invalid_grant"}');
          return;
        }
        nonce = grant.nonce;
      } else if (form.get('grant_type') === 'refresh_token') {
        state.refreshCalls++;
        const grant = refreshes.get(form.get('refresh_token')!);
        refreshes.delete(form.get('refresh_token')!);
        if (!grant) {
          response.writeHead(400);
          response.end('{"error":"invalid_grant"}');
          return;
        }
        nonce = grant.nonce;
      } else {
        response.writeHead(400);
        response.end('{"error":"unsupported_grant_type"}');
        return;
      }
      const tokens = await result(nonce);
      if (form.get('grant_type') === 'refresh_token') {
        state.refreshStarted?.();
        await state.refreshGate;
      }
      response.end(JSON.stringify(tokens));
      return;
    }
    if (url.pathname === '/revoke') {
      if (state.revocationRejected) {
        response.writeHead(503);
        response.end('{"error":"temporarily_unavailable"}');
        return;
      }
      state.revoked.push(form.get('token')!);
      refreshes.delete(form.get('token')!);
      state.revocationStarted?.();
      await state.revocationGate;
      response.end('{}');
      return;
    }
    response.writeHead(404);
    response.end('{"error":"not_found"}');
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      state.failures.push(error);
      response.writeHead(500);
      response.end('{"error":"fixture_failure"}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('The synthetic issuer did not bind.');
  state.issuer = `http://127.0.0.1:${address.port}/`;
  const configuration: OidcClientConfiguration = {
    issuer: state.issuer,
    audience,
    client_id: clientId,
    required_scope: 'notes.access',
    scope: 'openid profile offline_access notes.access',
    loopback_host: '127.0.0.1',
  };
  return {
    state,
    configuration,
    async browser(url: string) {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Synthetic browser sign-in failed.');
      await response.text();
    },
    async rotate(preserveSigner = false) {
      publishedKeys = await generateKeyPair('RS256');
      publishedKeyId = randomUUID();
      if (!preserveSigner) {
        keys = publishedKeys;
        keyId = publishedKeyId;
      }
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
