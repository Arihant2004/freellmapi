// Image intent: spot a chat turn that asks for a PICTURE as the answer ("make
// this logo Diwali-themed", "generate a poster of a lamp") so the chat route
// can answer it with an image model. A chat model can see an attached image
// but only ever replies in text, which is how "make this logo into a Diwali
// theme" came back as a design essay.
//
// Detection is silent and on by default, so it errs hard toward chat: a missed
// image request gets the old text answer, while a false positive replaces a
// text answer the user wanted with a picture. A turn counts only when it is an
// imperative to make or change something visual:
//   - it opens with a creation verb (after politeness like "please", "can
//     you"), and is not "show me how…" style instructions;
//   - it names a visual thing (image, logo, poster…) before any text artifact
//     (list, caption, prompt, code…), so "make a list of logo ideas" and
//     "write a prompt for a logo" stay chat; or it is draw/paint/sketch with
//     an object; or it edits an image in the conversation ("turn this into a
//     cartoon", "make it more festive");
//   - it is short, and carries no code markers.
// Opt out per request with `X-FreeLLM-Image-Intent: off`, or for the whole
// server with IMAGE_INTENT=off.

import type { Request } from 'express';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { contentToString } from './content.js';
import { deriveTaskType } from './task-type.js';
import { GENERATED_IMAGE_LINK_RE } from '../services/generated-images.js';

export const IMAGE_INTENT_HEADER = 'x-freellm-image-intent';

// Image prompts are short; a long message is a document or a brief to discuss.
const MAX_PROMPT_CHARS = 1000;

export type ImageReference =
  | { kind: 'data'; url: string }
  | { kind: 'generated'; name: string };

export interface ImageIntent {
  /** The user's own words, passed to the image model as the prompt. */
  prompt: string;
  /** Images to edit or take as reference, oldest first. */
  references: ImageReference[];
}

const POLITE_PREFIX = /^(?:please|pls|plz|kindly|hey|hi|hello|ok(?:ay)?|now|also|and|so|then|can you|could you|would you|will you|can u|could u|i want you to|i'd like you to|i would like you to|help me)\b[\s,!.:]*/i;

const CREATE_VERB = /^(?:make|create|generate|draw|design|paint|render|produce|redesign|redraw|turn|convert|transform|edit|restyle|recolou?r|illustrate|sketch|imagine|visuali[sz]e|change|modify|add|remove|put|give me|show me)\b/i;

// "I want / we need a logo…" — a request phrased as a wish.
const WANT_PREFIX = /^(?:i|we)\s+(?:want|need|would like|'d like|wanna)\b/i;

// "show me how to…", "make me what…": instructions or a question, not a picture.
const QUESTION_AFTER_VERB = /^(?:give me|show me|\S+)(?:\s+me)?\s+(?:how|why|what|where|when|which|who|if|whether)\b/i;

const VISUAL_NOUN = /\b(?:images?|pictures?|pics?|photos?|photographs?|logos?|posters?|banners?|wallpapers?|illustrations?|icons?|drawings?|paintings?|sketch(?:es)?|artworks?|thumbnails?|stickers?|flyers?|graphics?|emblems?|mascots?|portraits?|avatars?|memes?|greeting cards?|invitation cards?)\b/i;

// Text deliverables. One appearing BEFORE the visual noun means the user wants
// words about a picture ("a caption for this photo"), not a picture.
const TEXT_ARTIFACT = /\b(?:list|ideas?|names?|descriptions?|describe|captions?|prompts?|text|code|script|function|plan|story|poem|essay|e-?mail|letter|summary|outline|table|tagline|slogan|copy|post|tweet|bio|title|headline|steps|guide|tutorial|explanation|report|article|blog|paragraph|sentence|message|question|quiz|svg|html|css|json|csv|markdown|regex|sql|program|app|website|component|class|api|alt[- ]text|brief|proposal|strategy|analysis|critique|review|feedback|suggestions?|tips|advice|presentation|slides?|document)\b/i;

// draw/paint/sketch/illustrate need no visual noun ("draw a cat") unless the
// object is figurative ("draw a conclusion", "draw up a plan").
const FREEFORM_VISUAL_VERB = /^(?:draw|paint|sketch|illustrate)\b/i;
const FIGURATIVE_OBJECT = /^\S+\s+(?:(?:a|an|the|some|any|my|your|our|their)\s+)?(?:up|out|on|upon|from|attention|conclusions?|comparisons?|parallels?|lessons?|inspiration|lines?|distinctions?)\b/i;

// Points at an image already in the conversation.
const DEICTIC = /\b(?:this|that|it|these|those|same|above|previous|last)\b/i;
// A change of look; with a deictic and an image in play, enough on its own.
const EDIT_MARKER = /\b(?:into|themed?|style[ds]?|looks?\s+like|version|colou?rs?|colou?red|background|cartoon|anime|watercolou?r|realistic|vintage|festive|brighter|darker|transparent|bigger|smaller|golden|gold|neon)\b/i;

/** False when the server or this request opted out of image intent. */
export function imageIntentEnabled(req: Request): boolean {
  const env = process.env.IMAGE_INTENT?.trim().toLowerCase();
  if (env === 'off' || env === 'false' || env === '0' || env === 'no') return false;
  const raw = req.headers[IMAGE_INTENT_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  return value !== 'off';
}

function imageUrlsOf(message: ChatMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  const urls: string[] = [];
  for (const block of message.content) {
    const b = block as { type?: string; image_url?: unknown };
    if (b?.type !== 'image_url' && b?.type !== 'image') continue;
    const url = typeof b.image_url === 'string' ? b.image_url : (b.image_url as { url?: unknown } | undefined)?.url;
    if (typeof url === 'string') urls.push(url);
  }
  return urls;
}

// The newest image earlier in the conversation: an upload in a user turn, or a
// picture this feature generated in an assistant turn.
function latestEarlierImage(messages: ChatMessage[]): ImageReference | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      const data = imageUrlsOf(m).filter(u => u.startsWith('data:'));
      if (data.length > 0) return { kind: 'data', url: data[data.length - 1] };
    } else if (m.role === 'assistant') {
      const links = [...contentToString(m.content).matchAll(GENERATED_IMAGE_LINK_RE)];
      if (links.length > 0) return { kind: 'generated', name: links[links.length - 1][1] };
    }
  }
  return null;
}

