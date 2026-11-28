import { describe, expect, it } from 'vitest';
import { cleanRepo, fillTemplate, newRecipe, normalizeTicket, planTicket, recipeError, type Recipe } from '../../src/shared/recipes.js';

const recipe = (over: Partial<Recipe> = {}): Recipe => ({
  ...newRecipe('C:\\repos\\project'),
  id: 'r1',
  name: 'Bug fix',
  sessions: [
    { profileId: 'builtin-claude', model: 'claude-opus-5-5', prompt: 'Read the ticket {ticket}, propose a plan, wait for my OK.' },
    { profileId: 'builtin-pwsh', model: null, prompt: '' },
  ],
  ...over,
});

describe('normalizeTicket', () => {
  it('takes a ticket code in any case, trimmed', () => {
    expect(normalizeTicket(' proj-7912 ')).toBe('PROJ-7912');
    expect(normalizeTicket('ABC2-1')).toBe('ABC2-1');
  });

  it('refuses anything that is not KEY-number', () => {
    for (const t of ['', '7912', 'PROJ123', 'PROJ-', '-12', 'PROJ-12a', 'PROJ-12 x', '../PROJ-1', 'PROJ-1;rm']) expect(normalizeTicket(t), t).toBeNull();
  });
});

describe('fillTemplate', () => {
  it('puts in the ticket, the ticket in lower case and the repository', () => {
    expect(fillTemplate('feat/{ticket-lower}', 'PROJ-7912', '/r/project')).toBe('feat/proj-7912');
    expect(fillTemplate('{repo}-{ticket-lower}', 'PROJ-7912', '/r/project')).toBe('/r/project-proj-7912');
    expect(fillTemplate('Read {ticket} and {ticket}', 'PROJ-1', '/r')).toBe('Read PROJ-1 and PROJ-1');
  });
});

describe('cleanRepo', () => {
  it('drops a trailing separator, so the worktree goes next to the repository, not inside it', () => {
    expect(cleanRepo(String.raw`C:\repos\project\ `)).toBe(String.raw`C:\repos\project`);
    expect(cleanRepo('/r/project//')).toBe('/r/project');
    expect(planTicket(recipe({ repo: String.raw`C:\repos\project\\` }), 'PROJ-7912')).toMatchObject({ worktree: String.raw`C:\repos\project-proj-7912` });
  });

  it('keeps a root as it is', () => {
    expect(cleanRepo(String.raw`C:\ `)).toBe(String.raw`C:\ `.trim());
    expect(cleanRepo('/')).toBe('/');
  });
});

describe('newRecipe', () => {
  it('starts with a feature branch from main, in a folder next to the repository', () => {
    expect(newRecipe('/r/project')).toMatchObject({ repo: '/r/project', base: 'main', branch: 'feat/{ticket-lower}', folder: '{repo}-{ticket-lower}', sessions: [] });
  });
});

describe('planTicket', () => {
  it('works out the area, the worktree, the branch and the sessions from a ticket', () => {
    expect(planTicket(recipe(), 'proj-7912')).toEqual({
      ticket: 'PROJ-7912',
      areaName: 'PROJ-7912',
      repo: 'C:\\repos\\project',
      base: 'main',
      branch: 'feat/proj-7912',
      worktree: 'C:\\repos\\project-proj-7912',
      sessions: [
        { profileId: 'builtin-claude', model: 'claude-opus-5-5', prompt: 'Read the ticket PROJ-7912, propose a plan, wait for my OK.' },
        { profileId: 'builtin-pwsh', model: null, prompt: '' },
      ],
    });
  });

  it('says why a ticket or a recipe gives no plan', () => {
    expect(planTicket(recipe(), 'nope')).toEqual({ error: expect.stringMatching(/ticket code/i) });
    expect(planTicket(recipe({ folder: 'relative/{ticket}' }), 'PROJ-1')).toEqual({ error: expect.stringMatching(/absolute/i) });
  });
});

describe('recipeError', () => {
  it('accepts a complete recipe', () => {
    expect(recipeError(recipe())).toBeNull();
  });

  it('wants a name, an absolute repository, a branch and a folder that name the ticket, and sessions', () => {
    expect(recipeError(recipe({ name: ' ' }))).toMatch(/name/i);
    expect(recipeError(recipe({ repo: 'repos/project' }))).toMatch(/absolute/i);
    expect(recipeError(recipe({ branch: 'feat/fixed' }))).toMatch(/branch/i);
    expect(recipeError(recipe({ folder: '{repo}-work' }))).toMatch(/folder/i);
    expect(recipeError(recipe({ base: '-x' }))).toMatch(/base/i);
    expect(recipeError(recipe({ sessions: [] }))).toMatch(/session/i);
    expect(recipeError(recipe({ sessions: [{ profileId: '', model: null, prompt: '' }] }))).toMatch(/launcher/i);
  });
});
