import type { ImageIntent, ImageReference } from '../lib/image-intent.js';
import { fitImageWithin } from '../lib/image-normalize.js';
import { MAX_REFERENCE_IMAGES, MediaError, REFERENCE_IMAGE_MAX_DIMENSION, runImageGeneration } from './media.js';
import { loadGeneratedImage, providerImageBytes, saveGeneratedImage } from './generated-images.js';

// Answers a chat turn that asked for a picture (lib/image-intent.ts) with an
// image model, as an ordinary assistant message: a Markdown image linking to
// the stored file. Failures come back as a plain-language assistant message,
// not an HTTP error — the user asked for something in a chat, and "add a
// Cloudflare key" is more useful to them there than a status code.

export interface ChatImageResult {
  ok: boolean;
  /** Assistant message text: the image link, or why there is none. */
  content: string;
  platform?: string;
  modelId?: string;
}

const KEY_HINT = 'Add a Cloudflare Workers AI key on the Keys page (the free tier includes a daily allowance), then ask again.';

function referenceBytes(ref: ImageReference): Buffer | null {
  if (ref.kind === 'generated') return loadGeneratedImage(ref.name)?.buffer ?? null;
  const comma = ref.url.indexOf(',');
  if (comma < 0 || !ref.url.slice(0, comma).includes(';base64')) return null;
  return Buffer.from(ref.url.slice(comma + 1), 'base64');
}

/** Output size for an edit: the reference's aspect ratio, long edge 1024, 16px grid. */
export function outputSizeFor(width: number, height: number): string {
  const long = 1024;
  const short = Math.max(256, Math.round((long * Math.min(width, height)) / Math.max(width, height) / 16) * 16);
  return width >= height ? `${long}x${short}` : `${short}x${long}`;
}

function explain(err: unknown, editing: boolean): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof MediaError && err.code === 'no_image_edit_model') {
    return `Editing an image needs a FLUX.2 model on Cloudflare Workers AI, and none is enabled. ${KEY_HINT}`;
  }
  if (/no usable keys/i.test(message)) {
    return editing
      ? `Editing an image needs a FLUX.2 model on Cloudflare Workers AI, and there is no working Cloudflare key. ${KEY_HINT}`
      : `No image model has a working key. ${KEY_HINT}`;
  }
  if (/No enabled image providers/i.test(message)) return 'No image model is enabled. Turn one on under Models, then ask again.';
  return `Image generation failed: ${message}`;
}

export async function generateChatImage(intent: ImageIntent, baseUrl: string): Promise<ChatImageResult> {
  const fail = (reason: string): ChatImageResult => ({ ok: false, content: `I couldn't make that image. ${reason}` });

  let referenceImages: Buffer[] | undefined;
  let size: string | undefined;
  if (intent.references.length > 0) {
    referenceImages = [];
    for (const ref of intent.references.slice(-MAX_REFERENCE_IMAGES)) {
      const bytes = referenceBytes(ref);
      if (!bytes) return fail('The image it refers to is no longer available; attach it again.');
      // The model rejects reference images of 512px or more, so they must be
      // shrunk first; without the image library that can't be done safely.
      const fitted = await fitImageWithin(bytes, REFERENCE_IMAGE_MAX_DIMENSION);
      if (!fitted) return fail('This server could not read or resize the attached image, which editing requires.');
      referenceImages.push(fitted.buffer);
      size ??= outputSizeFor(fitted.width, fitted.height);
    }
  }

  try {
    const result = await runImageGeneration(undefined, { prompt: intent.prompt, size, referenceImages });
    const name = saveGeneratedImage(await providerImageBytes(result.images[0]));
    return {
      ok: true,
      content: `![Generated image](${baseUrl}/v1/images/files/${name})`,
      platform: result.platform,
      modelId: result.modelId,
    };
  } catch (err) {
    return fail(explain(err, referenceImages !== undefined));
  }
}
