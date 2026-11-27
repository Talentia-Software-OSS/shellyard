import { describe, expect, it } from 'vitest';
import { commandTokens, patternError, ruleMatches, suggestPattern } from '../../src/shared/rules.js';

describe('commandTokens', () => {
  it('splits a plain command into words, keeping quoted parts whole', () => {
    expect(commandTokens('dotnet test src/Demo.Payroll.Tests --filter Slot')).toEqual(['dotnet', 'test', 'src/Demo.Payroll.Tests', '--filter', 'Slot']);
    expect(commandTokens('  git   commit -m "fix slot rules"  ')).toEqual(['git', 'commit', '-m', '"fix slot rules"']);
    expect(commandTokens("echo 'a b'")).toEqual(['echo', "'a b'"]);
  });

  it('refuses anything that chains, pipes, redirects, substitutes or spans lines', () => {
    for (const c of [
      'dotnet test; rm -rf /',
      'dotnet test && curl x',
      'dotnet test || true',
      'dotnet test | tee out',
      'dotnet test & disown',
      'dotnet test > out.txt',
      'dotnet test < in.txt',
      'dotnet test $(whoami)',
      'dotnet test `whoami`',
      'dotnet test ${HOME}',
      'dotnet test $HOME',
      'dotnet test (x)',
      'dotnet test {a,b}',
      'dotnet test\nrm -rf /',
      'dotnet test\rrm',
      'dotnet test "a; b"',
      'dotnet test\u0000',
      'dotnet test \u001b[2J',
      'dotnet test\u007f',
    ]) {
      expect(commandTokens(c), JSON.stringify(c)).toBeNull();
    }
  });

  it('refuses a command led by a variable assignment, an option or nothing', () => {
    expect(commandTokens('PATH=/tmp dotnet test')).toBeNull();
    expect(commandTokens('-rf x')).toBeNull();
    expect(commandTokens('')).toBeNull();
    expect(commandTokens('   ')).toBeNull();
  });

  it('refuses unbalanced quotes', () => {
    expect(commandTokens('git commit -m "oops')).toBeNull();
    expect(commandTokens("echo 'x")).toBeNull();
  });
});

describe('ruleMatches', () => {
  it('matches a command that starts with the words of a pattern ending in *', () => {
    expect(ruleMatches('dotnet test *', 'dotnet test')).toBe(true);
    expect(ruleMatches('dotnet test *', 'dotnet test src/Demo.Payroll.Tests --filter Slot')).toBe(true);
    expect(ruleMatches('dotnet test *', 'dotnet build')).toBe(false);
    expect(ruleMatches('dotnet test *', 'dotnet')).toBe(false);
  });

  it('matches whole words only', () => {
    expect(ruleMatches('dotnet test *', 'dotnet tests')).toBe(false);
    expect(ruleMatches('git push *', 'git push-all')).toBe(false);
  });

  it('matches a pattern without * exactly, spacing aside', () => {
    expect(ruleMatches('git status', 'git  status')).toBe(true);
    expect(ruleMatches('git status', 'git status --short')).toBe(false);
  });

  it('never matches a command that is not safe, whatever the pattern', () => {
    expect(ruleMatches('dotnet test *', 'dotnet test; rm -rf /')).toBe(false);
    expect(ruleMatches('dotnet test *', 'dotnet test $(rm -rf /)')).toBe(false);
    expect(ruleMatches('dotnet test *', 'dotnet test > /etc/passwd')).toBe(false);
  });

  it('never matches with a pattern that is not valid', () => {
    expect(ruleMatches('*', 'anything')).toBe(false);
    expect(ruleMatches('dotnet * test', 'dotnet x test')).toBe(false);
  });
});

describe('patternError', () => {
  it('accepts commands with or without a final *', () => {
    expect(patternError('dotnet test *')).toBeNull();
    expect(patternError('git status')).toBeNull();
  });

  it('says why a pattern cannot be a rule', () => {
    expect(patternError('')).toMatch(/command/i);
    expect(patternError('*')).toMatch(/command/i);
    expect(patternError('dotnet * test')).toMatch(/\*/);
    expect(patternError('dotnet test; rm *')).toMatch(/chain|redirect/i);
    expect(patternError('x'.repeat(301))).toMatch(/long/i);
  });
});

describe('suggestPattern', () => {
  it('keeps the program and its subcommand, and allows any arguments after them', () => {
    expect(suggestPattern('dotnet test src/Demo.Payroll.Tests --filter Slot')).toBe('dotnet test *');
    expect(suggestPattern('git push origin main')).toBe('git push *');
    expect(suggestPattern('npm run build')).toBe('npm run *');
  });

  it('keeps the command whole for a program not known to have subcommands', () => {
    expect(suggestPattern('rm build dist')).toBe('rm build dist');
    expect(suggestPattern('sudo apt install x')).toBe('sudo apt install x');
    expect(suggestPattern('python manage.py migrate')).toBe('python manage.py migrate');
    expect(suggestPattern('git.exe status --short')).toBe('git.exe status *');
  });

  it('keeps the command whole when it is short, or its second word is an option or a path', () => {
    expect(suggestPattern('git status')).toBe('git status');
    expect(suggestPattern('ls')).toBe('ls');
    expect(suggestPattern('rm -rf build')).toBe('rm -rf build');
    expect(suggestPattern('cat src/a.cs')).toBe('cat src/a.cs');
    expect(suggestPattern('  git   status  ')).toBe('git status');
  });

  it('has nothing to suggest for a command that is not safe', () => {
    expect(suggestPattern('dotnet test && rm -rf /')).toBeNull();
    expect(suggestPattern('')).toBeNull();
  });
});
