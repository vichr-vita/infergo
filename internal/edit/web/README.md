# Editor page

The browser half of `infergen edit`. The design is
[docs/proposals/gui-editor.md](../../../docs/proposals/gui-editor.md). This
file is for the people building the regions: how to run the page without the
server, the contract each region implements, the store, the styles, and the
rules every region follows.

## Run it

From the repository root, after `npm ci`:

| Command | What it does |
| --- | --- |
| `npm run dev:editor` | Builds `internal/edit/web/dev/` (gitignored): `index.html`, an unminified `editor.js` with an inline source map, and `editor.css`, all on the mock Api |
| `npm run dev:editor -- --watch` | The same, rebuilt whenever `src/` or `editor.html` changes |
| `npm run test:editor` | Unit tests: every `src/**/*.test.ts`, bundled for Node and run with `node --test` |
| `npm run check:editor` | Type-check (including the fixtures), bundle staleness, unit tests |
| `npm run build:editor` | Rebuilds the shipped `editor.js` and `editor.css` |

Open `internal/edit/web/dev/index.html` straight from disk (`file://`) or from
any static server. Playwright can drive it the same way. The page exposes
`window.infergoStore` (the store) and `window.infergoMock` (the mock Api), so a
console or a test can call actions directly:

```js
infergoStore.hold('financeRequired');
infergoStore.aim('ReviewRequired');
await infergoStore.drop();
infergoMock.simulateDiskEdit('CappedBonus', '...new source...');
infergoMock.simulateConnection('lost');
```

Query parameters pick the mock's starting point. `?check=fixture` sends
`fixtures/check.json` first, which has one diagnostic of every kind (they name
facts that are not in the model, so use it to look at drawing, not logic).
`?history=fixture` starts from `fixtures/history.json`; those entries cannot be
undone because the mock has no bytes for them.

The mock (`src/mock.ts`) applies every operation in the protocol to its own
copy of the bonus model and rewrites each rule's `source` the way the server
will. It keeps a real undo journal, sends model, history, and check events
with the proposal's delays (30 ms per request, check 265 ms later), computes
believable diagnostics (missing producer, type mismatch, duplicate producer,
cycle, signature, unused rule, unused input), and refuses what the server
refuses, including a cyclic `add_read`. It is never in the shipped bundle;
`build.mjs` fails if it is.

## Files

```text
editor.html          the page skeleton, hand-written
editor.js, .css      built and checked in; only the build lead commits rebuilds
build.mjs            the build, see the table above
src/protocol.ts      wire types (workstream A; do not edit)
src/boot.ts          shipped entry: start(serverApi())
src/dev.ts           dev entry: start(mockApi())
src/main.ts          the shell: mounts regions, header, summary, status line, keys
src/region.ts        the Region and Shell types
src/store.ts         State, actions, selectors
src/derive.ts        pure graph logic: Graph, Wire, Verdict, cycle paths
src/api.ts           Api interface, Result type, the server implementation
src/mock.ts          the mock Api
src/dom.ts           h, reconcile, holdsFocus, setText
src/shell.css        tokens, shared classes, shell layout
src/<region>/        one directory per region: index.ts, its .css, its tests
```

## Region contract

Six regions, one directory each. Each exports `mount` from `index.ts`:

```ts
// src/region.ts
export type Region = (root: HTMLElement, store: Store, shell: Shell) => void;
export interface Shell {
  announce(text: string): void;               // polite live region
  placeRuleDetail(host?: HTMLElement): void;  // narrow layout only, see below
}
```

| Region | Directory | Root element | Owner |
| --- | --- | --- | --- |
| Facts column | `src/facts/` | `#facts-root`, the Facts tab | E part 2 |
| History | `src/history/` | `#history-root`, the History tab | E part 2 |
| Graph canvas | `src/graph/` | `#graph-root`, shown when `layout === 'canvas'` | F |
| List view | `src/list/` | `#list-root`, shown when `layout === 'list'` | E part 2 |
| Rule sheet | `src/sheet/` | `#sheet-root`, inside `#rule-detail` | E part 2 |
| Code pane | `src/code/` | `#code-root`, inside `#rule-detail` | G |

