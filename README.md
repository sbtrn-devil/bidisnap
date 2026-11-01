# bidisnap

A small tool for working with multi-file projects through an AI chat, minimizing
the manual effort of moving source data into the chat and results back out.

`bidisnap` is a shorthand for `Bidirectional Snap` which reflects the basic idea,
making snapshots of a project for processing and then applying processing results
in the other direction. It also serves as a distinguished name for the snapshot
format for easier AI anchoring.

## What it is

`bidisnap` is a CLI that packs a selected set of project files into a single
plain-text *snap* file, and applies AI-produced edits back to the project as a
patch in the same format. The format is deliberately simple, line-oriented and
copy-pasteable: it is meant to be attached to a chat message and to be returned
by the model as-is.

### The pipeline

1. Create a JSON **specification** listing the files to include (include/exclude
   globs, optionally split into named groups).
2. Extract those files into a **snap file** with `bidisnap snap`.
3. Attach or paste the snap file into the AI chat together with the task, and
   ask for the result to be returned in bidisnap format.
4. Save the chat's answer as an **unsnap file** (or several files, if the model
   returns several patches).
5. Dry-run the result with `bidisnap diff`.
6. If there are no errors and the diff looks acceptable, apply it for real with
   `bidisnap unsnap`.
7. Repeat from step 2 as needed.

### The bidisnap format

```
====== FILE "path"           — create/replace a file
====== PATCH "path"          — replace fragment(s) inside an existing file
====== DELETE "path"         — delete a file
====== MOVE "from" "to"      — rename a file
```

For `PATCH`, each FIND/REPLACE section is delimited by `<<<<<<< FIND`, `=======`
and `>>>>>>> REPLACE`:

```
====== PATCH "src/hello.js"
<<<<<<< FIND
console.log("hello");
=======
console.log("hello, world");
>>>>>>> REPLACE
```

If a file's own content contains lines that look like bidisnap commands (for
example, a Markdown file documenting this format), wrap the content in a
delimiter: an arbitrary non-whitespace token, with content between the opening
and closing `======<delimiter>` lines.

## Installation

Requires Node.js >= 13.

```sh
npm install git+https://github.com/sbtrn-devil/bidisnap -g
```

Then use via `bidisnap` command:

```sh
bidisnap help
```

## Usage

### Specification

The spec is a JSON array of rules. A rule has an `include` and/or `exclude`
field (a glob or an array of globs). To split a project into named groups, use
objects of the form `{ "group": "name", "list": [ ...rules... ] }`. Top-level
rules belong to the default (unnamed) group.

```json
[
  { "include": ["src/**", "README.md"] },
  { "exclude": ["**/*.tmp"] },
  { "group": "docs", "list": [ { "include": ["docs/**"] } ] }
]
```

Path to files are specified relative to the project root, which is the directory
where the specification file itself is located.

The snap file will be created with prepended AI header - description of the file
and of the bidisnap format, but this snippet can also be customized:

```json
[
  { "ai-header": "path/to/snippet/file.txt" },
  ...
]
```

The path to file is, similar to groups specification, relative to the project root.
Alternatively, there are the following built-in snippet names, which are corresponding
translations of the default snippet:
- `"default.en.txt"` - English (essentially the default snippet itself),
- `"default.ru.txt"` - Russian,
- `"default.cn.txt"` - Chinese,
- `"default.tr.txt"` - Turkish,
- `"default.es.txt"` - Spanish.

Using localized snippet may affect the response language of the chat, so pick the one
that works better in your case, or bring your own one if the required locale is missing.

### Snap

```sh
bidisnap snap spec.json                      # all groups, default names
bidisnap snap spec.json docs                 # one group, default name
bidisnap snap spec.json docs out.snap.txt    # one group, explicit name
```

Default snap file names: `spec.snap.txt` for the default group, `spec.snap-<group>.txt`
for named groups. Spec and snap files are auto-excluded from the result (but it can
still be a good idea to explicitly add them to `exclude`-s to avoid any accidental
issues), and the snap header records a `# state:` hash of the packed content.

### Unsnap / diff / check

```sh
bidisnap diff  answer.snap.txt    # dry-run: show the diff
bidisnap check answer.snap.txt    # dry-run: only verify applicability
bidisnap unsnap answer.snap.txt   # apply for real
```

Several unsnap files may be passed; they are concatenated in order.

Flags:

- `--strict` — fail on unrecognized `======` lines.
- `--no-state-check` — skip the `# state:` header comparison.

## Practical tips

- Input files are expected to be UTF-8 (or at least pure ASCII). Prefer LF line
  endings: preserving CR+LF after non-trivial edits is not guaranteed.
- Start a fresh chat per task and upload a fresh snap file, so the model begins
  from the most direct input and has maximum context headroom.
- Apply the AI answer (steps 4–6) without intermediate manual edits to the
  code: the answer was computed for the exact state of the files that were
  shown to the model. If that state changes, the answer may become
  inapplicable — or, worse, apply with a wrong result.
- The model sometimes makes small typos in `PATCH` FIND fragments. If you see
  "FIND fragment not found" errors, first check whether that is the cause and
  whether it can be fixed by a targeted manual edit of the answer.
- As the project grows, split files into small groups and give tasks per group.
- Back up critical files (or keep them in version control) before AI editing, so
  you can return to an acceptable version if something goes wrong.
- Keep snap files small enough that the model has room to reason; do not pack
  the whole repository if a task only touches a few files.
- Review the dry-run diff carefully: a clean `check` only means the patch is
  applicable, not that it is correct.
- When a task spans several rounds, re-snap after each applied round so that
  subsequent answers are based on the actual current state.

## A note on how this tool was built

This tool was itself developed in the way described above: with DeepSeek and
successive versions of the tool editing its own source, starting from a
prototype produced by a bootstrap request. It is, in a sense, its own proof of
concept.

## License

MIT