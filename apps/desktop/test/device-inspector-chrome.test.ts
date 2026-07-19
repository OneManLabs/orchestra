import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
const inspector = readFileSync(new URL('../src/renderer/components/DeviceInspector.tsx', import.meta.url), 'utf8');

describe('device inspector Electron window chrome', () => {
  it('keeps the inspector and its close control outside the draggable macOS title-bar region', () => {
    expect(styles).toMatch(/\.inspector\s*\{[^}]*-webkit-app-region:\s*no-drag/);
    expect(styles).toMatch(/\.inspector__close\s*\{[^}]*-webkit-app-region:\s*no-drag/);
    expect(inspector).toContain('type="button" className="icon-button inspector__close"');
    expect(inspector).toContain('onClick={onClose} aria-label="Close inspector"');
  });

  it('jumps a newly selected Codex transcript to the newest message without smooth-scroll replay', () => {
    expect(styles).toMatch(/\.chat-feed\s*\{[^}]*scroll-behavior:\s*auto/);
    expect(inspector).toContain('useLayoutEffect(() => {');
    expect(inspector).toContain('scroll.current.scrollTop = scroll.current.scrollHeight');
  });

  it('keeps Micro rotation local and isolates its high-frequency overlay render', () => {
    const dialStart = inspector.indexOf('function openModelDial');
    const dialEnd = inspector.indexOf('useEffect(() => window.fleetDesktop?.codexMicro.onAction', dialStart);
    expect(dialStart).toBeGreaterThan(0);
    expect(dialEnd).toBeGreaterThan(dialStart);
    expect(inspector.slice(dialStart, dialEnd)).not.toContain("'model/list'");
    expect(inspector).toContain('const CodexDialOverlay = forwardRef');
    expect(inspector).toContain('presets: CODEX_MICRO_MODEL_PRESETS');
    expect(inspector).toContain('Local preview — press knob to apply');
  });
});