`main.ts` calls each `mount` once, after the first model has loaded. A region
renders only inside its root, subscribes with `store.watch`, turns input into
store actions, and never touches another region's DOM or the Api. Every
directory starts as a stub from E part 1; replace the whole tree.

The shell owns everything outside the roots: the header (package, files,
Find, the Scenario placeholder, Undo, Redo), the summary line (counts, errors
and warnings, evaluator state, the word "Checking" while a check is behind),
the status line (the gesture in progress, else the newest receipt with Undo or
Redo, a refusal, or an error), the Facts and History tabs, column collapsing,
the live region, and the keys overlay. It shows and hides the region roots
from `layout` and `sideTab`, so a region does not hide its own root for those.

**Narrow layout (1100 px and below).** One column: the list view, then the
Rule column, then the Facts column. The list region opens the rule detail
(`#rule-detail`, which holds the sheet and code roots) under the selected rule
by calling `shell.placeRuleDetail(itemElement)`. Call it only when the
selected rule or the layout changes, because moving a subtree blurs the
element inside it that has focus. When the layout returns to wide, the shell
moves the detail back to the Rule column itself. If the list never places it,
the Rule column shows the detail below the list.

**Global keys** live in `main.ts` and run in the bubbling phase on `document`.
They skip any event whose default was prevented, so a region that handles a
key (its own `Esc`, arrows, `Enter`) calls `event.preventDefault()` and wins.

| Key | Handled by |
| --- | --- |
| `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y` | Shell: history undo and redo, except inside `[data-region="code"]` and text fields, which keep their own text undo |
| `Esc` | Shell: puts a held fact down |
| `?` | Shell: the keys overlay |
| `[`, `]` | Shell: collapse the Facts or Rule column (wide layout) |
| `W` | Facts, sheet, graph: pick up the focused fact |
| Arrows, `Enter` | Graph (and list): aim and drop, or move between rules |
| `A`, `F2`, `Delete`, `N` | Sheet and graph, as listed in the overlay |

## Store

`src/store.ts` holds one `State` object, replaced immutably on every change.
Every field is documented on the type. The ones regions use most:

| Field | Meaning |
| --- | --- |
| `model` | the newest `Model`, replaced whole on every model event |
| `graph` | derived from `model`: `rules`, `facts` (a `FactInfo` per name: type, input, requested, producers, readers), `producers`, `readers`, `wires`, `ancestors`, `order` |
| `check`, `values` | newest compiler verdict and scenario snapshots |
| `history` | the undo journal |
| `selection` | `{ rule?, fact?, wire? }` |
| `highlight` | the fact lit everywhere |
| `held` | `{ fact, verdicts, over?, verdict? }` while a fact is carried |
| `preview` | `{ op, state: 'loading' \| 'ready' \| 'refused' \| 'failed', ... }` |
| `notice` | newest receipt, refusal, or failure, for the status line |
| `connection`, `backend` | event stream state; `server` or `mock` |
| `query` | Find text, lower-cased; filter with `matchesQuery(state, ...texts)` |
| `layout`, `narrow` | `canvas` or `list`; true at 1100 px and below |
| `collapsed`, `sideTab` | shell state |

Actions:

