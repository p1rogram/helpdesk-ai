import { describe, expect, it } from 'vitest';
import { OidcProvider, rolesFor } from '../modules/auth/corporate.js';

describe('rolesFor', () => {
  it('grants operator by group DN or CN', () => {
    const ops = new Set(['helpdesk-operators']);
    expect(
      rolesFor(
        { id: 'a', displayName: 'a', groups: ['CN=helpdesk-operators,OU=Groups,DC=tpu,DC=ru'] },
        ops,
      ),
    ).toEqual(['operator']);
    expect(rolesFor({ id: 'b', displayName: 'b', groups: ['students'] }, ops)).toEqual([]);
  });
});

describe('OidcProvider (fake IdP)', () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/.well-known/openid-configuration')) {
      return new Response(
        JSON.stringify({
          authorization_endpoint: 'https://idp/auth',
          token_endpoint: 'https://idp/token',
          userinfo_endpoint: 'https://idp/me',
        }),
      );
    }
    if (url === 'https://idp/token') {
      const body = String(init?.body);
      expect(body).toContain('code_verifier=');
      expect(body).toContain('code=abc');
      return new Response(JSON.stringify({ access_token: 'at' }));
    }
    if (url === 'https://idp/me') {
      return new Response(
        JSON.stringify({
          preferred_username: 'ivanov',
          name: 'Иванов Иван',
          email: 'ivanov@tpu.ru',
          groups: ['students'],
        }),
      );
    }
    return new Response('nf', { status: 404 });
  };
  const oidc = new OidcProvider({
    issuer: 'https://idp',
    clientId: 'app',
    redirectUri: 'https://app/cb',
    fetchImpl: fakeFetch,
  });

  it('runs the authorization-code + PKCE flow and maps claims', async () => {
    const url = new URL(await oidc.startLogin('https://app/'));
    expect(url.origin + url.pathname).toBe('https://idp/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state')!;
    const { identity, returnTo } = await oidc.finishLogin('abc', state);
    expect(identity).toEqual({
      id: 'ivanov',
      displayName: 'Иванов Иван',
      email: 'ivanov@tpu.ru',
      groups: ['students'],
    });
    expect(returnTo).toBe('https://app/');
  });

  it('rejects an unknown state (CSRF)', async () => {
    await expect(oidc.finishLogin('abc', 'forged')).rejects.toThrow(/state/);
  });
});
