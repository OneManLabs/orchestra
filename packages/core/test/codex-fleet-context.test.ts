import { describe, expect, it } from 'vitest';
import { fleetCodexDeveloperInstructions, fleetCodexTurnContext } from '../src/codex-fleet-context.js';

const baseContext = {
  fleetName: 'Orchestra Canvas',
  device: { id: 'macbook', name: 'MacBook Pro' },
  session: { cwd: '/Users/example/fleet' },
};

describe('Orchestra Codex context', () => {
  it('identifies Orchestra Canvas as the operator-facing surface for every device session', () => {
    const instructions = fleetCodexDeveloperInstructions(baseContext);

    expect(instructions).toContain('operating through Orchestra Canvas');
    expect(instructions).toContain('not through the Codex CLI UI, ChatGPT web, or the ChatGPT desktop app');
    expect(instructions).toContain('MacBook Pro (macbook)');
    expect(instructions).toContain('Orchestra clients connect to the Orchestra Core control plane');
    expect(instructions).toContain('Orchestra Agent on the selected execution device');
    expect(instructions).toContain('live device inventory and system-topology summary');
    expect(instructions).toContain('Tailscale Serve, Funnel, or a private direct-tailnet fallback');
    expect(instructions).toContain('Do not present localhost or 127.0.0.1');
    expect(instructions).toContain('Website/View Site control');
  });

  it('injects the authoritative Orchestra project and running tailnet preview into each turn', () => {
    const context = fleetCodexTurnContext({
      ...baseContext,
      project: {
        id: 'fleet-project',
        name: 'Orchestra',
        preview: {
          projectId: 'fleet-project', deviceId: 'macbook', cwd: '/Users/example/fleet', status: 'running', visibility: 'tailnet',
          framework: 'Web app', command: 'npm run dev:web', port: 3000, servePort: 38524, autoStartWithCodex: true,
          restartCount: 0, updatedAt: '2026-07-16T20:24:41.139Z', logs: [], url: 'http://100.64.0.10:38524/',
          transport: 'direct-tailnet',
        },
      },
    });

    expect(context).toContain('Surface: Orchestra Canvas (not Codex CLI UI or ChatGPT)');
    expect(context).toContain('Project: Orchestra (fleet-project)');
    expect(context).toContain('http://100.64.0.10:38524/ via direct-tailnet');
    expect(context).toContain('Website/View Site control should be available');
  });

  it('does not claim an Orchestra preview control when no preview is running', () => {
    const context = fleetCodexTurnContext(baseContext);

    expect(context).toContain('no registered Orchestra project matched');
    expect(context).toContain('no running Website/View Site target is confirmed');
  });
});
