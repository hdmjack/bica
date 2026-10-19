# Contributing

bica is a small tool with one maintainer. That shapes what is useful to send.

## The most useful thing you can send is a bug report

bica sits between your shell and a machine you cannot see, so when it misbehaves the symptom is
usually ambiguous: a truncated output, a wrong exit code, a hang, a run that reported success over
work it did not do. A report that resolves that ambiguity is worth more than a patch, because the
patch for the wrong cause is worse than nothing.

What makes one useful:

- **The symptom**, quoted. The exact line bica printed, not a paraphrase.
- **A minimal repro.** A small tree and a command, not your real project.
- **Expected against actual**, as two statements.
- **The evidence that rules out the code under test.** This is the part people skip and the part
  that saves the most time. If `bica run` reported a test failure, say what proves the tests pass
  elsewhere. If a build skipped a file, say what proves the file reached the remote.
- **A test that would catch it**, in words or in code.
- **`bica --version`**, and the remote's OS. Several bugs have been version-skew between two
  machines sharing a remote workspace.

Three bugs fixed in a single day came in this shape, and in two of them the reporter's diagnosis was
correct down to the line number. It works.

**Please do not send a workaround in place of a report.** Routing around bica with `ssh`, `nohup`, a
local run or a retry loop hides the bug from the person who can fix it, and the workaround usually
outlives the memory of why it is there.

## Running the tests

```bash
pnpm install
pnpm test        # vitest, no remote needed
pnpm lint
pnpm typecheck
```

The suite is pure: every test runs locally against stubs and fixtures, and none of it needs a remote
machine. That is deliberate — but it also means the suite has missed real bugs more than once, in
every case because a fixture recorded what a tool was assumed to print rather than what it printed.
macOS ships openrsync, whose itemised output is nine flag characters where GNU rsync writes eleven;
three bugs came from that one difference. **Take fixtures from a real run of the real tool.**

If you have a machine to test against, exercise the change end to end as well. The commit messages
in this repository record what was measured, which is the standard to match.

## Changes

- Branch as `<category>/<short-name>`: `fix/wait-survives-failed-probe`, `feat/detached-runs`.
- Add commits rather than amending. History here is kept, not tidied.
- Explain **why** in the commit message, at whatever length that takes. The code says what changed.
- Comments carry the reasoning that would otherwise be lost — the failure mode a line prevents, the
  thing that was tried and did not work. Match the density of the code around you.
- Update `CHANGELOG.md` and the README when behaviour changes.

## What is unlikely to be merged

Reformatting, dependency bumps without a reason, and abstractions introduced before there is a
second caller. None of these are bad instincts; they just cost review attention that this project
does not have much of.
