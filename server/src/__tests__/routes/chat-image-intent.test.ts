import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';
import * as media from '../../services/media.js';

vi.mock('../../services/media.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/media.js')>('../../services/media.js');
  return { ...actual, runImageGeneration: vi.fn() };
});

// A real 1×1 PNG, so the reference path can decode and resize it.
const PIXEL_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PIXEL = Buffer.from(PIXEL_B64, 'base64');
const LOGO_TURN = {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'MAKE THIS LOGO INTO DIWALI THME' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PIXEL_B64}` } },
    ],
  }],
};

describe('chat image intent (/v1/chat/completions)', () => {
  let app: Express;
  let server: Server;
  let base: string;
  let key: string;
  let dir: string;
  const run = vi.mocked(media.runImageGeneration);

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-image-'));
    process.env.GENERATED_IMAGES_DIR = dir;
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.GENERATED_IMAGES_DIR;
  });

  beforeEach(() => {
    run.mockReset();
    run.mockResolvedValue({
      platform: 'cloudflare',
      modelId: '@cf/black-forest-labs/flux-2-klein-9b',
      images: [{ b64_json: PIXEL_B64 }],
    });
  });

  const chat = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify(body),
  });

  it('answers an uploaded logo + "make this logo into a Diwali theme" with an edited image', async () => {
    const res = await chat(LOGO_TURN);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-freellm-image-intent')).toBe('generated');
    expect(res.headers.get('x-routed-via')).toBe('cloudflare/@cf/black-forest-labs/flux-2-klein-9b');
    const body = await res.json() as any;
    const content: string = body.choices[0].message.content;
    const link = /^!\[Generated image\]\((http:\/\/127\.0\.0\.1:\d+\/v1\/images\/files\/[0-9a-f]{32}\.png)\)$/.exec(content);
    expect(link, content).not.toBeNull();

    // The upload went to the image model as a reference, prompt unchanged.
    const params = run.mock.calls[0][1];
    expect(params.prompt).toBe('MAKE THIS LOGO INTO DIWALI THME');
    expect(params.referenceImages).toHaveLength(1);
    expect(params.size).toBe('1024x1024');

    // And the link serves the stored image without the API key.
    const file = await fetch(link![1]);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PIXEL);
  });

  it('streams the same answer as SSE when asked to', async () => {
    const res = await chat({ ...LOGO_TURN, stream: true });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const frames = text.split('\n\n').filter(f => f.startsWith('data: ')).map(f => f.slice(6));
    expect(frames.at(-1)).toBe('[DONE]');
    const first = JSON.parse(frames[0]);
    expect(first.choices[0].delta.content).toMatch(/^!\[Generated image\]\(.+\/v1\/images\/files\/[0-9a-f]{32}\.png\)$/);
    expect(JSON.parse(frames[1]).choices[0].finish_reason).toBe('stop');
  });

  it('makes a text-only image request without a reference', async () => {
    const res = await chat({ messages: [{ role: 'user', content: 'generate an image of a diya' }] });
    expect(res.status).toBe(200);
    expect(run.mock.calls[0][1]).toEqual({ prompt: 'generate an image of a diya', size: undefined, referenceImages: undefined });
  });

  it('explains a missing key in the reply instead of failing the request', async () => {
    run.mockRejectedValue(new media.MediaError('All image providers failed (no usable keys).', 502));
    const res = await chat(LOGO_TURN);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-freellm-image-intent')).toBe('failed');
    const body = await res.json() as any;
    expect(body.choices[0].message.content).toMatch(/^I couldn't make that image\. .*Cloudflare Workers AI key on the Keys page/);
  });

  it('leaves a pinned model, an agent turn and an opted-out request on the chat path', async () => {
    const pinned = await chat({ ...LOGO_TURN, model: 'gemini-2.5-flash' });
    const agent = await chat({ ...LOGO_TURN, tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }] });
    const optedOut = await chat(LOGO_TURN, { 'X-FreeLLM-Image-Intent': 'off' });
    for (const res of [pinned, agent, optedOut]) {
      expect(res.headers.get('x-freellm-image-intent')).toBeNull();
      await res.text();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('404s an unknown or malformed image file name', async () => {
    expect((await fetch(`${base}/v1/images/files/${'0'.repeat(32)}.png`)).status).toBe(404);
    expect((await fetch(`${base}/v1/images/files/..%2Fsecret.png`)).status).toBe(404);
  });
});
