# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Public issues are world-readable the
moment they are filed.

Use GitHub's private reporting instead: on this repository, go to
**Security** → **Report a vulnerability**. That opens a private advisory visible only to the
maintainer.

If private reporting is unavailable to you, open an issue that says only "security report
available on request" with no details, and the maintainer will arrange a private channel.

Please include, as far as you can:

- what the extension does with the input, and what you expected instead
- the pi version (`pi --version`) and this package's version
- a program that reproduces it, if you have one — the smaller the better

## What to expect

- An acknowledgement within a few days.
- A fix released through the normal tag-triggered publish path, which means it goes out with an
  npm provenance attestation.
- Credit in the advisory unless you would rather stay anonymous.

## What is in scope

This package is a `pi` extension loaded into the `pi` coding agent's process. That makes two
things worth reporting:

- **The PTC execution boundary.** The model writes a program that this package executes in a
  worker. The worker inherits a deliberately small environment (`PATH`, `PATHEXT`, `SYSTEMROOT`,
  `WINDIR`, `TEMP`, `TMP` — see `src/runtime/limits.ts`) and runs under
  `worker_threads` with explicit V8 heap caps. Anything that lets a program escape those limits,
  reach host state it should not, or bypass a configured budget is in scope.
- **Input handling in the host-facing surfaces**: the wire protocol between the worker and the
  dispatcher, the renderer, and the binding bridge.

## What is not a vulnerability here

- **There is no OS sandbox, by decision.** [ADR-0007](docs/adr/0007-no-os-sandbox.md) states this
  plainly: a PTC program is not confined to a filesystem sandbox, because the threat model that
  would address is already covered by the model only issuing tool calls rather than arbitrary
  execution. Do not report "the program is not sandboxed" as a new finding — read ADR-0007 first.
  What _is_ reportable is a way to escape the bounds this package does set.
- **Budget exhaustion that the configured limits already handle.** `maxOutputBytes`,
  `maxPendingCalls` and friends are enforced, and their values are documented. Finding a
  legitimate way to spend the budget the operator configured is a design discussion, not a
  vulnerability.
- **Model prompt injection.** The model is the caller; it is trusted to ask for what it wants
  within the limits above.
