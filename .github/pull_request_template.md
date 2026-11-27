<!-- CONTRIBUTING.md has the long version. These are the four that get a PR sent back. -->

**What breaks today, and how you saw it break.**



---

- [ ] **No new dependency.** Everything resolves with `node:` builtins. If it seems to need a package, it almost certainly does not.
- [ ] **There is a test, and it is written against the real defect** — the actual broken output, not an invented example. A behaviour change without one is a half change.
- [ ] **I ran it, and it went green:** `npm test`, plus `npm run demo` or `npm run demo:contratos` if this touches mail or the ledger.
- [ ] **The spec moved with the code.** If this changes the envelope, an error code or a ledger operation, `docs/SPEC.md` changes in this same PR.

**Invariants** (`CLAUDE.md`, `docs/SPEC.md §12`) — the first one rules them all: *no verifiable signature, no delivery*. If your change touches one, open a discussion before writing code.
