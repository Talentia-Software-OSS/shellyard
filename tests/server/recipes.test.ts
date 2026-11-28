import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { RecipeError, RecipeStore } from '../../src/server/recipes.js';
import { useTempHome } from '../helpers.js';

const good = {
  name: 'Bug fix',
  repo: '/r/project',
  base: 'main',
  branch: 'feat/{ticket-lower}',
  folder: '{repo}-{ticket-lower}',
  sessions: [{ profileId: 'builtin-claude', model: '', prompt: 'Read {ticket}' }],
};

describe('RecipeStore', () => {
  const home = useTempHome();
  let file: string;
  let store: RecipeStore;

  beforeEach(() => {
    file = join(home.dir(), 'recipes.json');
    store = new RecipeStore({ file });
  });

  it('keeps a valid recipe across a restart, tidied', () => {
    const r = store.create({ ...good, name: '  Bug fix ', extra: 1 });
    expect(r).toMatchObject({ name: 'Bug fix', sessions: [{ profileId: 'builtin-claude', model: null, prompt: 'Read {ticket}' }] });
    expect(new RecipeStore({ file }).list()).toEqual([r]);
  });

  it('refuses a recipe that cannot be used, saying why', () => {
    expect(() => store.create({ ...good, branch: 'main' })).toThrow(RecipeError);
    expect(() => store.create({ ...good, sessions: [] })).toThrow(/session/);
    expect(store.list()).toEqual([]);
  });

  it('changes and removes recipes', () => {
    const r = store.create(good);
    expect(store.update(r.id, { ...good, name: 'Feature' })).toMatchObject({ id: r.id, name: 'Feature' });
    expect(() => store.update(r.id, { ...good, repo: 'relative' })).toThrow(RecipeError);
    expect(store.get(r.id)!.name).toBe('Feature');
    expect(store.update('nope', good)).toBeNull();
    expect(store.remove(r.id)).toBe(true);
    expect(store.remove(r.id)).toBe(false);
  });

  it('reads a damaged file as no recipes, and skips entries that cannot be used', () => {
    writeFileSync(file, 'nope');
    expect(new RecipeStore({ file }).list()).toEqual([]);
    writeFileSync(file, JSON.stringify({ recipes: [{ id: 'a', ...good }, { id: 'b', ...good, folder: 'fixed' }, { ...good }] }));
    expect(new RecipeStore({ file }).list().map((r) => r.id)).toEqual(['a']);
  });
});
