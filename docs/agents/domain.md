# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase. This repo is **single-context**: one library layer, `@toon-protocol/core` and
`@toon-protocol/sdk`, in a pnpm workspace under `packages/*`.

## Before exploring, read these

- **`CLAUDE.md`** at the repo root: what this repo is, how to build and test it, and where its
  boundaries with the connector and the other TOON repos lie.
- **`packages/*/README.md`** and the `.changeset/` entries: each package's public surface and its
  recent breaking changes.

This repo has no `CONTEXT.md` and no `docs/adr/`. Shared glossary and ADRs historically lived in
`toon-protocol/toon-meta` (being retired), and the ILP payment engine, with its own `CONTEXT.md` and ADRs,
is [`toon-protocol/connector`](https://github.com/toon-protocol/connector). Neither is checked out
here. When a ticket cites one of their decisions, take the ticket's account of it as settled.

If a file named above doesn't exist, **proceed silently**. Don't flag its absence; don't suggest
creating it upfront. The `/domain-modeling` skill creates `CONTEXT.md` and ADRs lazily, when terms or
decisions actually get resolved.

## File structure

```
/
├── CLAUDE.md
├── .changeset/
└── packages/
    ├── core/                ← @toon-protocol/core
    ├── sdk/                 ← @toon-protocol/sdk
    └── settlement-digest/
```

## Flag conflicts with cited decisions

If your output contradicts a decision a ticket or `CLAUDE.md` cites, surface it explicitly rather than
silently overriding it. Payment-claim validation, for one, lives only in the connector and is never
re-implemented here.
