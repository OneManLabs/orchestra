import type { FleetJob } from '@fleet/shared';
import { describe, expect, it } from 'vitest';
import { codexInvocation, extractCodexOutput } from '../src/job-manager.js';

describe('Codex job protocol', () => {
  it('uses JSONL with the requested sandbox and approval policy', () => {
    const job: FleetJob = {
      id: 'job-1',
      name: 'Review',
      kind: 'codex',
      prompt: 'Review this repository.',
      status: 'queued',
      permissionMode: 'workspace-write',
      approvalPolicy: 'on-request',
      requiredLabels: [],
      createdAt: new Date(0).toISOString(),
      output: [],
    };
    const invocation = codexInvocation('codex', job, '/projects/fleet');
    expect(invocation.command).toBe('codex');
    expect(invocation.args).toContain('--json');
    expect(invocation.args).toContain('workspace-write');
    expect(invocation.args).toContain('approval_policy="on-request"');
    expect(invocation.args.at(-1)).toBe(job.prompt);
  });

  it('extracts useful display text while preserving raw events elsewhere', () => {
    expect(extractCodexOutput({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } })).toBe('Done.');
    expect(extractCodexOutput({ type: 'turn.started' })).toBe('turn.started');
  });
});
