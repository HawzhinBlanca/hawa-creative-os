// @vitest-environment jsdom
import React from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { DeskProviders, createDeskRuntime, type DeskRuntime } from '../src/DeskProviders.js';
import { clearAuthToken, getAuthToken } from '../src/services/auth.js';
import { FakeStream, advance, click, byText, json, mount, stubCore } from './support/desk-harness.js';

let view: Awaited<ReturnType<typeof mount>> | undefined;
let runtime: DeskRuntime | undefined;
beforeEach(() => { vi.useFakeTimers(); clearAuthToken(); localStorage.clear(); });
afterEach(async () => {
  await view?.unmount(); await runtime?.queryClient.cancelQueries(); runtime?.queryClient.clear();
  vi.useRealTimers(); vi.unstubAllGlobals(); clearAuthToken(); localStorage.clear();
});

it('opens Work and the task form with no key, and labels the shared office identity', async () => {
  stubCore(c => c.path === '/v1/auth/providers' ? json({googleWorkspace:false,trustedOffice:true})
    : c.path === '/v1/auth/session' ? json({authenticated:true,user:{id:'office',role:'administrator',displayName:'Office team',authMethod:'trusted_office'}})
    : c.path === '/v1/tasks' ? json({items:[],total:0})
    : c.path === '/v1/clients' ? json([{clientId:'c1000000-0000-4000-8000-000000000001',name:'Office client',code:'office',defaultLocale:'en',status:'active'}]) : undefined);
  const stream = new FakeStream(); runtime = createDeskRuntime({stream,doc:{hidden:false}});
  view = await mount(React.createElement(DeskProviders,{runtime,children:React.createElement(App)}));
  await advance(500);
  expect(view.text()).not.toContain('Authentication Required');
  expect(view.text()).toContain('Office team');
  expect(byText(view.container,'button','Sign Out')).toBeUndefined();
  expect(runtime.session.getState().status).toBe('signed_in');
  expect(getAuthToken()).toBeNull();
  expect(stream.connects).toBeGreaterThan(0);
  await click(byText(view.container,'button',/New task/i)); await advance(200);
  expect(view.container.querySelector('[role="dialog"]')).toBeTruthy();
  expect(view.text()).toContain('Office client');
});

it('continues to require sign-in when the server reports required mode', async () => {
  stubCore(c => c.path === '/v1/auth/providers' ? json({googleWorkspace:false,trustedOffice:false}) : undefined);
  runtime = createDeskRuntime({stream:new FakeStream()});
  view = await mount(React.createElement(DeskProviders,{runtime,children:React.createElement(App)}));
  await advance(200);
  expect(view.text()).toContain('Authentication Required');
  expect(runtime.session.getState().status).toBe('signed_out');
});
