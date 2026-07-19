import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
const systemPage = readFileSync(new URL('../src/renderer/pages/SystemPage.tsx', import.meta.url), 'utf8');

describe('desktop page scrolling contract', () => {
  it('lets the workspace grid shrink and gives ordinary pages a scroll viewport', () => {
    expect(styles).toMatch(/\.workspace\s*\{[^}]*min-height:\s*0[^}]*height:\s*100%[^}]*overflow:\s*hidden/);
    expect(styles).toMatch(/\.page-host\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/);
    expect(styles).toMatch(/\.page\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/);
  });

  it('keeps Fleet System chat history in its own vertical scroll viewport', () => {
    expect(styles).toMatch(/\.system-chat\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0,1fr\) auto/);
    expect(styles).toMatch(/\.system-chat__feed\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/);
  });

  it('exposes Core-backed new and clear conversation controls', () => {
    expect(systemPage).toContain('api.newSystemConversation()');
    expect(systemPage).toContain('api.clearSystemConversation()');
    expect(systemPage).toContain('SystemConversationPicker');
  });
});
