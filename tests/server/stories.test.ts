import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadConfig, saveConfig } from '../../src/server/config.js';
import { createRequestHandler } from '../../src/server/http.js';
import { SessionManager } from '../../src/server/session-manager.js';
import { StoryStore } from '../../src/server/stories.js';
import { ClosedStore } from '../../src/server/closed.js';
import { UsageStore } from '../../src/server/usage.js';
import { attachWebSocket } from '../../src/server/ws.js';
import type { Profile, ServerMessage, Story } from '../../src/shared/types.js';
import { fakePtyFactory, useTempHome, waitUntil } from '../helpers.js';

const node = process.execPath;
const profile: Profile = { id: 'p1', name: 'Node', kind: 'shell', command: node, args: [], cwd: '', color: '#123456', env: {}, model: null, background: null, font: null };

describe('StoryStore', () => {
  const home = useTempHome();

  it('reorders, saves and emits', () => {
    const store = new StoryStore();
    const [a, b, c] = ['A', 'B', 'C'].map((name) => store.create({ name }));
    const seen: string[][] = [];
    store.onChange((s) => seen.push(s.map((x) => x.name)));
    const out = store.reorder([c!.id, 'nope', a!.id, c!.id]);
    expect(out.map((x) => x.name)).toEqual(['C', 'A', 'B']);
    expect(new StoryStore().list().map((x) => x.id)).toEqual([c!.id, a!.id, b!.id]);
    expect(seen).toEqual([['C', 'A', 'B']]);
  });

  it('starts empty', () => {
    expect(new StoryStore().list()).toEqual([]);
  });

  it('creates a story with an id and trimmed fields, and keeps it on disk', () => {
    const store = new StoryStore();
    const s = store.create({ name: '  Payroll export ', ticket: ' HCM-1234 ', cwd: home.dir(), color: '#ff0000' });
    expect(s).toEqual({ id: s.id, name: 'Payroll export', ticket: 'HCM-1234', cwd: home.dir(), color: '#ff0000', sound: '' });
    expect(s.id).toMatch(/^story-/);
    expect(new StoryStore().list()).toEqual([s]);
  });

  it('leaves optional fields empty, and never keeps as a colour something that is not one', () => {
    const s = new StoryStore().create({ name: 'A', color: 'javascript:alert(1)' });
    expect(s).toMatchObject({ ticket: '', cwd: '' });
    expect(s.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('refuses a blank name', () => {
    expect(() => new StoryStore().create({ name: '   ' })).toThrow(/name/i);
  });

  it('gives two stories with the same name different ids', () => {
    const store = new StoryStore();
    expect(store.create({ name: 'A' }).id).not.toBe(store.create({ name: 'A' }).id);
  });

  it('updates only the given fields and ignores a blank name', () => {
    const store = new StoryStore();
    const s = store.create({ name: 'A', ticket: 'T-1' });
    expect(store.update(s.id, { name: 'B' })).toMatchObject({ name: 'B', ticket: 'T-1' });
    expect(store.update(s.id, { name: '  ', ticket: '' })).toMatchObject({ name: 'B', ticket: '' });
    expect(store.update('nope', { name: 'X' })).toBeNull();
  });

  it('removes a story', () => {
    const store = new StoryStore();
    const a = store.create({ name: 'A' });
    const b = store.create({ name: 'B' });
    expect(store.remove(a.id)).toBe(true);
    expect(store.remove(a.id)).toBe(false);
    expect(store.list()).toEqual([b]);
  });

  it('announces every change with the full list', () => {
    const store = new StoryStore();
    const seen: Story[][] = [];
    store.onChange((s) => seen.push(s));
    const a = store.create({ name: 'A' });
    store.update(a.id, { name: 'B' });
    store.remove(a.id);
    expect(seen.map((l) => l.map((s) => s.name))).toEqual([['A'], ['B'], []]);
  });

  it('refuses to save over a config.json that is being edited and does not parse', () => {
    const store = new StoryStore();
    store.create({ name: 'A' });
    const edited = '{ "stories": [], "profiles": [ {"id":"mine", } ] }';
    writeFileSync(join(home.dir(), 'config.json'), edited);
    expect(() => store.create({ name: 'B' })).toThrow(/config\.json/);
    expect(() => store.remove(store.list()[0]?.id ?? 'x')).toThrow(/config\.json/);
    expect(readFileSync(join(home.dir(), 'config.json'), 'utf8')).toBe(edited);
  });

  it('does not disturb profiles or other settings when it saves', () => {
    saveConfig({ profiles: [profile], models: ['opus'], silenceMs: 9000, stories: [], restoreSessions: true, profileOrder: [], soundFiles: [], sounds: { blocked: null, finished: null, maybeWaiting: null }, lan: { enabled: false, port: 7718 } });
    new StoryStore().create({ name: 'A' });
    const { config } = loadConfig();
    expect(config.profiles).toEqual([profile]);
    expect(config.models).toEqual(['opus']);
    expect(config.silenceMs).toBe(9000);
    expect(config.stories).toHaveLength(1);
  });
});

describe('stories in config.json', () => {
  const home = useTempHome();

  it('reads a file written before stories existed', () => {
    writeFileSync(join(home.dir(), 'config.json'), JSON.stringify({ profiles: [profile], models: ['opus'], silenceMs: 6000 }));
    const { config, warning } = loadConfig();
    expect(warning).toBeNull();
    expect(config.stories).toEqual([]);
    expect(config.profiles).toEqual([profile]);
  });

  it('drops malformed story entries and keeps the good ones', () => {
    writeFileSync(
      join(home.dir(), 'config.json'),
      JSON.stringify({ stories: [{ id: 's1', name: 'Good', ticket: 5 }, { id: 's2' }, { name: 'No id' }, 'text', null, { id: 's3', name: '  ' }] }),
    );
    expect(loadConfig().config.stories).toEqual([{ id: 's1', name: 'Good', ticket: '', cwd: '', color: '', sound: '' }]);
  });

  it('keeps only the first of two entries with the same id', () => {
    writeFileSync(join(home.dir(), 'config.json'), JSON.stringify({ stories: [{ id: 's1', name: 'First' }, { id: 's1', name: 'Second' }, { id: 's2', name: 'Other' }] }));
    expect(loadConfig().config.stories.map((s) => s.name)).toEqual(['First', 'Other']);
  });

  it('ignores stories that is not a list', () => {
    writeFileSync(join(home.dir(), 'config.json'), JSON.stringify({ stories: { a: 1 } }));
    expect(loadConfig().config.stories).toEqual([]);
  });
});

describe('sessions and stories', () => {
  const home = useTempHome();
  let ptys: ReturnType<typeof fakePtyFactory>;
  let store: StoryStore;
  let mgr: SessionManager;
  let workA = '';

  beforeEach(() => {
    ptys = fakePtyFactory();
    store = new StoryStore();
    workA = join(home.dir(), 'story-a');
    mkdirSync(workA);
    mgr = new SessionManager({
      ptyFactory: ptys.factory,
      now: Date.now,
      config: () => loadConfig().config,
      port: 1,
      hookToken: 'h',
      hookScriptPath: '/h.js', statusScriptPath: '/s.js',
      builtins: () => [profile],
      stories: () => store.list(),
      gitOf: async () => null,
      headOf: () => null,
    });
  });

  it('a session belongs to no story unless asked', () => {
    expect(mgr.create({ kind: 'shell', command: node, cwd: home.dir() }).storyId).toBeNull();
  });

  it('a session created in a story starts in the story folder and takes its colour', () => {
    const story = store.create({ name: 'A', cwd: workA, color: '#ff0000' });
    const s = mgr.create({ profileId: 'p1', storyId: story.id });
    expect(s).toMatchObject({ storyId: story.id, cwd: workA, color: '#ff0000', status: 'running' });
    expect(ptys.last().opts.cwd).toBe(workA);
  });

  it('the request still decides folder and colour when it gives them', () => {
    const story = store.create({ name: 'A', cwd: workA, color: '#ff0000' });
    const s = mgr.create({ profileId: 'p1', storyId: story.id, cwd: home.dir(), color: '#00ff00' });
    expect(s).toMatchObject({ cwd: home.dir(), color: '#00ff00' });
  });

  it('a story with no folder or colour leaves the profile defaults in place', () => {
    const story = store.create({ name: 'A' });
    store.update(story.id, { color: '' }); // as an area saved before colours were automatic
    const s = mgr.create({ profileId: 'p1', storyId: story.id, cwd: home.dir() });
    expect(s).toMatchObject({ storyId: story.id, color: '#123456' });
  });

  it('a story id that does not exist leaves the session ungrouped, and running', () => {
    const s = mgr.create({ kind: 'shell', command: node, cwd: home.dir(), storyId: 'ghost' });
    expect(s).toMatchObject({ storyId: null, status: 'running' });
  });

  it('moves a session into a story, to another, and out', () => {
    const a = store.create({ name: 'A' });
    const b = store.create({ name: 'B' });
    const s = mgr.create({ kind: 'shell', command: node, cwd: home.dir() });
    expect(mgr.update(s.id, { storyId: a.id })!.storyId).toBe(a.id);
    expect(mgr.update(s.id, { storyId: b.id })!.storyId).toBe(b.id);
    expect(mgr.update(s.id, { name: 'renamed' })!.storyId).toBe(b.id);
    expect(mgr.update(s.id, { storyId: null })!.storyId).toBeNull();
    expect(mgr.update(s.id, { storyId: 'ghost' })!.storyId).toBeNull();
  });

  it('clearStory ungroups its sessions without stopping them, and announces it', () => {
    const a = store.create({ name: 'A' });
    const b = store.create({ name: 'B' });
    const s1 = mgr.create({ kind: 'shell', command: node, cwd: home.dir(), storyId: a.id });
    const p1 = ptys.last();
    const s2 = mgr.create({ kind: 'shell', command: node, cwd: home.dir(), storyId: b.id });
    let changes = 0;
    mgr.onChange(() => changes++);
    mgr.clearStory(a.id);
    expect(mgr.get(s1.id)).toMatchObject({ storyId: null, status: 'running' });
    expect(mgr.get(s2.id)!.storyId).toBe(b.id);
    expect(p1.killed).toBe(false);
    expect(changes).toBe(1);
  });
});

describe('stories over http and websocket', () => {
  const home = useTempHome();
  const TOKEN = 't'.repeat(64);
  const PAGE = 'e'.repeat(32) + '.localhost';
  let server: Server;
  let base = '';
  let port = 0;
  let mgr: SessionManager;
  let store: StoryStore;
  let ptys: ReturnType<typeof fakePtyFactory>;
  let wsHandle: { close(): void };
  const sockets: WebSocket[] = [];

  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(base + path, { method, headers: { 'x-shellyard-token': TOKEN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  beforeEach(async () => {
    ptys = fakePtyFactory();
    store = new StoryStore();
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    mgr = new SessionManager({ ptyFactory: ptys.factory, now: Date.now, config: () => loadConfig().config, port, hookToken: 'h', hookScriptPath: '/h.js', statusScriptPath: '/s.js', builtins: () => [profile], stories: () => store.list(), gitOf: async () => null, headOf: () => null });
    server.on('request', createRequestHandler({ manager: mgr, stories: store, usage: new UsageStore({ now: Date.now, file: join(home.dir(), 'usage.json') }), closed: new ClosedStore({ now: Date.now, file: join(home.dir(), 'closed.json') }), port, pageHost: PAGE, token: TOKEN, hookToken: 'h'.repeat(64), webDir: home.dir(), onShutdown: () => undefined }));
    wsHandle = attachWebSocket(server, { manager: mgr, stories: store, port, pageHost: PAGE, token: TOKEN });
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    wsHandle.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('needs the token', async () => {
    expect((await fetch(base + '/api/stories')).status).toBe(401);
  });

  it('creates, lists, edits and deletes', async () => {
    const created = await call('POST', '/api/stories', { name: 'Payroll export', ticket: 'HCM-1234' });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: 'Payroll export', ticket: 'HCM-1234' });
    expect((await call('GET', '/api/stories')).json).toEqual([created.json]);
    const patched = await call('PATCH', `/api/stories/${created.json.id}`, { name: 'Payroll' });
    expect(patched.json).toMatchObject({ name: 'Payroll', ticket: 'HCM-1234' });
    expect((await call('DELETE', `/api/stories/${created.json.id}`)).status).toBe(204);
    expect((await call('GET', '/api/stories')).json).toEqual([]);
  });

  it('answers 400 for a blank or missing name and 404 for an unknown story', async () => {
    expect((await call('POST', '/api/stories', { name: '  ' })).status).toBe(400);
    expect((await call('POST', '/api/stories', { ticket: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/stories', ['x'])).status).toBe(400);
    expect((await call('PATCH', '/api/stories/nope', { name: 'x' })).status).toBe(404);
    expect((await call('DELETE', '/api/stories/nope')).status).toBe(404);
    expect(store.list()).toEqual([]);
  });

  it('creates a session inside a story and moves it with PATCH', async () => {
    const a = (await call('POST', '/api/stories', { name: 'A' })).json;
    const s = (await call('POST', '/api/sessions', { profileId: 'p1', cwd: home.dir(), storyId: a.id })).json;
    expect(s.storyId).toBe(a.id);
    expect((await call('PATCH', `/api/sessions/${s.id}`, { storyId: null })).json.storyId).toBeNull();
    expect((await call('PATCH', `/api/sessions/${s.id}`, { storyId: a.id })).json.storyId).toBe(a.id);
    expect((await call('PATCH', `/api/sessions/${s.id}`, { name: 'x' })).json.storyId).toBe(a.id);
  });

  it('deleting a story leaves its sessions running and ungrouped', async () => {
    const a = (await call('POST', '/api/stories', { name: 'A' })).json;
    const s = (await call('POST', '/api/sessions', { profileId: 'p1', cwd: home.dir(), storyId: a.id })).json;
    await call('DELETE', `/api/stories/${a.id}`);
    expect(mgr.get(s.id)).toMatchObject({ storyId: null, status: 'running' });
    expect(ptys.last().killed).toBe(false);
  });

  it('saving profiles does not erase stories, and saving stories does not erase profiles', async () => {
    await call('POST', '/api/stories', { name: 'A' });
    await call('PUT', '/api/profiles', [profile]);
    await call('POST', '/api/stories', { name: 'B' });
    const onDisk = JSON.parse(readFileSync(join(home.dir(), 'config.json'), 'utf8'));
    expect(onDisk.stories.map((s: Story) => s.name)).toEqual(['A', 'B']);
    expect(onDisk.profiles).toHaveLength(1);
  });

  it('answers 409 and leaves the file alone when config.json does not parse', async () => {
    await call('POST', '/api/stories', { name: 'A' });
    const edited = '{ "stories": [ oops';
    writeFileSync(join(home.dir(), 'config.json'), edited);
    const story = await call('POST', '/api/stories', { name: 'B' });
    expect(story.status).toBe(409);
    expect(story.json.error).toMatch(/config\.json/);
    expect((await call('PUT', '/api/profiles', [profile])).status).toBe(409);
    expect(readFileSync(join(home.dir(), 'config.json'), 'utf8')).toBe(edited);
  });

  it('pushes the story list to clients on connect and on every change', async () => {
    await call('POST', '/api/stories', { name: 'A' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['shellyard', `shellyard-token.${TOKEN}`], { headers: { host: `${PAGE}:${port}`, origin: `http://${PAGE}:${port}` } });
    sockets.push(ws);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d))));
    const stories = (): string[][] => messages.filter((m): m is Extract<ServerMessage, { t: 'stories' }> => m.t === 'stories').map((m) => m.stories.map((s) => s.name));
    await waitUntil(() => stories().length === 1);
    expect(messages[0]!.t).toBe('sessions');
    expect(stories()).toEqual([['A']]);
    await call('POST', '/api/stories', { name: 'B' });
    await waitUntil(() => stories().length === 2);
    expect(stories()[1]).toEqual(['A', 'B']);
  });
});
