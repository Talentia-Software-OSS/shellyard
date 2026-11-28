// "Start from ticket": one ticket code and a recipe give an area, a worktree on its own branch
// and the sessions to work in it. The plan is worked out here, so that the page shows exactly
// what the server will do.

export interface RecipeSession {
  /** The launcher the session starts from. */
  profileId: string;
  /** Null: the launcher's own model. */
  model: string | null;
  /** Typed into a Claude session once it is ready; '' for none. May name {ticket}. */
  prompt: string;
}

export interface Recipe {
  id: string;
  name: string;
  /** The repository the worktree is made from (any of its worktrees will do). */
  repo: string;
  /** The branch a new branch starts from. */
  base: string;
  /** The branch of the worktree, e.g. "feat/{ticket-lower}". */
  branch: string;
  /** The folder of the worktree, e.g. "{repo}-{ticket-lower}". */
  folder: string;
  sessions: RecipeSession[];
}

export interface TicketPlan {
  ticket: string;
  areaName: string;
  repo: string;
  base: string;
  branch: string;
  worktree: string;
  sessions: RecipeSession[];
}

/** "proj-123" as "PROJ-123"; null unless it is a project key followed by a dash and number. */
export function normalizeTicket(raw: string): string | null {
  const t = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9]*-\d+$/.test(t) ? t : null;
}

/** Fills {ticket} (PROJ-123), {ticket-lower} (proj-123) and {repo} (the repository folder). */
export function fillTemplate(template: string, ticket: string, repo: string): string {
  return template.replaceAll('{ticket-lower}', ticket.toLowerCase()).replaceAll('{ticket}', ticket).replaceAll('{repo}', repo);
}

/** An absolute folder on Windows (C:\, \\server) or elsewhere (/). */
function isAbsolutePath(p: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p);
}

/**
 * The repository folder without a trailing separator, so that "{repo}-{ticket}" names a folder
 * next to it, not one inside it. A root (C:\, /) keeps its separator.
 */
export function cleanRepo(repo: string): string {
  const r = repo.trim();
  if (/^(?:[A-Za-z]:[\\/]?|[\\/]+)$/.test(r)) return r;
  return r.replace(/[\\/]+$/, '');
}

const NAMES_TICKET = /\{ticket(?:-lower)?\}/;

/** A recipe with the usual choices, for the repository given. */
export function newRecipe(repo: string): Omit<Recipe, 'id'> {
  return { name: '', repo, base: 'main', branch: 'feat/{ticket-lower}', folder: '{repo}-{ticket-lower}', sessions: [] };
}

/** What is missing or wrong in a recipe, or null when it can be used. */
export function recipeError(r: Omit<Recipe, 'id'>): string | null {
  if (!r.name.trim()) return 'Give the recipe a name.';
  if (!isAbsolutePath(r.repo.trim())) return 'The repository must be an absolute folder.';
  if (!r.base.trim() || r.base.trim().startsWith('-')) return 'Give the base branch a new branch starts from, such as main.';
  if (!NAMES_TICKET.test(r.branch)) return 'The branch must name the ticket, with {ticket} or {ticket-lower}.';
  if (!NAMES_TICKET.test(r.folder)) return 'The folder must name the ticket, with {ticket} or {ticket-lower}, so that each ticket has its own.';
  if (r.sessions.length === 0) return 'Add at least one session to start.';
  if (r.sessions.some((s) => !s.profileId)) return 'Choose a launcher for every session.';
  return null;
}

/** What a ticket and a recipe come to; an error when either cannot be used. */
export function planTicket(r: Omit<Recipe, 'id'>, rawTicket: string): TicketPlan | { error: string } {
  const ticket = normalizeTicket(rawTicket);
  if (!ticket) return { error: 'Write a ticket code such as PROJ-123.' };
  const problem = recipeError(r);
  if (problem) return { error: problem };
  const repo = cleanRepo(r.repo);
  const worktree = fillTemplate(r.folder.trim(), ticket, repo);
  if (!isAbsolutePath(worktree)) return { error: 'The folder of the worktree must come to an absolute path; start it with {repo} or a drive.' };
  return {
    ticket,
    areaName: ticket,
    repo,
    base: r.base.trim(),
    branch: fillTemplate(r.branch.trim(), ticket, repo),
    worktree,
    sessions: r.sessions.map((s) => ({ profileId: s.profileId, model: s.model, prompt: fillTemplate(s.prompt, ticket, repo) })),
  };
}
