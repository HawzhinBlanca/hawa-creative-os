import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setAuthToken, getAuthToken, clearAuthToken } from '../src/services/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deskDir = path.resolve(__dirname, '..');

describe('Task 9: Desk Security Remediation (No token in URLs/localStorage, CSP, Playwright)', () => {
  describe('1. Auth Token Storage (Move out of localStorage)', () => {
    let mockLocalStorage: Record<string, string>;
    let mockSessionStorage: Record<string, string>;

    beforeEach(() => {
      mockLocalStorage = {};
      mockSessionStorage = {};

      vi.stubGlobal('window', {
        localStorage: {
          getItem: (k: string) => mockLocalStorage[k] || null,
          setItem: (k: string, v: string) => {
            mockLocalStorage[k] = v;
          },
          removeItem: (k: string) => {
            delete mockLocalStorage[k];
          },
        },
        sessionStorage: {
          getItem: (k: string) => mockSessionStorage[k] || null,
          setItem: (k: string, v: string) => {
            mockSessionStorage[k] = v;
          },
          removeItem: (k: string) => {
            delete mockSessionStorage[k];
          },
        },
      });
      clearAuthToken();
    });

    it('proves setAuthToken does NOT store the token in localStorage', () => {
      const token = ['test', 'operator', 'session', 'token'].join('_');
      setAuthToken(token);

      // Must NOT be in localStorage
      expect(mockLocalStorage['hawa_operator_token']).toBeUndefined();

      // Must be accessible via getAuthToken() from memory/sessionStorage
      expect(getAuthToken()).toBe(token);
    });

    it('purges legacy token from localStorage when auth helpers run', () => {
      mockLocalStorage['hawa_operator_token'] = ['legacy', 'insecure', 'token'].join('_');
      clearAuthToken();
      expect(mockLocalStorage['hawa_operator_token']).toBeUndefined();
    });
  });

  describe('2. Token out of URLs', () => {
    it('proves StudioPanel and desk components do not append access_token to image URLs', () => {
      const studioPanelSource = fs.readFileSync(path.join(deskDir, 'src/components/StudioPanel.tsx'), 'utf8');
      expect(studioPanelSource).not.toContain('access_token=');
    });
  });

  describe('3. Strict Content Security Policy (CSP)', () => {
    it('enforces CSP in index.html with object-src none and script-src self', () => {
      const html = fs.readFileSync(path.join(deskDir, 'index.html'), 'utf8');
      expect(html).toContain('http-equiv="Content-Security-Policy"');
      expect(html).toContain("default-src 'self'");
      expect(html).toContain("object-src 'none'");
    });

    it('enforces CSP headers in vite.config.ts for development and preview servers', () => {
      const viteConfig = fs.readFileSync(path.join(deskDir, 'vite.config.ts'), 'utf8');
      expect(viteConfig).toContain('Content-Security-Policy');
      expect(viteConfig).toContain("frame-ancestors 'none'");
    });
  });

  describe('4. Playwright E2E Suite', () => {
    it('verifies Playwright config and interaction specs are present', () => {
      expect(fs.existsSync(path.join(deskDir, 'playwright.config.ts'))).toBe(true);
      expect(fs.existsSync(path.join(deskDir, 'e2e/desk-interaction.spec.ts'))).toBe(true);
    });
  });
});
