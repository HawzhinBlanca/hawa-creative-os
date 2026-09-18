import { describe, it, expect, vi, afterEach } from 'vitest';
import { PNG } from 'pngjs';
import { resolveImageSettings, resolveModel, ImageSettingsError } from '@hawa/domain';
import { generateArtImage } from '../src/studio/gemini-image-provider.js';
import type { Hex } from '../src/studio/layout-v2.js';

const PALETTE: Hex[] = ['#0A1628', '#1E3A5F', '#4770A3', '#D4E2F0', '#F7B500'];
const navyPng = (() => {
  const png = new PNG({ width: 32, height: 32 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([30, 58, 95, 255], i);
  return PNG.sync.write(png).toString('base64');
})();
const cleanVision = { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ containsForbidden: false, what: 'clean' }) } }] }) };

describe('image settings come from configuration, not code', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to OpenAI, with medium quality on the cheap tier and auto on production', () => {
    expect(resolveImageSettings({}, 'dev')).toEqual({ provider: 'openai', model: 'gpt-image-2.5-sunburst', size: '1024x1024', quality: 'medium', aspectRatio: '1:1' });
    expect(resolveImageSettings({}, 'production').quality).toBe('auto');
  });

  it('switches to Google, with its own default model and size', () => {
    expect(resolveImageSettings({ HAWA_IMAGE_PROVIDER: 'google' }, 'dev')).toEqual({ provider: 'google', model: 'gemini-3.1-flash-lite-image', size: '1K', quality: 'auto', aspectRatio: '1:1' });
    expect(resolveImageSettings({ HAWA_IMAGE_PROVIDER: 'google', HAWA_IMAGE_MODEL: 'gemini-3-pro-image', HAWA_IMAGE_SIZE: '2K', HAWA_IMAGE_ASPECT: '4:5' }, 'dev')).toMatchObject({ model: 'gemini-3-pro-image', size: '2K', aspectRatio: '4:5' });
  });

  it('refuses a value the provider would reject, instead of sending it', () => {
    expect(() => resolveImageSettings({ HAWA_IMAGE_PROVIDER: 'midjourney' })).toThrow(ImageSettingsError);
    expect(() => resolveImageSettings({ HAWA_IMAGE_PROVIDER: 'google', HAWA_IMAGE_MODEL: 'gpt-image-2.5-sunburst' })).toThrow(/not a google image model/);
    expect(() => resolveImageSettings({ HAWA_IMAGE_QUALITY: 'ultra' })).toThrow(/HAWA_IMAGE_QUALITY/);
    expect(() => resolveImageSettings({ HAWA_IMAGE_PROVIDER: 'google', HAWA_IMAGE_SIZE: '1024x1024' })).toThrow(/HAWA_IMAGE_SIZE/);
  });

  it('lets one text role be overridden without changing the tier', () => {
    vi.stubEnv('HAWA_MODEL_TIER', 'dev');
    vi.stubEnv('HAWA_MODEL_LAYOUT', 'gpt-6-astra');
    expect(resolveModel('layout')).toBe('gpt-6-astra');
    expect(resolveModel('judge')).toBe('gpt-4.1-mini');
  });
});

describe('art generation follows the settings', () => {
  it('sends the configured size and quality to OpenAI and costs the image from its reported usage', async () => {
    let body: any;
    const fetcher = vi.fn(async (url: any, init: any) => {
      if (String(url).includes('/v1/images/generations')) {
        body = JSON.parse(init.body);
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: [{ b64_json: navyPng }], usage: { input_tokens: 400, output_tokens: 1000, input_tokens_details: { text_tokens: 400, image_tokens: 0 } } }) } as any;
      }
      return cleanVision as any;
    });
    const result = await generateArtImage({
      artPrompt: 'Soft navy texture',
      palette: PALETTE,
      openaiApiKey: 'k',
      fetchFn: fetcher as any,
      settings: { provider: 'openai', model: 'gpt-image-2.5-sunburst', size: '1024x1536', quality: 'low', aspectRatio: '1:1' },
    });
    expect(body).toMatchObject({ model: 'gpt-image-2.5-sunburst', size: '1024x1536', quality: 'low' });
    // 400 text tokens at $5 and 1000 image tokens at $30 per million.
    expect(result.receipt.costUsd).toBeCloseTo(0.002 + 0.03, 6);
    expect(result.receipt.costSource).toBe('usage');
    expect(result.receipt.synthId).toBe(false);
  });

  it("asks Google's Interactions API with the key in its header and reads the image from the response steps", async () => {
    let call: { url: string; init: any } | undefined;
    const fetcher = vi.fn(async (url: any, init: any) => {
      if (String(url).includes('generativelanguage.googleapis.com')) {
        call = { url: String(url), init };
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ id: 'v1_abc', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', data: navyPng, mime_type: 'image/png' }] }] }) } as any;
      }
      return cleanVision as any;
    });
    const result = await generateArtImage({
      artPrompt: 'Soft navy texture',
      palette: PALETTE,
      openaiApiKey: 'openai-key',
      geminiApiKey: 'google-key',
      fetchFn: fetcher as any,
      settings: { provider: 'google', model: 'gemini-3.1-flash-lite-image', size: '1K', quality: 'auto', aspectRatio: '4:5' },
    });
    expect(call!.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(call!.init.headers['x-goog-api-key']).toBe('google-key');
    expect(JSON.parse(call!.init.body)).toMatchObject({ model: 'gemini-3.1-flash-lite-image', response_format: { type: 'image', aspect_ratio: '4:5', image_size: '1K' } });
    expect(result.receipt).toMatchObject({ provider: 'google', model: 'gemini-3.1-flash-lite-image', responseId: 'v1_abc', synthId: true, costUsd: 0.0336, costSource: 'price_list' });
  });

  it('counts an image the checks rejected, and still reports it after a procedural fallback', async () => {
    let chat = 0;
    const fetcher = vi.fn(async (url: any) => {
      if (String(url).includes('/v1/images/generations')) {
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: [{ b64_json: navyPng }], usage: { input_tokens: 0, output_tokens: 1000 } }) } as any;
      }
      chat++;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ containsForbidden: true, what: 'lettering' }) } }] }) } as any;
    });
    const result = await generateArtImage({
      artPrompt: 'Soft navy texture',
      palette: PALETTE,
      openaiApiKey: 'k',
      fetchFn: fetcher as any,
      settings: { provider: 'openai', model: 'gpt-image-2.5-sunburst', size: '1024x1024', quality: 'medium', aspectRatio: '1:1' },
    });
    expect(chat).toBe(2);
    expect(result.receipt.provider).toBe('procedural');
    expect(result.receipt.costUsd).toBeCloseTo(0.06, 6);
  });

  it('falls back to the procedural motif, with a warning, when the selected provider has no key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('GEMINI_API_KEY', '');
    const fetcher = vi.fn();
    const result = await generateArtImage({
      artPrompt: 'Soft navy texture',
      palette: PALETTE,
      openaiApiKey: 'k',
      fetchFn: fetcher as any,
      settings: { provider: 'google', model: 'gemini-3.1-flash-lite-image', size: '1K', quality: 'auto', aspectRatio: '1:1' },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.receipt).toMatchObject({ provider: 'procedural', costUsd: 0, attempts: 0 });
    expect(warn.mock.calls.flat().join(' ')).toMatch(/no API key/);
    warn.mockRestore();
    vi.unstubAllEnvs();
  });
});
