import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveGeneratedImage, loadGeneratedImage, providerImageBytes } from '../../services/generated-images.js';

// Minimal valid signatures: the store sniffs these, it never decodes.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);

describe('generated image store', () => {
  let dir: string;
  const originalDir = process.env.GENERATED_IMAGES_DIR;
  const originalMax = process.env.GENERATED_IMAGES_MAX;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-images-'));
    process.env.GENERATED_IMAGES_DIR = dir;
    delete process.env.GENERATED_IMAGES_MAX;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env.GENERATED_IMAGES_DIR; else process.env.GENERATED_IMAGES_DIR = originalDir;
    if (originalMax === undefined) delete process.env.GENERATED_IMAGES_MAX; else process.env.GENERATED_IMAGES_MAX = originalMax;
  });

  it('stores an image under an unguessable name and reads it back with its type', () => {
    const png = saveGeneratedImage(PNG);
    const jpg = saveGeneratedImage(JPEG);
    expect(png).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(jpg).toMatch(/^[0-9a-f]{32}\.jpg$/);
    expect(loadGeneratedImage(png)).toEqual({ buffer: PNG, mime: 'image/png' });
    expect(loadGeneratedImage(jpg)?.mime).toBe('image/jpeg');
  });

  it('refuses bytes that are not an image', () => {
    expect(() => saveGeneratedImage(Buffer.from('<html>error</html>'))).toThrow(/not a PNG, JPEG or WebP/);
  });

  it('serves only well-formed names from its own directory', () => {
    fs.writeFileSync(path.join(path.dirname(dir), 'secret.png'), 'x');
    for (const name of ['../secret.png', 'secret.png', `${'a'.repeat(32)}.exe`, `${'A'.repeat(32)}.png`, `${'a'.repeat(32)}.png`]) {
      expect(loadGeneratedImage(name), name).toBeNull();
    }
    fs.rmSync(path.join(path.dirname(dir), 'secret.png'), { force: true });
  });

  it('keeps only the newest GENERATED_IMAGES_MAX files', () => {
    process.env.GENERATED_IMAGES_MAX = '2';
    const names = [saveGeneratedImage(PNG), saveGeneratedImage(PNG)];
    // Make the first two clearly older than the third.
    const old = new Date(Date.now() - 60_000);
    for (const n of names) fs.utimesSync(path.join(dir, n), old, old);
    const newest = saveGeneratedImage(PNG);
    const left = fs.readdirSync(dir);
    expect(left).toHaveLength(2);
    expect(left).toContain(newest);
  });

  it('reads provider results given inline or as a URL', async () => {
    await expect(providerImageBytes({ b64_json: PNG.toString('base64') })).resolves.toEqual(PNG);
    await expect(providerImageBytes({})).rejects.toThrow(/no image/);
  });
});
