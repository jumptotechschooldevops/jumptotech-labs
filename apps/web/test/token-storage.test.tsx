/**
 * BETA-P0-014 — no provider token, and no session value, reaches script.
 *
 * Two proofs, because either alone has a gap:
 *
 *   1. **The sources.** Parsed, not grepped — a comment that says "never use
 *      localStorage" is not a use of it — so the check is on what the code
 *      actually touches: no Web Storage, no IndexedDB, no `document.cookie`, and
 *      no identifier or string naming an OIDC token or client credential.
 *   2. **The running app.** The real `fetchAuthSession` and `signOut`, against a
 *      stubbed network, with every storage write spied on: signing in and out
 *      writes nothing, sends the cookie by `credentials: 'include'` only, and
 *      never attaches an `Authorization` header.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthGate } from '../src/components/AuthGate';
import { AuthProvider } from '../src/lib/AuthContext';
import { signOut, type AuthSession } from '../src/lib/auth';

const WEB_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(tsx?|jsx?)$/.test(entry) ? [full] : [];
  });
}

const STORAGE_GLOBALS = new Set(['localStorage', 'sessionStorage', 'indexedDB']);
const TOKEN_NAMES = /^(id_?token|access_?token|refresh_?token|client_?secret|code_?verifier)$/i;

interface Finding {
  file: string;
  what: string;
}

function scan(file: string): Finding[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const relative = path.relative(WEB_SRC, file);

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && STORAGE_GLOBALS.has(node.text)) {
      findings.push({ file: relative, what: node.text });
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'cookie' &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'document'
    ) {
      findings.push({ file: relative, what: 'document.cookie' });
    }
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && TOKEN_NAMES.test(node.text)) {
      findings.push({ file: relative, what: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

const SIGNED_IN: AuthSession = {
  authenticated: true,
  signInAvailable: true,
  mode: 'oidc',
  identity: {
    subject: 'oidc|student',
    issuer: 'https://issuer.test/',
    email: 'student@example.test',
    displayName: 'A Student',
    role: 'STUDENT',
    source: 'oidc',
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('the browser sources', () => {
  it('never touch Web Storage, IndexedDB or document.cookie', () => {
    const findings = sourceFiles(WEB_SRC).flatMap(scan).filter((f) => !TOKEN_NAMES.test(f.what));
    expect(findings).toEqual([]);
  });

  it('never name an OIDC token or client credential', () => {
    const findings = sourceFiles(WEB_SRC).flatMap(scan).filter((f) => TOKEN_NAMES.test(f.what));
    expect(findings).toEqual([]);
  });

  it('the scanner itself sees a real use, so a pass is not a blind spot', () => {
    const probe = path.join(WEB_SRC, '__probe__.ts');
    const source = ts.createSourceFile(
      probe,
      "// localStorage in a comment is fine\nwindow.localStorage.setItem('id_token', document.cookie);",
      ts.ScriptTarget.Latest,
      true,
    );
    const seen: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && STORAGE_GLOBALS.has(node.text)) seen.push(node.text);
      if (ts.isStringLiteralLike(node) && TOKEN_NAMES.test(node.text)) seen.push(node.text);
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'cookie') seen.push('document.cookie');
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(seen.sort()).toEqual(['document.cookie', 'id_token', 'localStorage']);
  });
});

describe('the running app', () => {
  function stubFetch(body: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true, data: body }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return calls;
  }

  it('signs in without writing anything a script could read', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const calls = stubFetch(SIGNED_IN);

    render(
      <AuthProvider>
        <AuthGate>
          <div>the catalog</div>
        </AuthGate>
      </AuthProvider>,
    );

    expect(await screen.findByText('the catalog')).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');

    const session = calls.find((c) => c.url.endsWith('/auth/session'))!;
    expect(session.init.credentials).toBe('include');
    expect(new Headers(session.init.headers).has('authorization')).toBe(false);
  });

  it('signs out with a credentialed POST that carries no token', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const calls = stubFetch({ signedOut: true });

    await expect(signOut()).resolves.toEqual({ signedOut: true });

    const logout = calls.find((c) => c.url.endsWith('/auth/logout'))!;
    expect(logout.init.method).toBe('POST');
    expect(logout.init.credentials).toBe('include');
    expect(logout.init.body).toBeUndefined();
    expect(new Headers(logout.init.headers).has('authorization')).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });
});
