import { describe, expect, it } from 'vitest';
import type { CreateSessionRequest, Profile, SessionInfo, Story } from '../../src/shared/types.js';
import type { Recipe } from '../../src/shared/recipes.js';
import { startFromTicket, TicketError, type TicketDeps } from '../../src/server/tickets.js';
import { session } from '../web/session-fixture.js';

const recipe: Recipe = {
  id: 'r1',
  name: 'Bug fix',
  repo: '/r/project',
  base: 'main',
  branch: 'feat/{ticket-lower}',
  folder: '{repo}-{ticket-lower}',
  sessions: [
    { profileId: 'claude', model: 'claude-opus-5-5', prompt: 'Read {ticket}, propose a plan.' },
    { profileId: 'pwsh', model: null, prompt: 'ignored for a shell' },
  ],
};

const profile = (id: string, kind: 'claude' | 'shell'): Profile => ({ id, name: id, kind, command: 'x', args: [], cwd: '', color: '#888888', env: {}, model: null });

function fakes(over: { branches?: string[]; worktreeFails?: boolean; storyFails?: boolean; stories?: Story[] } = {}) {
  const calls: string[] = [];
  const created: CreateSessionRequest[] = [];
  const delivered: Array<[string, string]> = [];
  let n = 0;
  const deps: TicketDeps = {
    recipe: (id) => (id === 'r1' ? recipe : null),
    stories: {
      list: () => over.stories ?? [],
      create: (input) => {
        calls.push(`story ${input.name} ${input.ticket} ${input.cwd}`);
        if (over.storyFails) throw new Error('config is read-only');
        return { id: 'story-1', name: input.name, ticket: input.ticket, cwd: input.cwd, color: '#123456', sound: '' };
      },
    },
    profiles: () => [profile('claude', 'claude'), profile('pwsh', 'shell')],
    createSession: (req) => {
      created.push(req);
      const kind = req.profileId === 'claude' ? 'claude' : 'shell';
      return { ...session(`s${++n}`, kind === 'claude' ? 'idle' : 'running', null, 0, kind), storyId: req.storyId ?? null } as SessionInfo;
    },
    deliverPrompt: (id, prompt) => delivered.push([id, prompt]),
    git: {
      branches: async () => over.branches ?? ['main'],
      createWorktree: async (repo, o) => {
        calls.push(`worktree ${repo} ${o.path} ${o.branch} new=${o.newBranch} base=${o.base ?? '-'}`);
        if (over.worktreeFails) throw new Error('fatal: already exists');
        return { current: repo, worktrees: [] };
      },
      removeWorktree: async (repo, path, o) => {
        calls.push(`remove ${repo} ${path} deleteBranch=${o.deleteBranch}`);
      },
    },
    gitMessage: (e) => (e as Error).message,
    refreshGit: async () => undefined,
  };
  return { deps, calls, created, delivered };
}

describe('startFromTicket', () => {
  it('makes the worktree on a new branch, the area in it, and the sessions with their prompt', async () => {
    const f = fakes();
    const out = await startFromTicket(f.deps, 'r1', 'proj-7912');
    expect(f.calls).toEqual(['worktree /r/project /r/project-proj-7912 feat/proj-7912 new=true base=main', 'story PROJ-7912 PROJ-7912 /r/project-proj-7912']);
    expect(f.created).toEqual([
      { profileId: 'claude', storyId: 'story-1', cwd: '/r/project-proj-7912', model: 'claude-opus-5-5' },
      { profileId: 'pwsh', storyId: 'story-1', cwd: '/r/project-proj-7912' },
    ]);
    expect(f.delivered).toEqual([['s1', 'Read PROJ-7912, propose a plan.']]);
    expect(out).toMatchObject({ newBranch: true, story: { id: 'story-1' } });
    expect(out.sessions).toHaveLength(2);
  });

  it('checks out a branch that already exists instead of making it again', async () => {
    const f = fakes({ branches: ['main', 'feat/proj-7912'] });
    await startFromTicket(f.deps, 'r1', 'PROJ-7912');
    expect(f.calls[0]).toBe('worktree /r/project /r/project-proj-7912 feat/proj-7912 new=false base=-');
  });

  it('refuses a bad ticket, an unknown recipe, and a ticket that already has an area, touching nothing', async () => {
    const f = fakes({ stories: [{ id: 'x', name: 'Payroll slots', ticket: 'proj-7912', cwd: '', color: '', sound: '' }] });
    await expect(startFromTicket(f.deps, 'r1', 'nope')).rejects.toMatchObject({ status: 400 });
    await expect(startFromTicket(f.deps, 'other', 'PROJ-1')).rejects.toMatchObject({ status: 404 });
    await expect(startFromTicket(f.deps, 'r1', 'PROJ-7912')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Payroll slots') });
    expect(f.calls).toEqual([]);
  });

  it('refuses a recipe whose launcher is gone, before making anything', async () => {
    const f = fakes();
    f.deps.profiles = () => [profile('claude', 'claude')];
    await expect(startFromTicket(f.deps, 'r1', 'PROJ-1')).rejects.toThrow(/pwsh/);
    expect(f.calls).toEqual([]);
  });

  it('says what git said when the worktree cannot be made, and makes no area', async () => {
    const f = fakes({ worktreeFails: true });
    const e = await startFromTicket(f.deps, 'r1', 'PROJ-1').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TicketError);
    expect(e).toMatchObject({ status: 409, message: 'fatal: already exists' });
    expect(f.calls.some((c) => c.startsWith('story'))).toBe(false);
  });

  it('takes the worktree and its new branch away again when the area cannot be made', async () => {
    const f = fakes({ storyFails: true });
    await expect(startFromTicket(f.deps, 'r1', 'PROJ-1')).rejects.toMatchObject({ status: 409 });
    expect(f.calls.at(-1)).toBe('remove /r/project /r/project-proj-1 deleteBranch=true');
    expect(f.created).toEqual([]);
  });
});