| Action | Does |
| --- | --- |
| `select(partial)` | merges into `selection` |
| `highlight(fact?)` | lights a fact, or clears the light |
| `hold(fact)` | picks a fact up and computes a `Verdict` for every rule |
| `aim(rule?)` | aims at a rule; a valid target requests a preview, a stale reply is dropped |
| `drop()` | applies exactly the previewed op; no target cancels; an invalid target or refused preview writes nothing and sets a refusal notice; the target becomes the selected rule |
| `cancel()` | puts the fact down and clears its preview |
| `previewOp(op)`, `clearPreview(op?)` | previews for hover and focus; `clearPreview(op)` clears only that op's preview |
| `apply(op)`, `undo()`, `redo()` | writes; return a `Result`; the new model arrives as an event |
| `setValues(enabled)`, `setScenario(id?)` | live values, stretch goal |
| `setQuery`, `setListView`, `setNarrow`, `toggleColumn`, `setSideTab`, `dismissNotice` | shell state |

A `Verdict` is `{ ok: true }` or `{ ok: false, reason }` with reason
`reads`, `produces`, `unsupported`, or `cycle`. A cycle verdict carries `path`
(rules from the target to the fact's producer, the order a cycle diagnostic
uses in `related`) and `wires` (the wires along it); the held fact closes the
loop. `verdictMessage(verdict, fact, rule, graph)` gives the sentence to show.

