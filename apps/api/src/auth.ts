import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { Database } from '@windows-ai-notes/db';
import {
  resourceId,
  ServiceError,
  oidcClientConfigurationSchema,
  type OidcClientConfiguration,
} from '@windows-ai-notes/contracts/server';

export interface AuthConfig {
  mode: 'development' | 'oidc';
  host: string;
  issuer?: string;
  audience?: string;
  jwksUrl?: string;
  requiredScope?: string;
  desktop?: OidcClientConfiguration;
}
export interface Principal {
  userId: string;
  expiresAt: number;
}
declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  const host = env.HOST ?? '127.0.0.1';
  if (env.AUTH_MODE === 'development') {
    if (
      env.NODE_ENV === 'production' ||
      !['127.0.0.1', '::1', 'localhost'].includes(host)
    ) {
      throw new Error(
        'Development authentication requires non-production mode and a loopback bind address.',
      );
    }
    return { mode: 'development', host };
  }
  if (env.AUTH_MODE && env.AUTH_MODE !== 'oidc')
    throw new Error('AUTH_MODE must be development or oidc.');
  const issuer = env.OIDC_ISSUER;
  const audience = env.OIDC_AUDIENCE;
  const jwksUrl = env.OIDC_JWKS_URL;
  const requiredScope = env.OIDC_REQUIRED_SCOPE;
  if (
    !issuer ||
    !audience ||
    !jwksUrl ||
    !requiredScope ||
    /\s/.test(requiredScope)
  ) {
    throw new Error(
      'OIDC_ISSUER, OIDC_AUDIENCE, OIDC_JWKS_URL and one OIDC_REQUIRED_SCOPE are required.',
    );
  }
  for (const value of [issuer, jwksUrl]) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('OIDC URLs must be valid HTTPS URLs.');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        'OIDC URLs must be HTTPS without credentials, query strings or fragments.',
      );
    }
  }
  let desktop: OidcClientConfiguration | undefined;
  if (
    env.OIDC_DESKTOP_CLIENT_ID ||
    env.OIDC_DESKTOP_SCOPES ||
    env.OIDC_DESKTOP_LOOPBACK_HOST
  ) {
    desktop = oidcClientConfigurationSchema.parse({
      issuer,
      audience,
      client_id: env.OIDC_DESKTOP_CLIENT_ID,
      scope: env.OIDC_DESKTOP_SCOPES,
      required_scope: requiredScope,
      loopback_host: env.OIDC_DESKTOP_LOOPBACK_HOST ?? '127.0.0.1',
    });
  }
  return {
    mode: 'oidc',
    host,
    issuer,
    audience,
    jwksUrl,
    requiredScope,
    ...(desktop ? { desktop } : {}),
  };
}

export function createAuthenticator(config: AuthConfig, db: Database) {
  const keys =
    config.mode === 'oidc'
      ? createRemoteJWKSet(new URL(config.jwksUrl!), { timeoutDuration: 5000 })
      : null;
  return async (request: FastifyRequest): Promise<Principal> => {
    if (config.mode === 'development') {
      const subject = resourceId.safeParse(request.headers['x-dev-subject']);
      if (!subject.success)
        throw new ServiceError(
          'unauthorized',
          'Local development requires a provisioned X-Dev-Subject UUID.',
          401,
        );
      return {
        userId: await db.identify(
          'urn:windows-ai-notes:development',
          subject.data,
        ),
        expiresAt: Date.now() + 60 * 60_000,
      };
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length > 8192) {
      throw new ServiceError(
        'unauthorized',
        'A valid Bearer access token is required.',
        401,
      );
    }
    let subject: string;
    let expiresAt: number;
    try {
      const { payload } = await jwtVerify(authorization.slice(7), keys!, {
        issuer: config.issuer!,
        audience: config.audience!,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat'],
        clockTolerance: 5,
      });
      const scopes =
        typeof payload.scp === 'string'
          ? payload.scp
          : typeof payload.scope === 'string'
            ? payload.scope
            : '';
      if (
        !scopes.split(' ').includes(config.requiredScope!) ||
        !payload.sub ||
        !payload.exp
      )
        throw new Error('Invalid access scope.');
      subject = payload.sub;
      expiresAt = payload.exp * 1000;
      if (expiresAt <= Date.now()) throw new Error('Expired token.');
    } catch {
      throw new ServiceError(
        'unauthorized',
        'The access token failed issuer, audience, signature, time or scope validation.',
        401,
      );
    }
    return { userId: await db.identify(config.issuer!, subject), expiresAt };
  };
}

export function principal(request: FastifyRequest): Principal {
  if (!request.principal)
    throw new ServiceError('unauthorized', 'Authentication is required.', 401);
  return request.principal;
}
