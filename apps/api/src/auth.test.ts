import { describe, expect, it } from 'vitest';
import { loadAuthConfig } from './auth.js';

describe('authentication startup gates', () => {
  it('does not trust forwarded addresses by default', () => {
    expect(
      loadAuthConfig({ AUTH_MODE: 'development' }).trustedProxies,
    ).toBeUndefined();
  });
  it('accepts only an explicit bounded IP/CIDR proxy list', () => {
    expect(
      loadAuthConfig({
        AUTH_MODE: 'development',
        TRUSTED_PROXY_CIDRS:
          '127.0.0.1, ::1, 10.23.4.0/24, 2001:db8::/32, ::ffff:127.0.0.1',
      }).trustedProxies,
    ).toEqual([
      '127.0.0.1',
      '::1',
      '10.23.4.0/24',
      '2001:db8::/32',
      '::ffff:127.0.0.1',
    ]);
  });
  it('accepts the full sixteen-address configuration bound', () => {
    const addresses = Array.from(
      { length: 16 },
      (_, index) => `192.0.2.${index + 1}`,
    );
    expect(
      loadAuthConfig({
        AUTH_MODE: 'development',
        TRUSTED_PROXY_CIDRS: addresses.join(','),
      }).trustedProxies,
    ).toEqual(addresses);
  });
  it.each([
    '',
    ' ',
    'true',
    'false',
    '1',
    '*',
    'loopback',
    'linklocal',
    'uniquelocal',
    'localhost',
    'proxy.example.test',
    'https://127.0.0.1',
    '127.0.0.1:443',
    '256.0.0.1',
    '127.0.0.1,',
    '127.0.0.1,,::1',
    '127.0.0.1/33',
    '::1/129',
    '0.0.0.0/0',
    '::/0',
    '127.0.0.1/032',
    '::1/-1',
    '::1/128/extra',
    'fe80::1%eth0',
    'fe80::1%eth0/128',
    Array.from({ length: 17 }, () => '127.0.0.1').join(','),
    '1'.repeat(65),
  ])(
    'rejects invalid proxy trust %j instead of silently widening or disabling it',
    (value) => {
      expect(() =>
        loadAuthConfig({
          AUTH_MODE: 'development',
          TRUSTED_PROXY_CIDRS: value,
        }),
      ).toThrow('TRUSTED_PROXY_CIDRS');
    },
  );
  it('allows development headers only with explicit development mode and loopback binding', () => {
    expect(
      loadAuthConfig({ AUTH_MODE: 'development', HOST: '127.0.0.1' }),
    ).toMatchObject({ mode: 'development' });
    expect(() =>
      loadAuthConfig({ AUTH_MODE: 'development', HOST: '0.0.0.0' }),
    ).toThrow('loopback');
    expect(() =>
      loadAuthConfig({ AUTH_MODE: 'development', NODE_ENV: 'production' }),
    ).toThrow('non-production');
  });
  it('does not silently default to unauthenticated development mode', () => {
    expect(() => loadAuthConfig({})).toThrow('OIDC_ISSUER');
    expect(() => loadAuthConfig({ AUTH_MODE: 'none' })).toThrow('AUTH_MODE');
  });
  it('requires explicit issuer, audience, HTTPS JWKS and access scope', () => {
    const env = {
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: 'https://identity.example.test/',
      OIDC_AUDIENCE: 'notes-api',
      OIDC_JWKS_URL: 'https://identity.example.test/keys',
      OIDC_REQUIRED_SCOPE: 'notes.access',
    };
    expect(loadAuthConfig(env)).toMatchObject({
      mode: 'oidc',
      requiredScope: 'notes.access',
    });
    expect(
      loadAuthConfig({ ...env, TRUSTED_PROXY_CIDRS: '192.0.2.4/32' }),
    ).toMatchObject({
      mode: 'oidc',
      trustedProxies: ['192.0.2.4/32'],
      issuer: env.OIDC_ISSUER,
      requiredScope: 'notes.access',
    });
    expect(() =>
      loadAuthConfig({
        ...env,
        OIDC_JWKS_URL: 'http://identity.example.test/keys',
      }),
    ).toThrow('HTTPS');
  });
  it('requires a complete public native-client registration and offline scope when desktop login is enabled', () => {
    const env = {
      OIDC_ISSUER: 'https://identity.example.test/',
      OIDC_AUDIENCE: 'notes-api',
      OIDC_JWKS_URL: 'https://identity.example.test/keys',
      OIDC_REQUIRED_SCOPE: 'notes.access',
      OIDC_DESKTOP_CLIENT_ID: 'native-public-client',
    };
    expect(() => loadAuthConfig(env)).toThrow();
    expect(() =>
      loadAuthConfig({ ...env, OIDC_DESKTOP_SCOPES: 'openid notes.access' }),
    ).toThrow('offline_access');
    expect(
      loadAuthConfig({
        ...env,
        OIDC_DESKTOP_SCOPES:
          'openid offline_access api://notes-api/notes.access',
        OIDC_DESKTOP_LOOPBACK_HOST: 'localhost',
      }).desktop,
    ).toEqual({
      issuer: env.OIDC_ISSUER,
      audience: env.OIDC_AUDIENCE,
      required_scope: 'notes.access',
      client_id: 'native-public-client',
      scope: 'openid offline_access api://notes-api/notes.access',
      loopback_host: 'localhost',
    });
  });
});
