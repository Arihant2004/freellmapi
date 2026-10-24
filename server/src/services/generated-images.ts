import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDefaultDbPath } from '../db/index.js';

// Images generated for a chat turn (services/chat-image.ts) are kept on disk
// next to the database and served back at /v1/images/files/<name>. The chat
// reply carries only that short link: inlining the base64 would put ~1.5MB of
// text in the transcript, which every later turn replays to the model and
// which the playground saves with the conversation.
//
// The 128-bit random name is the capability: an <img> tag cannot send the
// bearer key, so the file route is unauthenticated and the name unguessable.
// The newest GENERATED_IMAGES_MAX files are kept (default 200); older ones are
// removed, and links to them in old transcripts stop resolving.

const DEFAULT_MAX_FILES = 200;
const NAME_RE = /^[0-9a-f]{32}\.(png|jpg|webp)$/;
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' } as const;
type Ext = keyof typeof MIME_BY_EXT;

/** Matches a generated-image link in transcript text; group 1 is the file name. */
export const GENERATED_IMAGE_LINK_RE = /\/v1\/images\/files\/([0-9a-f]{32}\.(?:png|jpg|webp))/g;

export function generatedImagesDir(): string {
  return process.env.GENERATED_IMAGES_DIR?.trim()
    || path.join(path.dirname(getDefaultDbPath()), 'generated-images');
}

function maxFiles(): number {
  const n = Number(process.env.GENERATED_IMAGES_MAX);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_FILES;
}

// Providers answer with PNG, JPEG or WebP; anything else is not served, so a
// provider error page that arrived as "image bytes" never becomes a link.
function extOf(buffer: Buffer): Ext | null {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Store one generated image and return its file name. Throws on non-image bytes. */
export function saveGeneratedImage(buffer: Buffer): string {
  const ext = extOf(buffer);
  if (!ext) throw new Error('the image model returned something that is not a PNG, JPEG or WebP image');
  const dir = generatedImagesDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buffer, { mode: 0o600 });
  pruneGeneratedImages(dir);
  return name;
}

/** Read a stored image by file name; null for an unknown or malformed name. */
export function loadGeneratedImage(name: string): { buffer: Buffer; mime: string } | null {
  if (!NAME_RE.test(name)) return null;
  try {
    const buffer = fs.readFileSync(path.join(generatedImagesDir(), name));
    return { buffer, mime: MIME_BY_EXT[name.slice(name.lastIndexOf('.') + 1) as Ext] };
  } catch {
    return null;
  }
}

function pruneGeneratedImages(dir: string): void {
  try {
    const files = fs.readdirSync(dir)
      .filter(n => NAME_RE.test(n))
      .map(n => ({ n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { n } of files.slice(maxFiles())) fs.rmSync(path.join(dir, n), { force: true });
  } catch {
    // Best effort: a failed prune only leaves extra files behind.
  }
}

/** The bytes of one provider result: inline base64, or a URL the provider hosts. */
export async function providerImageBytes(image: { b64_json?: string; url?: string }): Promise<Buffer> {
  if (image.b64_json) return Buffer.from(image.b64_json, 'base64');
  if (image.url) {
    const res = await fetch(image.url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`could not download the generated image (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('the image model returned no image');
}
