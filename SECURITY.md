# Security

## Reporting

Report a vulnerability privately through GitHub's [report a security
vulnerability](https://github.com/hdmjack/bica/security/advisories/new) form rather than in a public
issue. This is a one-maintainer project, so expect a reply in days rather than hours.

## What bica does with your credentials and your files

Worth stating plainly, because bica's job is to move your code onto another machine.

**bica does not handle ssh authentication itself.** It shells out to `ssh`, `rsync` and `mutagen`,
so your keys, agent and `~/.ssh/config` are used exactly as they are by any other command. bica
reads no private key and holds no credential of its own, and it sends nothing to any service of its
own — there is no telemetry, and no network destination other than the host you name.

**One plugin does copy a credential file, and only when you say so.** The `npmrc` credentials plugin
copies your `~/.npmrc` — registry auth tokens included — to the remote's home directory with `scp`,
so that a private registry install works there. It prints the file first with any `_authToken=`
value redacted, then asks, defaulting to **no**. Nothing is copied without that confirmation. If you
would rather it never ran, turn the plugin off in `bica.yml`. Note that the copy lands at
`~/.npmrc` on the remote, outside the workspace, and stays there after the run.

**The remote gets your working tree**, including files git ignores, because the point is to run your
real commands against your real tree. That means a `.env`, a local certificate or a scratch file
with a token in it travels to the remote unless you exclude it in `sync.ignore.paths`. Anyone with
access to that machine or that account can read it.

**The remote workspace is a path, not a sandbox.** Commands run as your user on the remote, under
your login shell, with your remote PATH. bica does not confine them.

**`env:` forwards only what you name**, never the whole environment, so a credential in your local
shell does not reach the remote by accident. Variables describing this machine are refused outright.

**`bica tunnel` binds a unix socket on this machine** at a path you choose, forwarding to a port on
the remote. Anyone who can read that path can reach the forwarded service.

## Known limits

- **The workspace lease is cooperative.** It stops two bica runs colliding; it is not an access
  control, and anything else on the remote can write to the workspace.
- **A shared remote path means a shared tree.** Two checkouts configured to the same remote path
  take turns rather than running concurrently, and one can overwrite the other's work if a lease is
  broken deliberately.
- **Version skew between machines is real.** Two bica versions sharing a remote workspace have twice
  disagreed about what is in it. `bica --version` on both is the first thing to check.

## Scope

A report is in scope if it lets someone read or write files, run commands, or reach a host that bica
should not have given them access to — for example a path that escapes the workspace, a command
built from configuration without quoting, or a credential written somewhere it should not be.

Out of scope: the remote machine's own configuration, `ssh` and `rsync` themselves, and the fact
that a command bica runs can do whatever your user can do on that machine.
