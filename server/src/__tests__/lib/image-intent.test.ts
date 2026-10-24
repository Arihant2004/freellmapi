import { describe, it, expect, afterEach } from 'vitest';
import type { Request } from 'express';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { detectImageIntent, imageIntentEnabled, IMAGE_INTENT_HEADER } from '../../lib/image-intent.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const GENERATED = 'http://192.168.0.167:3001/v1/images/files/0123456789abcdef0123456789abcdef.png';

function user(text: string, ...images: string[]): ChatMessage {
  if (images.length === 0) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map(url => ({ type: 'image_url', image_url: { url } })),
    ],
  } as ChatMessage;
}

function reqWith(header?: string): Request {
  return { headers: header === undefined ? {} : { [IMAGE_INTENT_HEADER]: header } } as unknown as Request;
}

describe('detectImageIntent', () => {
  it('catches the reported request: an uploaded logo plus "make this logo into a Diwali theme"', () => {
    const intent = detectImageIntent([user('MAKE THIS LOGO INTO DIWALI THME', PNG)]);
    expect(intent).toEqual({ prompt: 'MAKE THIS LOGO INTO DIWALI THME', references: [{ kind: 'data', url: PNG }] });
  });

  it('catches requests to make a picture from text alone', () => {
    const samples = [
      'generate an image of a cat wearing a turban',
      'Create a Diwali poster for my sweet shop',
      'please design a logo for a bakery called Crumbs',
      'can you make a wallpaper with diyas and rangoli',
      'Draw a cat',
      'paint a sunset over the Ganges',
      'I want a logo for my tea stall',
      'give me a picture of a red fort at night',
    ];
    for (const s of samples) {
      const intent = detectImageIntent([user(s)]);
      expect(intent, s).not.toBeNull();
      expect(intent!.references, s).toEqual([]);
    }
  });

  it('catches edits of an attached image without naming it', () => {
    for (const s of ['turn this into a cartoon', 'make it more festive', 'make this golden']) {
      expect(detectImageIntent([user(s, PNG)]), s).not.toBeNull();
    }
  });

  it('leaves questions, text deliverables and figurative verbs to the chat model', () => {
    const chat: ChatMessage[][] = [
      [user('what is in this picture?', PNG)],
      [user('describe this logo', PNG)],
      [user('how do I make a logo in Canva?')],
      [user('show me how to draw a logo')],
      [user('make a list of logo ideas for a bakery')],
      [user('write a prompt for midjourney to make a Diwali logo')],
      [user('generate a caption for this photo', PNG)],
      [user('make this text shorter', PNG)],
      [user('turn it into a poem', PNG)],
      [user('draw a conclusion from this data')],
      [user('draw up a plan for the launch')],
      [user('make the function return an image buffer: ```js\nconst x = 1;\n```')],
      [user('create an svg icon for a settings button')],
      [user('summarize this article')],
      [user('hello there')],
    ];
    for (const messages of chat) {
      const text = typeof messages[0].content === 'string'
        ? messages[0].content
        : (messages[0].content as { text?: string }[])[0].text;
      expect(detectImageIntent(messages), text).toBeNull();
    }
  });

  it('ignores a long message', () => {
    expect(detectImageIntent([user(`generate an image of ${'a very detailed scene, '.repeat(60)}`)])).toBeNull();
  });

  it('only looks at the latest turn, and only when it is the user speaking', () => {
    expect(detectImageIntent([user('generate an image of a cat'), { role: 'assistant', content: 'ok' }])).toBeNull();
    expect(detectImageIntent([user('generate an image of a cat'), { role: 'assistant', content: 'done' }, user('thanks!')])).toBeNull();
  });

  it('leaves an attached remote-URL image to the chat model', () => {
    expect(detectImageIntent([user('make this logo festive', 'https://example.com/logo.png')])).toBeNull();
  });

  it('edits the image from an earlier turn when the new turn points back at it', () => {
    const earlierUpload = detectImageIntent([
      user('what do you think of this logo?', PNG),
      { role: 'assistant', content: 'It is clean and simple.' },
      user('make this logo Diwali themed'),
    ]);
    expect(earlierUpload?.references).toEqual([{ kind: 'data', url: PNG }]);

    const earlierGenerated = detectImageIntent([
      user('generate a logo for a tea stall'),
      { role: 'assistant', content: `![Generated image](${GENERATED})` },
      user('make it more festive'),
    ]);
    expect(earlierGenerated?.references).toEqual([{ kind: 'generated', name: '0123456789abcdef0123456789abcdef.png' }]);
  });

  it('starts fresh when the new turn does not point back at an earlier image', () => {
    const intent = detectImageIntent([
      user('what do you think of this logo?', PNG),
      { role: 'assistant', content: 'It is clean.' },
      user('create a poster for a music night'),
    ]);
    expect(intent?.references).toEqual([]);
  });
});

describe('imageIntentEnabled', () => {
  const original = process.env.IMAGE_INTENT;
  afterEach(() => {
    if (original === undefined) delete process.env.IMAGE_INTENT; else process.env.IMAGE_INTENT = original;
  });

  it('is on by default, off by header or by IMAGE_INTENT=off', () => {
    delete process.env.IMAGE_INTENT;
    expect(imageIntentEnabled(reqWith())).toBe(true);
    expect(imageIntentEnabled(reqWith('auto'))).toBe(true);
    expect(imageIntentEnabled(reqWith(' OFF '))).toBe(false);
    process.env.IMAGE_INTENT = 'off';
    expect(imageIntentEnabled(reqWith())).toBe(false);
  });
});
