import { beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '@hawa/db';
import { officeAccessPolicy, validateOfficeBind } from '../src/services/office-access.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => db.destroy());
const origin = 'http://127.0.0.1:8080';
beforeEach(() => {
  vi.stubEnv('HAWA_DESK_AUTH_MODE', 'trusted_office');
  vi.stubEnv('HAWA_TRUSTED_OFFICE_ORIGIN', origin);
});
afterEach(() => vi.unstubAllEnvs());

it('opens the office session and directory without a user credential', async () => {
  const app = createApp({ db });
  const session = await app.request(origin + '/v1/auth/session');
  expect(session.status).toBe(200);
  expect((await session.json()).user).toMatchObject({ displayName:'Office team',role:'administrator',authMethod:'trusted_office' });
  expect((await app.request(origin + '/v1/clients')).status).toBe(200);
  expect((await (await app.request(origin + '/v1/auth/providers')).json()).trustedOffice).toBe(true);
  expect((await app.request(origin + '/v1/system/providers')).status).toBe(200);
});

it('creates exactly one explicitly scoped request on an unchanged retry', async () => {
  const app = createApp({ db });
  const input = { method:'POST', headers:{'Content-Type':'application/json','X-Hawa-Office-Request':'1','Idempotency-Key':'trusted-office-retry'},
    body:JSON.stringify({ title:'Office without a login',clientId:'c1000000-0000-4000-8000-000000000001',copyEn:'Exact office copy' }) };
  const first = await app.request(origin + '/v1/tasks', input);
  expect(first.status).toBe(201);
  const second = await app.request(origin + '/v1/tasks', input);
  expect(second.status).toBeLessThan(300);
  expect((await second.json()).id).toBe((await first.json()).id);
});

it('refuses another host, cross-site reads, and writes without the office request header', async () => {
  const app = createApp({ db });
  const foreignHeaders: Record<string,string>[] = [{Origin:'https://outside.example'},{'Sec-Fetch-Site':'cross-site'}];
  for (const headers of foreignHeaders) {
    expect((await app.request(origin + '/v1/tasks',{headers})).status).toBe(401);
  }
  expect((await app.request('http://outside.example/v1/tasks')).status).toBe(401);
  expect((await app.request(origin + '/v1/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(401);
});

it('keeps worker routes credentialed and keeps worker credentials out of office access', async () => {
  vi.stubEnv('HAWA_WORKER_TOKEN','test_office_worker_credential');
  const app = createApp({ db });
  expect((await app.request(origin+'/v1/internal/telegram/intake',{method:'POST',headers:{'Content-Type':'application/json','X-Hawa-Office-Request':'1'},body:'{}'})).status).toBe(401);
  expect((await app.request(origin+'/v1/tasks',{headers:{Authorization:'Bearer test_office_worker_credential'}})).status).toBe(401);
});

it('issues a stream ticket without placing a secret in the Desk', async () => {
  const app = createApp({ db });
  const result = await app.request(origin+'/v1/auth/stream-ticket',{method:'POST',headers:{'X-Hawa-Office-Request':'1'}});
  expect(result.status).toBe(201);
  expect(await result.json()).toMatchObject({ticket:expect.any(String),expiresInSeconds:expect.any(Number)});
});

it('restores required authentication when the mode is switched back', async () => {
  vi.stubEnv('HAWA_DESK_AUTH_MODE','required');
  const app = createApp({ db });
  expect((await app.request(origin+'/v1/tasks')).status).toBe(401);
  expect((await (await app.request(origin+'/v1/auth/providers')).json()).trustedOffice).toBe(false);
});

it('refuses accidental public access configuration and unknown modes', () => {
  for (const host of ['https://customers.example','http://0.0.0.0:8080','http://127.0.0.1:8080/path','http://127.0.0.1:8080?x=1']) {
    expect(() => officeAccessPolicy({HAWA_DESK_AUTH_MODE:'trusted_office',HAWA_TRUSTED_OFFICE_ORIGIN:host})).toThrow();
  }
  expect(() => officeAccessPolicy({HAWA_DESK_AUTH_MODE:'off'})).toThrow();
  expect(officeAccessPolicy({})).toEqual({mode:'required'});
  const local = officeAccessPolicy({HAWA_DESK_AUTH_MODE:'trusted_office',HAWA_TRUSTED_OFFICE_ORIGIN:origin});
  expect(() => validateOfficeBind(local,'0.0.0.0')).toThrow();
  expect(() => validateOfficeBind(local,'127.0.0.1')).not.toThrow();
});
