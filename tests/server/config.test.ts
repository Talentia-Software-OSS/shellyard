import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearServerState,
  dataDir,
  loadConfig,
  readServerState,
  saveConfig,
  writeServerState,
} from '../../src/server/config.js';
import { useTempHome } from '../helpers.js';

describe('config', () => {
  const home = useTempHome();

  it('uses SHELLYARD_HOME as the data folder', () => {
    expect(dataDir()).toBe(home.dir());
  });

  it('returns defaults when there is no file', () => {
    expect(loadConfig()).toEqual({
      config: { profiles: [], models: ['opus', 'sonnet', 'haiku'], silenceMs: 5000, stories: [], restoreSessions: true, profileOrder: [], soundFiles: [], sounds: { blocked: null, finished: null, maybeWaiting: null }, lan: { enabled: false, port: 7718 } },
      warning: null,
    });
  });

  it('round-trips a saved config', () => {
    const config = {
      profiles: [
        { id: 'p1', name: 'Mine', kind: 'shell' as const, command: 'pwsh', args: ['-NoLogo'], cwd: 'C:\\x', color: '#ff0000', env: { A: '1' }, model: null, background: null, font: null },
      ],
      models: ['opus'],
      silenceMs: 8000,
      stories: [{ id: 's1', name: 'Story', ticket: 'T-1', cwd: '', color: '#00ff00', sound: '' }],
      restoreSessions: false,
      profileOrder: ['b', 'a'],
      soundFiles: [],
      sounds: { blocked: null, finished: null, maybeWaiting: null },
      lan: { enabled: true, port: 7799 },
    };
    saveConfig(config);
    expect(loadConfig()).toEqual({ config, warning: null });
  });

  it('keeps a valid profileOrder and drops what is not a string', () => {
    writeFileSync(join(home.dir(), 'config.json'), JSON.stringify({ profileOrder: ['b', 3, 'a', null] }));
    expect(loadConfig().config.profileOrder).toEqual(['b', 'a']);
    writeFileSync(join(home.dir(), 'config.json'), JSON.stringify({ profileOrder: 'nope' }));
    expect(loadConfig().config.profileOrder).toEqual([]);
  });

  it('survives a corrupt file and keeps it aside', () => {
    writeFileSync(join(home.dir(), 'config.json'), '{not json');
    const { config, warning } = loadConfig({ quarantineCorrupt: true });
    expect(config.silenceMs).toBe(5000);
    expect(config.profiles).toEqual([]);
    expect(warning).toMatch(/config\.json\.bad/);
    expect(readFileSync(join(home.dir(), 'config.json.bad'), 'utf8')).toBe('{not json');
  });

  it('while running, leaves a file being edited alone and keeps the last good settings', () => {
    saveConfig({ profiles: [], models: ['opus'], silenceMs: 9000, stories: [], restoreSessions: true, profileOrder: [], soundFiles: [], sounds: { blocked: null, finished: null, maybeWaiting: null }, lan: { enabled: false, port: 7718 } });
    expect(loadConfig().config.silenceMs).toBe(9000);
    writeFileSync(join(home.dir(), 'config.json'), '{"silenceMs": 90');
    const { config, warning } = loadConfig();
    expect(config).toEqual({ profiles: [], models: ['opus'], silenceMs: 9000, stories: [], restoreSessions: true, profileOrder: [], soundFiles: [], sounds: { blocked: null, finished: null, maybeWaiting: null }, lan: { enabled: false, port: 7718 } });
    expect(warning).toMatch(/not valid JSON/);
    expect(readFileSync(join(home.dir(), 'config.json'), 'utf8')).toBe('{"silenceMs": 90');
    expect(existsSync(join(home.dir(), 'config.json.bad'))).toBe(false);
  });

  it('fills in fields missing from an older file', () => {
    writeFileSync(join(home.dir(), 'config.json'), JSON.stringify({ profiles: [] }));
    const { config, warning } = loadConfig();
    expect(config.silenceMs).toBe(5000);
    expect(config.models).toEqual(['opus', 'sonnet', 'haiku']);
    expect(warning).toBeNull();
  });

  it('ignores values of the wrong type instead of failing', () => {
    writeFileSync(join(home.dir(), 'config.json'), JSON.stringify({ profiles: 'x', models: 5, silenceMs: 'soon' }));
    const { config } = loadConfig();
    expect(config).toEqual({ profiles: [], models: ['opus', 'sonnet', 'haiku'], silenceMs: 5000, stories: [], restoreSessions: true, profileOrder: [], soundFiles: [], sounds: { blocked: null, finished: null, maybeWaiting: null }, lan: { enabled: false, port: 7718 } });
  });
});

describe('server state file', () => {
  const home = useTempHome();

  it('is null when absent', () => {
    expect(readServerState()).toBeNull();
  });

  it('round-trips and clears', () => {
    const state = { pid: 123, port: 7717, token: 'a', hookToken: 'b', startedAt: 5 };
    writeServerState(state);
    expect(readServerState()).toEqual(state);
    clearServerState();
    expect(readServerState()).toBeNull();
    expect(existsSync(join(home.dir(), 'server.json'))).toBe(false);
    clearServerState();
  });

  it('is null when the file is damaged', () => {
    writeFileSync(join(home.dir(), 'server.json'), 'garbage');
    expect(readServerState()).toBeNull();
  });
});