/** The image request in the latest user turn, or null for an ordinary chat turn. */
export function detectImageIntent(messages: ChatMessage[]): ImageIntent | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return null;
  const raw = contentToString(last.content).trim();
  if (!raw || raw.length > MAX_PROMPT_CHARS) return null;
  if (deriveTaskType(undefined, [last]) === 'code') return null;

  // An attached image this path can't read (a remote URL) means the turn
  // can't be answered faithfully here; leave it to the chat model.
  const attached = imageUrlsOf(last);
  if (attached.some(u => !u.startsWith('data:'))) return null;

  let text = raw.replace(/\s+/g, ' ');
  for (let prev = ''; prev !== text;) {
    prev = text;
    text = text.replace(POLITE_PREFIX, '');
  }

  const isCreate = CREATE_VERB.test(text);
  const isWant = WANT_PREFIX.test(text);
  if (!isCreate && !isWant) return null;
  if (QUESTION_AFTER_VERB.test(text)) return null;

  const nounAt = text.search(VISUAL_NOUN);
  const textAt = text.search(TEXT_ARTIFACT);
  const namesVisual = nounAt >= 0 && (textAt < 0 || nounAt < textAt);

  const earlier = attached.length === 0 && DEICTIC.test(text) ? latestEarlierImage(messages.slice(0, -1)) : null;
  const imageInPlay = attached.length > 0 || earlier !== null;

  const asksForImage = isWant
    ? namesVisual
    : namesVisual
      || (FREEFORM_VISUAL_VERB.test(text) && !FIGURATIVE_OBJECT.test(text) && textAt < 0)
      || (imageInPlay && DEICTIC.test(text) && EDIT_MARKER.test(text) && textAt < 0);
  if (!asksForImage) return null;

  const references: ImageReference[] = attached.length > 0
    ? attached.map(url => ({ kind: 'data' as const, url }))
    : earlier ? [earlier] : [];
  return { prompt: raw, references };
}
