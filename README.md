# dsh-tool-update-route-guard

Stop one model switch from poisoning a session with a permanent `400`.

deepseek-harness records tool-registry changes as `developer` messages and sends
them to a route only when that route's model entry declares `toolUpdate`
(`addition-only` or `in-history`). The declaration belongs to the **model
entry**, not to the **endpoint** the entry is pointed at. Point such an entry at
an endpoint that does not honour mid-conversation tool changes and every request
keeps carrying `tool_addition` / `tool_removal` blocks that endpoint rejects.
Because the blocks are durable history, the rejection repeats on every request:
the session never recovers.

This plugin projects exactly those requests onto the shape the harness already
uses for a route that declares no such capability — the core
`projectToolUpdates(..., undefined, ...)` projection — immediately before
dispatch. Durable history is untouched, so the session becomes usable again and
stays usable if the route is later repointed at an endpoint that does support
the capability.

## Install

```sh
dsh plugin --profile <profile> add github:argszero/dsh-tool-update-route-guard
```

That one command installs the package into the profile and adds it to the
profile's bundle list. A plain `npm install` of the same spec is **inert on its
own**: a bundle becomes a layer only when the profile's `package.json` lists it
under `dsh.profile.bundles` (`packages/boot/app-boot/src/profile.ts`), and the
plugin manager is what writes that list after an install
(`packages/boot/plugin-manager/src/operations.ts`).

The package ships a `dsh.bundle.patch` manifest; the patch inserts the plugin as
`tool-update-route-guard`.

## Configure

The plugin does nothing until an operator names the routes whose endpoint cannot
carry mid-conversation tool updates:

```yaml
- id: tool-update-route-guard
  name: '@argszero/dsh-tool-update-route-guard'
  config:
    routes:
      - provider: anthropic          # every model on this route
      - model: 'claude-*'            # this model on every route
      - provider: 'proxy-*'
        model: '*sonnet*'            # both fields must match
    audit: false                     # true = report, change nothing
```

- `routes` — an entry constrains only the fields it names; `*` is the only
  wildcard. An entry with neither field would deny every route, so it is
  rejected rather than honoured.
- `audit` — log what would be projected, and dispatch the request unchanged.
  Use it to find which routes actually need the guard before switching it on.

Each matching route warns once, naming the provider and model, so the log
records which sessions were affected.

## What it does, precisely

For a request whose route is named in `routes` and whose history carries a
`tool-addition` or `tool-removal` block, the guard:

1. computes the projection with the core function, over the request's own
   `toolHistory`, so deferred tool declarations that no addition would activate
   are cleared the same way core clears them;
2. re-dispatches the request through the harness's public `llm/stream` entry
   point with that projection, because a request arriving at the seam is
   deep-frozen and the waterfall's continuation cannot carry a replacement;
3. re-applies the agent-loop marker so consumers of `isAgentLoopRequest` still
   recognise the dispatch, and freezes the envelope the adapter observes.

It is installed with `{ prepend: true }`, so it sees the request before any other
listener and the replacement passes the remaining listeners exactly once — no
listener runs twice.

Every failure inside the guard leaves the request exactly as the caller built
it: this plugin never decides whether a request runs.

## What it does not do

The underlying defect is in the core: a capability that describes an **endpoint**
is declared on a **model entry**, so nothing prevents the declaration from
travelling to an endpoint that cannot honour it. This plugin is a containment for
the routes an operator names; it cannot infer the capability of an endpoint the
harness never asks about. The core fix is for the capability to be resolved from
the endpoint (or for a route whose endpoint rejects the blocks to lose the
declaration), and it belongs upstream.

The guard also does not rewrite durable history: it projects the outgoing request
only. Turning the guard off restores the previous behaviour immediately.

## Evidence

- `npm test` — 31 tests: route matching, the projection against the core
  function, the real `llm/stream` waterfall, and a wire-level arm that drives the
  published `@deepseek-ai/dsh-llm-deepseek` adapter with a capturing `fetch`. The
  control arm asserts the unguarded request really does reach the wire with a
  `tool_addition` block and the `mid-conversation-tool-changes-2026-07-01` beta
  header; the guarded arm asserts neither is sent, while the credential headers,
  the user turn and the tool declarations survive.
- `npm run mutation` — 29 injected defects, control first, 29 caught. A surviving
  mutant is treated as a gap in the suite, and the script exits non-zero.
- `npm run smoke` — mount on the published `@deepseek-ai/cordis`, one dispatch
  through the real waterfall, and an observable teardown.

## License

MIT
