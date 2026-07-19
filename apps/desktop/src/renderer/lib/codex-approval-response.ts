import type { CodexApproval } from '@fleet/shared';

export function firstMissingApprovalQuestion(approval: CodexApproval, answers: Record<string, string>): { id: string; label: string } | null {
  const params = record(approval.params);
  const questions = Array.isArray(params.questions) ? params.questions.map(record) : [];
  const missing = questions.find((question) => !answers[String(question.id ?? 'answer')]?.trim());
  if (!missing) return null;
  const id = String(missing.id ?? 'answer');
  return { id, label: String(missing.header ?? missing.question ?? id) };
}

export function approvalResponse(approval: CodexApproval, decision: 'accept' | 'acceptForSession' | 'decline', answers: Record<string, string>, content: string): unknown {
  const params = record(approval.params);
  if (approval.method === 'item/tool/requestUserInput') return { answers: decision !== 'decline' ? Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, { answers: [answer] }])) : {} };
  if (approval.method === 'item/permissions/requestApproval') { const requested = record(params.permissions); const permissions = decision !== 'decline' ? Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== null && value !== undefined)) : {}; return { permissions, scope: decision === 'acceptForSession' ? 'session' : 'turn' }; }
  if (approval.method === 'mcpServer/elicitation/request') { let parsed: unknown = null; if (decision !== 'decline') { try { parsed = JSON.parse(content) as unknown; } catch { parsed = { value: content }; } } return { action: decision === 'decline' ? 'decline' : 'accept', content: parsed, _meta: null }; }
  return { decision };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
