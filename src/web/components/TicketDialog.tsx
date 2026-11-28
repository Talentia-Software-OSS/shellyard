import { useEffect, useState } from 'react';
import { newRecipe, planTicket, recipeError, type Recipe, type RecipeSession } from '../../shared/recipes.js';
import { api } from '../api.js';
import { useEscape } from '../escape.js';
import { modelLabel } from '../session-text.js';
import { useStore } from '../store.js';
import { FolderPicker } from './FolderPicker.js';

type Draft = Omit<Recipe, 'id'> & { id: string | null };

/** Edits a recipe: where the worktree comes from and goes, and the sessions it starts. */
function RecipeForm({ draft, onSaved, onCancel }: { draft: Draft; onSaved: (r: Recipe) => void; onCancel: () => void }): React.JSX.Element {
  const { meta } = useStore();
  const [r, setR] = useState<Draft>(draft);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>): void => setR((x) => ({ ...x, ...patch }));
  const setSession = (i: number, patch: Partial<RecipeSession>): void => set({ sessions: r.sessions.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const firstLauncher = meta.profiles[0]?.id ?? '';

  const save = async (): Promise<void> => {
    const { id, ...fields } = r;
    const problem = recipeError(fields);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      onSaved(id ? await api.updateRecipe(id, fields) : await api.createRecipe(fields));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!r.id || !window.confirm(`Delete the recipe "${r.name}"?`)) return;
    try {
      await api.deleteRecipe(r.id);
      onCancel();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="recipe-form">
      <label>
        <span>Recipe name</span>
        <input value={r.name} onChange={(e) => set({ name: e.target.value })} placeholder="Bug fix" autoFocus />
      </label>
      <div className="dialog-field">
        <span id="recipe-repo-label">Repository</span>
        <FolderPicker value={r.repo} onChange={(repo) => set({ repo })} placeholder="The folder of the repository" labelledBy="recipe-repo-label" />
      </div>
      <div className="recipe-row">
        <label>
          <span>Base branch</span>
          <input value={r.base} onChange={(e) => set({ base: e.target.value })} spellCheck={false} />
        </label>
        <label>
          <span>New branch</span>
          <input value={r.branch} onChange={(e) => set({ branch: e.target.value })} spellCheck={false} />
        </label>
      </div>
      <label>
        <span>Worktree folder</span>
        <input value={r.folder} onChange={(e) => set({ folder: e.target.value })} spellCheck={false} />
      </label>
      <p className="hint">
        <code>{'{ticket}'}</code> is the code as PROJ-123, <code>{'{ticket-lower}'}</code> as proj-123, <code>{'{repo}'}</code> the repository folder.
      </p>

      <fieldset className="recipe-sessions">
        <legend>Sessions to start</legend>
        {r.sessions.map((s, i) => {
          const profile = meta.profiles.find((p) => p.id === s.profileId);
          return (
            <div key={i} className="recipe-session">
              <div className="recipe-row">
                <label>
                  <span>Launcher</span>
                  <select value={s.profileId} onChange={(e) => setSession(i, { profileId: e.target.value })}>
                    {!profile && <option value={s.profileId}>{s.profileId || 'Choose…'}</option>}
                    {meta.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                {profile?.kind === 'claude' && (
                  <label>
                    <span>Model</span>
                    <select value={s.model ?? ''} onChange={(e) => setSession(i, { model: e.target.value || null })}>
                      <option value="">The launcher's</option>
                      {meta.models.map((m) => (
                        <option key={m} value={m}>
                          {modelLabel(m)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button type="button" className="icon-button" aria-label={`Remove session ${i + 1}`} title="Remove this session" onClick={() => set({ sessions: r.sessions.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
              {profile?.kind === 'claude' && (
                <label>
                  <span>Prompt</span>
                  <textarea rows={2} value={s.prompt} onChange={(e) => setSession(i, { prompt: e.target.value })} placeholder="Read the ticket {ticket}, propose a plan, wait for my OK." />
                </label>
              )}
            </div>
          );
        })}
        <button type="button" disabled={!firstLauncher} onClick={() => set({ sessions: [...r.sessions, { profileId: firstLauncher, model: null, prompt: '' }] })}>
          Add a session
        </button>
      </fieldset>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-buttons">
        {r.id && (
          <button type="button" className="danger-link" onClick={() => void remove()}>
            Delete recipe
          </button>
        )}
        <button type="button" onClick={onCancel}>
          Back
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          Save recipe
        </button>
      </div>
    </div>
  );
}

/**
 * Start from ticket: one code and a recipe give an area, a worktree on its own branch and the
 * sessions to work in it, each Claude one with its first prompt. The steps are shown before
 * anything is done.
 */
export function TicketDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { meta } = useStore();
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [recipeId, setRecipeId] = useState('');
  const [ticket, setTicket] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEscape(() => (editing ? setEditing(null) : onClose()));

  const load = async (select?: string): Promise<void> => {
    try {
      const list = await api.recipes();
      setRecipes(list);
      setRecipeId((current) => select ?? (list.some((r) => r.id === current) ? current : (list[0]?.id ?? '')));
      if (list.length === 0) setEditing({ id: null, ...newRecipe(''), name: 'Bug fix' });
    } catch (e) {
      setError((e as Error).message);
      setRecipes([]);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const recipe = recipes?.find((r) => r.id === recipeId) ?? null;
  const plan = recipe && ticket.trim() ? planTicket(recipe, ticket) : null;
  const launcher = (id: string): string => meta.profiles.find((p) => p.id === id)?.name ?? id;

  const start = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!recipe || !plan || 'error' in plan) return;
    setBusy(true);
    setError(null);
    try {
      await api.startTicket(recipe.id, ticket);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog ticket-dialog" role="dialog" aria-modal="true" aria-labelledby="ticket-title">
        <h2 id="ticket-title">{editing ? (editing.id ? 'Edit recipe' : 'New recipe') : 'Start from ticket'}</h2>
        {editing ? (
          <RecipeForm
            draft={editing}
            onSaved={(r) => {
              setEditing(null);
              void load(r.id);
            }}
            onCancel={() => {
              // With no recipe there is nothing to go back to.
              if (!recipes?.length && !editing.id) return onClose();
              setEditing(null);
              void load();
            }}
          />
        ) : (
          <form onSubmit={(e) => void start(e)} className="ticket-form">
            <div className="recipe-row">
              <label>
                <span>Ticket</span>
                <input className="ticket-code" value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="PROJ-123" spellCheck={false} autoFocus />
              </label>
              <label>
                <span>Recipe</span>
                <select value={recipeId} onChange={(e) => setRecipeId(e.target.value)} disabled={!recipes?.length}>
                  {recipes?.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="ticket-recipe-links">
              {recipe && (
                <button type="button" className="ny-link" onClick={() => setEditing({ ...recipe })}>
                  Edit this recipe
                </button>
              )}
              <button type="button" className="ny-link" onClick={() => setEditing({ id: null, ...newRecipe(recipe?.repo ?? ''), name: '' })}>
                New recipe
              </button>
            </div>

            {plan && 'error' in plan && <p className="hint">{plan.error}</p>}
            {plan && !('error' in plan) && (
              <ol className="ticket-steps" aria-label="What will be done">
                <li>
                  Area <strong>{plan.areaName}</strong> with its own colour, in <code>{plan.worktree}</code>
                </li>
                <li>
                  Worktree on branch <code>{plan.branch}</code>, new from <code>{plan.base}</code> (or the branch as it is, if it exists)
                </li>
                {plan.sessions.map((s, i) => (
                  <li key={i}>
                    {launcher(s.profileId)}
                    {s.model ? ` · ${modelLabel(s.model)}` : ''}
                    {s.prompt.trim() && meta.profiles.find((p) => p.id === s.profileId)?.kind === 'claude' && <> with the prompt “{s.prompt.trim()}”</>}
                  </li>
                ))}
              </ol>
            )}

            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-buttons">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy || !plan || 'error' in plan}>
                {busy ? 'Starting…' : 'Start'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
