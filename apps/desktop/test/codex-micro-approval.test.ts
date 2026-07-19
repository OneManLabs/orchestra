import { describe, expect, it } from 'vitest';
import type { CodexApproval } from '@fleet/shared';
import { approvalResponse, firstMissingApprovalQuestion } from '../src/renderer/lib/codex-approval-response.js';

function approval(method: string, params: unknown): CodexApproval {
  return { id: 'approval-1', requestId: 'request-1', method, title: 'Review', detail: 'Review this request', params, createdAt: '2026-07-18T12:00:00.000Z' };
}

describe('Codex Micro structured approval responses', () => {
  it('submits currently selected structured question answers', () => {
    const request = approval('item/tool/requestUserInput', { questions: [{ id: 'choice', header: 'Choose', options: [{ label: 'Yes' }] }] });
    expect(approvalResponse(request, 'accept', { choice: 'Yes' }, '{}')).toEqual({ answers: { choice: { answers: ['Yes'] } } });
    expect(approvalResponse(request, 'decline', { choice: 'Yes' }, '{}')).toEqual({ answers: {} });
  });

  it('detects and identifies the first unanswered required question', () => {
    const request = approval('item/tool/requestUserInput', { questions: [{ id: 'first', header: 'First' }, { id: 'second', question: 'Second question' }] });
    expect(firstMissingApprovalQuestion(request, { first: 'done' })).toEqual({ id: 'second', label: 'Second question' });
    expect(firstMissingApprovalQuestion(request, { first: 'done', second: 'done' })).toBeNull();
  });

  it('keeps simple permissions direct and cancels elicitation with an empty response', () => {
    const permissions = approval('item/permissions/requestApproval', { permissions: { network: true, filesystem: 'workspace' } });
    expect(approvalResponse(permissions, 'accept', {}, '{}')).toEqual({ permissions: { network: true, filesystem: 'workspace' }, scope: 'turn' });
    const elicitation = approval('mcpServer/elicitation/request', {});
    expect(approvalResponse(elicitation, 'decline', {}, '{"value":"ignored"}')).toEqual({ action: 'decline', content: null, _meta: null });
  });
});
