import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageContent } from '../src/renderer/components/MessageContent.js';

describe('message content formatting', () => {
  it('renders prose, lists, and fenced code with semantic formatting', () => {
    const html = renderToStaticMarkup(<MessageContent text={'## Result\n\n- first\n- second\n\n```ts\nconst answer = 42;\n```'} />);

    expect(html).toContain('<h2>Result</h2>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<code class="language-ts">const answer = 42;');
  });

  it('opens links outside the Fleet renderer', () => {
    const html = renderToStaticMarkup(<MessageContent text="[Fleet](https://example.com)" />);

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });
});
