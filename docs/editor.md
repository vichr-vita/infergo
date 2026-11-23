# Edit rules in the browser

`infergen edit` serves a page on your machine that shows a ruleset as a graph
beside its Go source. You drag a fact onto a rule and the rule gains a typed
parameter in the `.go` file. You type a parameter in the code pane and the graph
gains a wire. The Go files are the only stored state: the editor keeps no layout
file and no database, and it changes your files by editing bytes in place, so
comments and untouched code stay as they were.

The editor is a prototype. Read [Limits](#limits) before you depend on it. The
offline viewer described in the [visualization guide](visualization.md) is a
separate page and is unchanged.

## Start the editor

Run the command from the ruleset directory, with the same `--rules`, `--inputs`,
and `--outputs` settings you use for generation:

```sh
go tool infergen edit --rules rules.go --open
```

Inside the Infergo repository, copy `ruleset/bonus` to a scratch module first,
because the editor writes to the files it opens. Give the copy a `go.mod` that
requires `github.com/vichr-vita/infergo` and replaces it with your checkout, as
the [development guide](../CONTRIBUTING.md#use-a-local-checkout-from-another-module)
describes. Then run the command there:

```sh
go run github.com/vichr-vita/infergo/cmd/infergen edit --rules bonus.go
```

The command prints one line, a URL such as
`http://127.0.0.1:36339/?token=F2ICLDJ3OZKMZVMZQAKULAESHW`, and serves until you
press Ctrl+C. Open the URL in a browser. The editor binds `127.0.0.1` only. The
token in the URL is random for each run, and the page sends it with every
request. A request without it gets a 401 response, so another user on the same
machine cannot drive your editor and neither can another website.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--rules` | None; required | Go rule files in the current package. |
| `--inputs`, `--outputs` | `Inputs`, `Outputs` | The contract struct types. |
| `--out` | `zz_infergo_gen.go` | The generated evaluator that the editor keeps current. |
| `--config` | `infergen.*` in the current directory | A config file. |
| `--port` | `0` | Port on `127.0.0.1`. `0` picks a free one. If the port is taken, the command exits with an error. |
| `--open` | `false` | Open the URL in the default browser. It exists only on the command line. |

The ruleset settings come from the same flags, `INFERGEN_*` environment variables,
and config file as [generation](generator.md#flags-and-defaults). The command
does not compile the ruleset before it starts, so you can open a ruleset that
does not build and repair it in the page.

## The page

The page has a header, a summary line, three columns, and a status line.

- The header shows the package and the files the editor reads. It holds the Find
  field, the Undo and Redo buttons, and a Scenario control that stays disabled
  and reads "Values off".
- The summary line counts rules, inputs, and requested outputs, then errors and
  warnings, then the state of the evaluator on disk. The word "Checking" appears
  while the compiler is running.
- The left column lists Inputs, Outputs, and Derived facts. Each row is a fact
  you can pick up. The History tab replaces the lists.
- The middle column is the graph, with New rule, zoom, Fit map, Actual size, and
  List buttons. A wire is labelled with the fact that flows along it. Rows marked
  with a filled square are read from another rule. Rows marked with a hollow
  square are inputs.
- The right column is the rule sheet and the code pane for the selected rule.
  Click a rule to select it. The sheet holds the name, the requirement, the
  reads, and the results, and the code pane holds the declaration.
- The status line shows what you are holding, or the receipt for the newest
  change with an Undo button, or the reason a gesture was refused.

At 1100 px and below the graph is replaced by a list of rules in dependency order.
The selected rule opens under its entry with the same sheet and code pane. You
can switch to the list on a wide screen with the List button. Nothing scrolls
sideways at 320 px, so you can use every control on a phone.

A wire has no text of its own. One rule reads a fact because it has a parameter
named like another rule's result. That is why wiring is the same as editing a
parameter list.

## Wire facts

Wiring has three steps: pick a fact up, aim at a rule, drop it.

1. Press on a fact and drag it. You can pick up a row in the left column, a read
   or result row in a node, a row in the sheet, or a wire's label. A press that
   does not move holds the fact until you click a rule.
2. While you hold a fact, rules that can take it get a dashed outline and the rest
   dim. The status line says how many rules can take it. A rule cannot take a
   fact that it already reads or produces, or whose producer depends on that rule.
3. Move over a rule. The code pane shows the declaration with the new parameter
   marked with a plus sign, the sheet shows the pending read, and the status line
   says what a drop would do. Nothing is written yet. Release to drop. The write
   is exactly what the preview showed.

Press Esc to put a held fact down. A fact held by a click is dropped by clicking
a rule.

Every other gesture is also available without dragging. The table lists each
gesture and what it writes to the Go source. The examples come from the bonus
ruleset.

| Gesture | What it writes |
| --- | --- |
| Drop a fact on a rule | Appends `name type` to the rule's parameter list, as in `, financeRequired bool`. The type is copied from the fact's producer. |
| Select a wire and press Delete, or press the × beside a read in the sheet | Removes that parameter. The body is left alone. If the body still uses the name, the status line says how many uses remain and the compiler's error appears on the rule. |
| Drop a fact on empty canvas, or use New rule or `N` | Opens a form for the rule name. It proposes a result name (`LoyaltyTopUp` gives `loyaltyTopUp`) and takes the result type from the dropped fact, or `bool` without one. It inserts a documented stub after the producer of the dropped fact, or at the end of the first rule file when no fact was dropped. |
| Delete rule in the sheet, or Delete on a focused rule | After one confirmation, removes the doc comment and the declaration. |
| `F2` on a fact | Renames the result in its producer, the parameter in every reader, each use inside those bodies, and the `fact` tag in `Inputs` or `Outputs` when the fact is part of one. The Go field name does not change. |
| `F2` or Rename on a rule | Renames the function and the first word of its doc comment, and the references in the package and its tests. Callers in other packages are not updated, and the receipt says so. |
| Click the requirement in the sheet | Rewrites the doc comment, wrapped at 80 columns. Enter saves, Shift+Enter adds a line, Esc cancels. |
| Add result in the sheet | Appends `name type` to the result list. |
| × beside a result in the sheet | Removes that result from the list. |
| A fix link | Applies the fix the link names. See [Diagnostics and fixes](#diagnostics-and-fixes). |
| `+` beside Inputs | Adds a field with a `fact` tag to the `Inputs` struct. The field name is the fact name with a capital first letter. |
| Delete on an input row | Removes that field. |
| Drop a fact on Outputs, or `+` beside Outputs | Adds a field with a `fact` tag to the `Outputs` struct. |
| Delete on an output row | Removes that field. |
| Type in the code pane | Replaces that declaration with the buffer, if the file still parses. See [Edit the code](#edit-the-code). |

A drop that would close a cycle is refused before anything is written. Aiming at
the rule shows a message such as "No drop here. It would create a cycle through
FinanceRequired and ApprovalsSatisfied.", marks the closing wire on the graph,
and lists the path in the sheet, one wire to a line. Remove one of the wires on
the path first, then drop again.

## Keys

Press `?` in the page for the list. The graph has one tab stop. Click a rule or
tab to it, then use these keys:

| Key | Does |
| --- | --- |
| `W` | Pick up the focused fact, or the focused rule's result |
| Arrow keys | While you hold a fact, step through the rules that can take it. Otherwise move along wires: Up to a producer, Down to a reader, Left and Right to siblings. Shift and Up or Down selects the first wire into or out of the rule, and Left and Right then step through its siblings. |
| `Enter` | Drop the held fact. Otherwise open the code pane |
| `Esc` | Put the held fact down |
| `A` | Add a read to the selected rule. A picker opens with every fact. Facts that cannot be wired stay listed, disabled, with the reason |
| `F2` | Rename the focused rule or fact |
| `Delete` | Remove the selected wire, read, rule, input, or output |
| `N` | New rule |
| `Ctrl+Z`, `Ctrl+Shift+Z` | Undo and redo the newest change. In the code pane they undo and redo typing |
| `[`, `]` | Hide or show the Facts and Rule columns on a wide screen |
| `?` | Show the keys |

A keyboard-only wire is: focus a rule, press `W`, press the arrow keys until the
status line names the rule you want, and press `Enter`.

## Edit the code

The code pane shows one declaration, the selected rule with its doc comment. It
highlights Go and wraps long lines. Helpers and types are not shown, so use your
IDE for those. The sheet gives the file and line.

- Typing is saved after a short pause. The pane shows "Saved" and the status line
  says "Edited the code of" the rule. The graph redraws from the saved file.
- If the buffer does not parse, nothing is written. The pane names the line, for
  example "Syntax error at line 189", and the graph keeps the last version that
  parsed. Finish the declaration and it saves.
- The saved text is what you typed. The editor formats the declaration when the
  pane loses focus and when you press `Ctrl+S`, and the receipt then says "Edited
  and formatted". So between a pause and your next blur, the file can hold code
  that `gofmt` would change.
- Errors from the compiler appear as a mark in the gutter of the line they are
  about. A preview of a pending gesture appears in the pane without changing your
  buffer.
- If the declaration changes on disk while the pane holds unsaved text, the pane
  asks whether to load the disk version or keep your text.

## Diagnostics and fixes

The compiler checks the ruleset after each change and the result lands on the
element it concerns. The graph is drawn from a parse of the files, so it keeps
working while the code does not compile.

| Problem | Shown on | Fix links |
| --- | --- | --- |
| No input or rule produces a fact | The read row, drawn with a stub, and a note on the rule. The sheet says "No producer" and, when there is one, "did you mean" | Rename to the suggested fact, Add input, Create a rule that produces it |
| A reader's type differs from the producer's | The reader's row, which shows both types, the wire, and its label | Use the producer's type in the rule |
| A dependency cycle | Every rule on the cycle, with a note that names the cycle on one of them | Remove the wire, one link for each rule on the cycle |
| A Go type error | The rule that contains it, with the line number, and the line in the code pane | None |
| A rule that no output needs | A warning on the rule | Request its output, Delete the rule |
| An input that nothing reads | A warning on its row | Remove the input |

A fix is an ordinary change. It has a receipt, it can be undone, and one click
applies it. After a missing producer is fixed with Rename, the file is back to
what it was before the misspelling.

The wires on a cycle are not yet drawn in red. The rules on it are, and each has
its Remove link.

## Undo and history

Every write the editor makes is a receipt in the History tab. It gives a
sentence, the files with added and removed line counts, and the time. The newest
one stays in the status line with an Undo button.

- Undo writes the previous bytes back, so the file is exactly what it was. Redo
  reapplies the change.
- A save from another editor is noticed and gets its own entry, marked "Outside
  edit". Entries older than it can no longer be undone for that file, and they say
  so. Your IDE or git still has that history.
- Each entry offers "Undo to here" or "Redo to here" for several steps at once.
- `Ctrl+Z` in the code pane undoes typing in that buffer. Anywhere else it undoes
  the newest change.
- History lives in memory and ends when you stop the command.

## What gets written

The editor writes only the rule files named by `--rules`, the file that
declares `Inputs` and `Outputs`, and the generated evaluator. Each write goes to
a temporary file and is renamed over the original. It refuses symbolic links.

It regenerates the evaluator whenever the ruleset is valid, so the package keeps
compiling in your IDE after a rename. The summary line says what happened:
"Evaluator current" when nothing changed, "Evaluator updated" after a rewrite,
and "Evaluator kept from the last valid check" when the ruleset has an error and
the file on disk is the last good one. The evaluator is never overwritten with
output from a ruleset that fails its check.

Opening the page writes nothing, and neither does aiming at a rule.

## Work alongside an IDE

Save in your IDE before you edit in the graph. If the IDE holds unsaved changes
to a file and the editor writes that file, the IDE warns on its next save. The
writes are small and scoped to one declaration, so this is rare, but the editor
cannot prevent it.

Saves from your IDE appear in the graph within a quarter of a second. Both ways
of saving are noticed: writing a new file and renaming it over the old one, and
writing in place. A gesture is resolved against the file as it is when you
drop, so a drag that follows an IDE save still does the right thing.

## Limits

- This is a prototype. Expect rough edges and report them.
- There are no live values. The Scenario control is disabled, and no rule runs.
- You cannot add a helper or a type in the code pane, only edit the selected
  declaration.
- Renaming a rule does not update callers in other packages.
- The layout is automatic. You cannot arrange nodes by hand.
- It has been run only on Linux. The design targets Linux and macOS, and Windows
  is untested.
- The stub rule that New rule inserts returns an error on purpose, so it fails
  loudly until you write its body.