Selectors for what several regions need: `shownRule` (the rule the sheet and
code pane show: the preview's rule, else the aimed rule, else the selection),
`previewChange(state, rule)`, `pendingRead(state, rule)`, `diagnosticsFor(state,
{ rule?, fact? })`, `problemCounts`, `checkPending`, `canUndo`, `canRedo`,
`matchesQuery`, `validTargets`. From `derive.ts`: `addReadOp`, `addRuleOp`,
`suggestedResult`, `wireKey`, `wirePath`, `opRule`, `sameOp`.

### Worked example: a drag

```ts
// Facts row: press picks the fact up.
row.addEventListener('pointerdown', () => store.hold('financeRequired'));

// Graph: outline what can take it, dim the rest.
store.watch(s => [s.held, s.graph], () => {
  for (const [rule, verdict] of store.state.held?.verdicts ?? []) {
    node(rule).classList.toggle('target', verdict.ok);
    node(rule).classList.toggle('dim', !verdict.ok);
  }
});

// Pointer over a node aims; leaving it aims at nothing.
node.addEventListener('pointerenter', () => store.aim('ReviewRequired'));
node.addEventListener('pointerleave', () => store.aim(undefined));
// state.held.verdict is { ok: true }; state.preview goes 'loading' then 'ready'.
// The sheet draws pendingRead(state, 'ReviewRequired') as "+ financeRequired bool",
// the code pane draws previewChange(state, 'ReviewRequired').after.

// Release on the node drops; release on nothing cancels.
await store.drop();
// The mock or server applies { op: 'add_read', rule: 'ReviewRequired', fact: 'financeRequired', type: 'bool' }.
// A model event redraws everything; notice is the receipt
// "Wired financeRequired into ReviewRequired", bonus.go +1 −1, with Undo.
```

Aiming at `CappedBonus` with `approvalsSatisfied` held gives
`{ ok: false, reason: 'cycle', path: ['CappedBonus', 'FinanceRequired', 'ApprovalsSatisfied'], wires }`,
no preview, and the status line "No drop here. It would create a cycle through
FinanceRequired and ApprovalsSatisfied." Dropping there writes nothing.

Drop on empty canvas, or New rule: read `store.state.held?.fact`, call
`store.cancel()`, open the inline form, and on submit
`store.apply(addRuleOp(graph, name, [{ name: result, type }], heldFact))`.
`suggestedResult(name)` proposes the result name.

### Subscribing

```ts
store.watch(s => [s.model, s.selection.rule, s.preview], ([model, rule, preview]) => render());
```

The selector returns the slices a region reads, as a tuple. The listener runs
once at mount and then only when one of them changes by reference. Derive
anything else inside the listener from `store.state`. Listeners may call
actions; the resulting changes are delivered after the current pass.

## Focus rule

A redraw never replaces the element that has focus. Replacing it drops the
caret, the open picker, and the keyboard user's place.

- Build a region's structure once in `mount` and update text and attributes
  in place on each change (`setText` skips unchanged text).
- Render lists with `reconcile(parent, items, key, create, update)`: it keeps
  each keyed element, updates it in place, and never moves the focused one.
- Before rebuilding any subtree wholesale, check `holdsFocus(subtree)` and, if
  it holds focus, update in place or skip that pass.
- A control that changes meaning (Undo becoming Redo) is one element whose
  label changes, not two elements swapped.
- Moving a subtree blurs it too; `placeRuleDetail` is the one sanctioned move.

## Styles

`build.mjs` writes `editor.css` from `src/shell.css` followed by every
`src/<region>/**/*.css` in path order. To style a region, add a `.css` file in
its directory; do not edit `shell.css` or another region's file. Scope
selectors to your root (`#graph-root ...`) or to classes only your region uses.

Tokens are custom properties on `:root`, documented at the top of
`shell.css`: `--bg` `#000`, `--fg` `#fff`, `--muted`, `--faint`, `--rule`,
`--rule-soft`, `--edge`, `--control`, `--teal` `#74dfd0` (selected or
pending), `--amber` `#f0b36c` (refused, changed, warning), `--red` `#ff9999`
(error), `--teal-wash` (inserted code only), `--mono`, `--sans`,
`--control-height` 44 px, `--mini-height` 26 px, `--facts-width` 204 px,
`--rule-width` 436 px, `--gutter`.

Shared classes, so every region draws the same thing the same way:

| Class | For |
| --- | --- |
| `button`, `input`, `select` (element styles) | square, 1 px, 44 px |
| `button.mini` | a small square in-row button, such as remove; 44 px on touch |
| `button.link`, `.fix` | a fix link or any link-like action |
| `[aria-pressed="true"]`, `.pressed` | a toggled control |
| `.section-heading` with `.count`, `.push` | Inputs, Reads, Source |
| `.fact-row` with `.fact-name`, `.fact-type` | a fact and its type |
| `.lit` | the highlighted fact |
| `.pending` | something that would happen: teal; put a real "+ " in the text |
| `.target` | dashed teal outline: "this would happen here" |
| `.dim` | out of play while a fact is held |
| `.row-error`, `.row-warning`, `.row-refused` | a problem row with a 2 px left rule |
| `.text-error`, `.text-warning`, `.text-refused`, `.text-teal` | state colour for text |
| `.fixes` | a wrapping row of fix links |
| `.sr-only` | text for screen readers only |

Patterns to avoid, without exception: card or pill chrome, rounded corners,
shadows, glows, blur, gradients, continuously repainting animations (pulse,
shimmer, spinners; a running check is a word), decorative icons, grey
subtitle lines above sections, em dashes in any copy. Colour means state and
nothing else, and state is never carried by colour alone. Below 1100 px
nothing may scroll sideways: wrap long identifiers with `overflow-wrap:
anywhere`, and do not hide overflow with `overflow-x: hidden` or clipping.

## Tests

Put unit tests next to the code as `*.test.ts`; `npm run test:editor` finds
them. They run in Node, so test pure logic and the store (with `mockApi({
latency: { request: 0, check: 0, values: 0 } })`), not the DOM. The available
`node:test` and `node:assert/strict` surface is declared in
`src/node-test.d.ts`; extend it there if you need more.

## Committing

Commit sources only. Do not commit rebuilt `editor.js` or `editor.css`: every
branch would conflict on them. The build lead rebuilds and commits the bundle
after merging, and `npm run check:editor` fails until then, which is expected
on a region branch. `dev/` and `.test/` are gitignored.

The bundle header lists the licence of every npm package esbuild pulls in,
plus their runtime dependencies (dagre ships graphlib inlined), and the
Inferrum licence when the viewer's `navigation.ts` is bundled. Nothing to do
by hand unless a package ships no LICENSE file, in which case the build fails
and says so.
