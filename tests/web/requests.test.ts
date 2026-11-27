import { describe, expect, it } from 'vitest';
import type { PendingRequest, SessionInfo } from '../../src/shared/types.js';
import { answerable, areaRuleFor, askLine, requestKind, requestSummary } from '../../src/web/requests.js';
import { session } from './session-fixture.js';

const pending = (over: Partial<PendingRequest> = {}): PendingRequest => ({ id: 'r1', kind: 'permission', tool: 'Bash', detail: 'dotnet test', message: null, since: 0, ...over });
const blocked = (p: PendingRequest | null): SessionInfo => ({ ...session('s', 'attention', 'blocked'), cwd: 'C:/repos/project', pending: p });

describe('requestKind', () => {
  it('tells permissions, questions, guesses and finished turns apart', () => {
    expect(requestKind(blocked(pending()))).toBe('permission');
    expect(requestKind(blocked(pending({ kind: 'question' })))).toBe('question');
    expect(requestKind(blocked(null))).toBe('permission');
    expect(requestKind(session('m', 'attention', 'maybe-waiting'))).toBe('maybe');
    expect(requestKind(session('f', 'attention', 'finished'))).toBe('finished');
  });
});

describe('answerable', () => {
  it('is true only for a known permission request of a blocked session', () => {
    expect(answerable(blocked(pending()))).toBe(true);
    expect(answerable(blocked(null))).toBe(false);
    expect(answerable(blocked(pending({ detail: null })))).toBe(false);
    expect(answerable(blocked(pending({ kind: 'question' })))).toBe(false);
    expect(answerable({ ...blocked(pending()), status: 'working', reason: null })).toBe(false);
  });
});

describe('askLine', () => {
  it('names a command, another tool, or neither, and the folder', () => {
    expect(askLine(blocked(pending()))).toBe('Allow this command in C:/repos/project?');
    expect(askLine(blocked(pending({ tool: 'Edit' })))).toBe('Allow Edit here in C:/repos/project?');
    expect(askLine({ ...blocked(pending({ tool: null })), liveCwd: 'C:/repos/project/src' })).toBe('Allow this in C:/repos/project/src?');
  });
});

describe('requestSummary', () => {
  it('says the kind and what is asked', () => {
    expect(requestSummary(blocked(pending()))).toBe('Permission · dotnet test');
    expect(requestSummary(blocked(pending({ kind: 'question', tool: null, detail: null, message: 'Which version?' })))).toBe('Question · Which version?');
    expect(requestSummary(blocked(null))).toBe('Permission');
    expect(requestSummary(session('f', 'attention', 'finished'))).toBe('Finished');
  });
});

describe('areaRuleFor', () => {
  const areas = new Set(['story-a']);
  const inArea = (p: PendingRequest | null): SessionInfo => ({ ...blocked(p), storyId: 'story-a' });

  it('shows the rule a Bash command of a session in an area would add', () => {
    expect(areaRuleFor(inArea(pending({ detail: 'dotnet test src/X --filter Slot' })), areas)).toBe('dotnet test *');
  });

  it('offers nothing outside an area, for another tool, or for a command that cannot be a rule', () => {
    expect(areaRuleFor(blocked(pending()), areas)).toBeNull();
    expect(areaRuleFor({ ...blocked(pending()), storyId: 'gone' }, areas)).toBeNull();
    expect(areaRuleFor(inArea(pending({ tool: 'Edit', detail: 'a.cs' })), areas)).toBeNull();
    expect(areaRuleFor(inArea(pending({ detail: 'dotnet test && rm -rf /' })), areas)).toBeNull();
    expect(areaRuleFor(inArea(pending({ detail: `dotnet ${'x'.repeat(10)}…` })), areas)).toBeNull();
    expect(areaRuleFor(inArea(null), areas)).toBeNull();
  });
});
