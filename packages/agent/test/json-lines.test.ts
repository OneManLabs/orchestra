import { describe, expect, it } from 'vitest';
import { JsonLineDecoder } from '../src/json-lines.js';

describe('JsonLineDecoder', () => {
  it('decodes JSON split across arbitrary stream chunks', () => {
    const messages: unknown[] = [];
    const invalid: string[] = [];
    const decoder = new JsonLineDecoder((value) => messages.push(value), (line) => invalid.push(line));
    decoder.push('{"method":"turn/');
    decoder.push('started"}\n{"id":2,"result":');
    decoder.push('{"ok":true}}\nnot-json');
    decoder.flush();
    expect(messages).toEqual([{ method: 'turn/started' }, { id: 2, result: { ok: true } }]);
    expect(invalid).toEqual(['not-json']);
  });
});
