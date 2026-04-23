import { argvToPosixShCommand } from './remoteArgvToShellCommand';
import { shellSingleQuote } from './shellQuote';

describe('argvToPosixShCommand', () => {
  it('joins simple args with single-quoted segments', () => {
    expect(argvToPosixShCommand(['pnpm', 'test:run'])).toBe(
      "'pnpm' 'test:run'",
    );
  });

  it('escapes single quotes per POSIX', () => {
    expect(argvToPosixShCommand(["it's", 'ok'])).toBe(
      [shellSingleQuote("it's"), shellSingleQuote('ok')].join(' '),
    );
  });

  it('handles empty argv', () => {
    expect(argvToPosixShCommand([])).toBe('');
  });
});
