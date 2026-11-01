#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createTwoFilesPatch } = require('diff');

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function readFileSafe(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeFileSafe(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function errCode(e) {
  return e && e.code ? e.code : (e && e.message ? e.message : String(e));
}

// Path traversal guard: resolve abs path and ensure it stays inside rootDir
function safeJoin(rootDir, relPath) {
  const abs = path.resolve(rootDir, relPath);
  const root = path.resolve(rootDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes project root: ${relPath}`);
  }
  return abs;
}

// State hash: sha256 over "path\0size\0content" for each file, in sorted order
function computeStateHash(rootDir, fileList) {
  const h = crypto.createHash('sha256');
  for (const rel of fileList.slice().sort()) {
    let buf;
    try { buf = fs.readFileSync(path.join(rootDir, rel)); } catch (e) { continue; }
    h.update(rel); h.update('\0');
    h.update(String(buf.length)); h.update('\0');
    h.update(buf); h.update('\0');
  }
  return h.digest('hex');
}

// Compact one-line representation of a multi-line fragment
function compactFragment(text) {
  if (text === '') return '""';
  const lines = text.split('\n');
  // drop trailing newline, if present
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return '""';
  if (lines.length === 1) return JSON.stringify(lines[0]);

  let first = lines[0];
  let last = lines[lines.length - 1];
  if (first.length > 80) first = first.slice(0, 80) + '...';
  let lastPart = last;
  if (lastPart.length > 80) lastPart = '...' + lastPart.slice(-80);
  return JSON.stringify(first + '...' + lastPart);
}

// Normalize LF/CRLF for stable comparisons
function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n');
}

// Build a real unified diff; return empty string when no differences
function makeUnifiedDiff(oldText, newText, filePath) {
  const oldNorm = normalizeNewlines(oldText);
  const newNorm = normalizeNewlines(newText);
  if (oldNorm === newNorm) return '';
  return createTwoFilesPatch(
    `a/${filePath}`,
    `b/${filePath}`,
    oldNorm,
    newNorm,
    '',
    '',
    { context: 0 }
  );
}

// ---------------------------------------------------------------------------
// bidisnap parser
// ---------------------------------------------------------------------------

const RE_COMMAND = /^======\s+(\w+)(?:\s+(.*))?$/;

function parseQuoted(str) {
  // Parse a sequence of quoted arguments: "a" "b"
  const out = [];
  let i = 0;
  while (i < str.length) {
    while (i < str.length && /\s/.test(str[i])) i++;
    if (i >= str.length) break;
    if (str[i] === '"') {
      i++;
      let s = '';
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\' && i + 1 < str.length) {
          s += str[i + 1];
          i += 2;
        } else {
          s += str[i++];
        }
      }
      i++; // closing quote
      out.push(s);
    } else {
      // fallback for unquoted arguments
      let s = '';
      while (i < str.length && !/\s/.test(str[i])) s += str[i++];
      out.push(s);
    }
  }
  return out;
}

function parseFlat(text, opts = {}) {
  const strict = !!opts.strict;
  const lines = text.split('\n');
  const commands = [];
  const errors = [];
  let i = 0;

  // skip leading lines until the first command
  while (i < lines.length && !RE_COMMAND.test(lines[i])) i++;

  while (i < lines.length) {
    const lineNo = i + 1; // 1-based for humans
    const m = RE_COMMAND.exec(lines[i]);
    if (!m) {
      if (strict && /^======/.test(lines[i])) {
        errors.push(`line ${lineNo}: unrecognized command: ${lines[i].slice(0, 120)}`);
      }
      i++; continue;
    }
    const name = m[1].toUpperCase();
    const argsStr = m[2] || '';
    i++;

    if (name === 'FILE') {
      const args = parseQuoted(argsStr);
      const filePath = args[0];
      let content = '';
      if (i < lines.length) {
        // delimiter check
        const dm = /^======(\S+)\s*$/.exec(lines[i]);
        if (dm) {
          const delimiter = dm[1];
          i++;
          const buf = [];
          while (i < lines.length && lines[i] !== '======' + delimiter) {
            buf.push(lines[i]);
            i++;
          }
          if (i < lines.length) i++; // skip closing delimiter
          content = buf.join('\n');
          // lines after closing delimiter and before next command are ignored
          while (i < lines.length && !RE_COMMAND.test(lines[i])) i++;
        } else {
          const buf = [];
          while (i < lines.length && !RE_COMMAND.test(lines[i])) {
            buf.push(lines[i]);
            i++;
          }
          content = buf.join('\n');
        }
      }
      commands.push({ type: 'FILE', path: filePath, content, line: lineNo });
    } else if (name === 'PATCH') {
      const args = parseQuoted(argsStr);
      const filePath = args[0];
      const sections = [];
      // parse FIND/REPLACE sections
      while (i < lines.length) {
        const line = lines[i];
        if (RE_COMMAND.test(line)) break;
        if (line === '<<<<<<< FIND') {
          i++;
          const findBuf = [];
          while (i < lines.length && lines[i] !== '=======') {
            findBuf.push(lines[i]);
            i++;
          }
          if (i < lines.length) i++; // skip =======
          const replaceBuf = [];
          while (i < lines.length && lines[i] !== '>>>>>>> REPLACE') {
            replaceBuf.push(lines[i]);
            i++;
          }
          if (i < lines.length) i++; // skip >>>>>>> REPLACE
          sections.push({
            find: findBuf.length ? findBuf.join('\n') + '\n' : '',
            replace: replaceBuf.length ? replaceBuf.join('\n') + '\n' : '',
          });
        } else {
          i++; // ignore lines between sections
        }
      }
      commands.push({ type: 'PATCH', path: filePath, sections, line: lineNo });
    } else if (name === 'DELETE') {
      const args = parseQuoted(argsStr);
      // skip until next command
      while (i < lines.length && !RE_COMMAND.test(lines[i])) i++;
      commands.push({ type: 'DELETE', path: args[0], line: lineNo });
    } else if (name === 'MOVE') {
      const args = parseQuoted(argsStr);
      while (i < lines.length && !RE_COMMAND.test(lines[i])) i++;
      commands.push({ type: 'MOVE', from: args[0], to: args[1], line: lineNo });
    } else {
      // unknown command — skip
      while (i < lines.length && !RE_COMMAND.test(lines[i])) i++;
      if (strict) errors.push(`line ${lineNo}: unknown command '${name}'`);
    }
  }
  return { commands, errors };
}

// Backwards-compatible wrapper: old callers expected an array
function parseFlatLegacy(text) {
  return parseFlat(text).commands;
}

// ---------------------------------------------------------------------------
// Apply commands (unsnap)
// ---------------------------------------------------------------------------
//
// Architecture: all commands are applied to an in-memory "sandbox".
// The sandbox is a Map<absPath, { content: string|null, loaded: boolean }>,
// where content === null means "file does not exist", and loaded indicates
// whether we have already loaded the content from disk.
//
// For each affected file a "last action" is tracked:
//   { kind: 'write', abs, content }   — write content
//   { kind: 'delete', abs }           — delete file
//   { kind: 'move', from, to }        — move file
// Actions are accumulated and applied to disk only at the end — and only
// when !dryRun. This guarantees that MOVE/DELETE/FILE affect subsequent
// PATCH/DELETE/MOVE both in dry-run and in real runs.
//
// For dry-run, the diff is built between the original content (from disk)
// and the content in the sandbox after all commands.

function applyCommands(commands, rootDir, opts = {}) {
  const dryRun = !!opts.dryRun;
  const results = [];
  const diffs = [];
  var hasErrors = false;

  function log(line) {
    results.push(line);
    if (line.startsWith("FAILED") || line.startsWith("- FAILED")) hasErrors = true;
  }

  // --- in-memory sandbox ---
  // absPath -> { content: string|null, loaded: boolean, original: string|null }
  // `original` is captured on first load and used for diff.
  const sandbox = new Map();

  function loadEntry(abs) {
    let e = sandbox.get(abs);
    if (!e) {
      let content = null;
      try { content = readFileSafe(abs); } catch (err) { content = null; }
      e = { content, loaded: true, original: content };
      sandbox.set(abs, e);
    }
    return e;
  }

  function getContent(abs) {
    const e = loadEntry(abs);
    return e.content; // string | null
  }

  function setContent(abs, content) {
    const e = loadEntry(abs);
    e.content = content;
  }

  function removeContent(abs) {
    const e = loadEntry(abs);
    e.content = null;
  }

  // --- accumulated disk actions ---
  // We use a Map so that the "last action" for a path overwrites the
  // previous one (as in a real filesystem), but keep the first-mention
  // order for determinism.
  const actions = new Map(); // absKey -> action
  const actionOrder = [];    // absKey list in first-touch order

  function schedule(key, action) {
    if (!actions.has(key)) actionOrder.push(key);
    actions.set(key, action);
  }

  function scheduleWrite(abs, content) {
    // Cancels a previous move/delete on this path
    schedule(abs, { kind: 'write', abs, content });
  }

  function scheduleDelete(abs) {
    schedule(abs, { kind: 'delete', abs });
  }

  function scheduleMove(fromAbs, toAbs) {
    // A move is a separate operation; for the target path a subsequent
    // write to the sandbox will overwrite it.
    schedule(fromAbs, { kind: 'delete', abs: fromAbs, moved: true, to: toAbs });
    schedule(toAbs, { kind: 'write', abs: toAbs, content: null, fromMove: true });
  }

  function diffForContent(abs, relPath, newContent) {
    // newContent === null => file was deleted
    const e = sandbox.get(abs);
    const oldContent = e ? e.original : (() => {
      try { return readFileSafe(abs); } catch (err) { return null; }
    })();
    if (oldContent === null && newContent === null) return '';
    if (oldContent === null) {
      const added = normalizeNewlines(newContent);
      if (added.length === 0) return '';
      return (
        `--- /dev/null\n+++ b/${relPath}\n` +
        added.split('\n').slice(0, -1).map(l => '+' + l).join('\n') + '\n'
      );
    }
    if (newContent === null) {
      return `--- a/${relPath}\n+++ /dev/null\n`;
    }
    return makeUnifiedDiff(oldContent, newContent, relPath);
  }

  for (const cmd of commands) {
    if (cmd.type === 'FILE') {
      let abs;
      try { abs = safeJoin(rootDir, cmd.path); }
      catch (e) { log(`FAILED: FILE "${cmd.path}" - ${e.message}`); continue; }

      const oldContent = getContent(abs);
      if (oldContent !== null && normalizeNewlines(oldContent) === normalizeNewlines(cmd.content)) {
        log(`UNCHANGED: FILE "${cmd.path}"`);
        // The file already matches, but if a move/delete was previously
        // scheduled for this path — we must guarantee the final content.
        scheduleWrite(abs, cmd.content);
      } else {
        setContent(abs, cmd.content);
        scheduleWrite(abs, cmd.content);
        log(`SUCCESS: FILE "${cmd.path}"`);
      }

      if (dryRun) {
        const patch = diffForContent(abs, cmd.path, cmd.content);
        if (patch) diffs.push(patch);
      }
    } else if (cmd.type === 'DELETE') {
      let abs;
      try { abs = safeJoin(rootDir, cmd.path); }
      catch (e) { log(`FAILED: DELETE "${cmd.path}" - ${e.message}`); continue; }

      const existed = getContent(abs) !== null;
      if (!existed) {
        log(`FAILED: DELETE "${cmd.path}" - cannot delete file, error code: ENOENT`);
        continue;
      }
      removeContent(abs);
      scheduleDelete(abs);
      log(`SUCCESS: DELETE "${cmd.path}"`);

      if (dryRun) {
        const patch = diffForContent(abs, cmd.path, null);
        if (patch) diffs.push(patch);
      }
    } else if (cmd.type === 'MOVE') {
      let absFrom, absTo;
      try {
        absFrom = safeJoin(rootDir, cmd.from);
        absTo = safeJoin(rootDir, cmd.to);
      } catch (e) {
        log(`FAILED: MOVE "${cmd.from}" "${cmd.to}" - ${e.message}`);
        continue;
      }
      const fromContent = getContent(absFrom);
      if (fromContent === null) {
        log(`FAILED: MOVE "${cmd.from}" "${cmd.to}" - cannot move file, error code: ENOENT`);
        continue;
      }
      // the target path may already exist in the sandbox — overwrite it
      setContent(absTo, fromContent);
      removeContent(absFrom);
      scheduleMove(absFrom, absTo);
      log(`SUCCESS: MOVE "${cmd.from}" "${cmd.to}"`);
      // For MOVE we do not emit a diff (as before) — the move is
      // reflected only via success/failure.
    } else if (cmd.type === 'PATCH') {
      let abs;
      try { abs = safeJoin(rootDir, cmd.path); }
      catch (e) { log(`FAILED: PATCH "${cmd.path}" - ${e.message}`); continue; }

      const content = getContent(abs);
      if (content === null) {
        log(`FAILED: PATCH "${cmd.path}" - could not read file, error code: ENOENT`);
        continue;
      }

      let changed = false;
      const sectionLines = [];
      let newContent = content;
      for (const sec of cmd.sections) {
        const frag = `${compactFragment(sec.find)} ===> ${compactFragment(sec.replace)}`;
        if (sec.find === '') {
          sectionLines.push(`- FAILED: PATCH ${frag} - FIND fragment not found`);
          continue;
        }
        let idx = newContent.indexOf(sec.find);
        if (idx === -1) {
          // edge case: fragment is exactly at EOF w/o EOL
          idx = (newContent + "\n").indexOf(sec.find);
        }
        if (idx === -1) {
          const firstLine = sec.find.split('\n')[0].slice(0, 100);
          sectionLines.push(`- FAILED: PATCH ${frag} - FIND fragment not found (starts with: ${JSON.stringify(firstLine)})`);
        } else {
          newContent = newContent.slice(0, idx) + sec.replace +
            newContent.slice(idx + sec.find.length);
          changed = true;
          sectionLines.push(`- SUCCESS: ${frag}`);
        }
      }

      if (changed) {
        setContent(abs, newContent);
        scheduleWrite(abs, newContent);
      }

      if (dryRun && changed) {
        const patch = diffForContent(abs, cmd.path, newContent);
        if (patch) diffs.push(patch);
      }

      log(`PATCH "${cmd.path}"`);
      for (const l of sectionLines) log(l);
    }
  }

  // --- apply actions to disk (only when !dryRun) ---
  // Order: first move/delete, then write. Since the sandbox already
  // reflects the final state, for "write" we write the final content,
  // and for "delete" — we delete. For "move" renameSync is used.
  if (!dryRun && !hasErrors) {
    // Phase 1: moves and deletions
    for (const key of actionOrder) {
      const a = actions.get(key);
      if (a.kind === 'delete') {
        try {
          if (fs.existsSync(a.abs)) fs.unlinkSync(a.abs);
        } catch (e) {
          log(`FAILED: DELETE "${path.relative(rootDir, a.abs).split(path.sep).join('/')}" - cannot delete file, error code: ${errCode(e)}`);
        }
      } else if (a.kind === 'move') {
        // not used (see scheduleMove: decomposed into delete+write)
      }
    }
    // Phase 2: writes of final content
    for (const key of actionOrder) {
      const a = actions.get(key);
      if (a.kind === 'write') {
        const rel = path.relative(rootDir, a.abs).split(path.sep).join('/');
        if (a.fromMove && a.content === null) {
          // a move; has content already been written via the source path? no —
          // here content is taken from the sandbox to reflect subsequent PATCHes
          const e = sandbox.get(a.abs);
          const finalContent = e ? e.content : null;
          if (finalContent === null) continue;
          try { writeFileSafe(a.abs, finalContent); }
          catch (e2) { log(`FAILED: FILE "${rel}" - cannot write file, error code: ${errCode(e2)}`); }
        } else {
          try { writeFileSafe(a.abs, a.content); }
          catch (e2) { log(`FAILED: FILE "${rel}" - cannot write file, error code: ${errCode(e2)}`); }
        }
      }
    }
    // Additionally: if the sandbox still has paths where original !== content
    // with no actions recorded for them (e.g. a MOVE+PATCH sequence to a new
    // path), guarantee the write.
    for (const [abs, e] of sandbox) {
      if (e.content === null) continue;
      if (e.original === e.content) continue;
      if (actions.has(abs)) continue;
      const rel = path.relative(rootDir, abs).split(path.sep).join('/');
      try { writeFileSafe(abs, e.content); }
      catch (e2) { log(`FAILED: FILE "${rel}" - cannot write file, error code: ${errCode(e2)}`); }
    }
  }

  return { results, diffs };
}

// ---------------------------------------------------------------------------
// Spec and snap
// ---------------------------------------------------------------------------

function globToRegex(glob) {
  // simple implementation: ** and *
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** — any directories
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if ('\\^$+?.()|{}[]'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

function expandBraces(pattern) {
  // support simple {a,b} and {a|b}
  const m = /^(.*?)\{([^{}]*)\}(.*)$/.exec(pattern);
  if (!m) return [pattern];
  const [, pre, body, post] = m;
  const parts = body.split(/[,|]/);
  const out = [];
  for (const p of parts) {
    for (const sub of expandBraces(pre + p + post)) out.push(sub);
  }
  return out;
}

function matchesAny(relPath, patterns) {
  for (const pat of patterns) {
    for (const expanded of expandBraces(pat)) {
      if (globToRegex(expanded).test(relPath)) return true;
    }
  }
  return false;
}

function walkDir(dir, base) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (ent.isDirectory()) {
      out.push(...walkDir(abs, base));
    } else if (ent.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

// Normalize a raw spec (array) into a list of groups:
//   [{ name: "", rules: [...] }, { name: "group1", rules: [...] }, ...]
// Flat rules (top-level entries without "group") belong to the "" group.
// Group entries have shape { group: "name", list: [rules...] }.
function normalizeSpecGroups(raw) {
  if (!Array.isArray(raw)) {
    throw new Error('snap spec must be a JSON array');
  }
  const groups = new Map(); // name -> rules[]
  groups.set('', []);       // default group always exists

  for (const item of raw) {
    if (item && typeof item === 'object' && !Array.isArray(item) &&
        Object.prototype.hasOwnProperty.call(item, 'group')) {
      const name = String(item.group);
      if (!Array.isArray(item.list)) {
        throw new Error(`spec group "${name}" must have a "list" array`);
      }
      if (!groups.has(name)) groups.set(name, []);
      // merge (allow several blocks for the same group)
      for (const r of item.list) groups.get(name).push(r);
    } else {
      groups.get('').push(item);
    }
  }

  // Preserve "" first, then insertion order of other groups
  const ordered = [];
  ordered.push({ name: '', rules: groups.get('') });
  for (const [name, rules] of groups) {
    if (name === '') continue;
    ordered.push({ name, rules });
  }
  return ordered;
}

function loadSpec(specPath) {
  const abs = path.resolve(specPath);
  const rootDir = path.dirname(abs);
  const specName = path.basename(abs);
  const raw = JSON.parse(readFileSafe(abs));
  const groups = normalizeSpecGroups(raw);
  // rules: flattened list (all groups) — kept for backwards compatibility
  // (e.g. ai-header scanning, which is global to the spec).
  const rules = [];
  for (const g of groups) for (const r of g.rules) rules.push(r);
  return { rootDir, specName, rules, groups, specPath: abs };
}

// Compute the file list for a given set of rules.
// `rules` may be a flat array (legacy) or a group's rule list.
// `snapFileName` (single name or array) is auto-excluded from the result.
function computeFileList(spec, snapFileName, rules) {
  const allFiles = walkDir(spec.rootDir, spec.rootDir);
  const included = new Set();
  const excluded = new Set();

  const autoExclude = new Set();
  const names = Array.isArray(snapFileName) ? snapFileName : [snapFileName];
  for (const name of [spec.specName, ...names]) {
    if (!name) continue;
    // normalize to relative-to-root form
    const rel = path.relative(spec.rootDir, path.resolve(spec.rootDir, name))
      .split(path.sep).join('/');
    autoExclude.add(rel);
  }

  for (const rule of (rules || spec.rules || [])) {
    if (rule.include) {
      const pats = Array.isArray(rule.include) ? rule.include : [rule.include];
      for (const f of allFiles) {
        if (autoExclude.has(f)) continue;
        if (matchesAny(f, pats)) {
          included.add(f);
          excluded.delete(f);
        }
      }
    }
    if (rule.exclude) {
      const pats = Array.isArray(rule.exclude) ? rule.exclude : [rule.exclude];
      for (const f of allFiles) {
        if (autoExclude.has(f)) continue;
        if (matchesAny(f, pats)) {
          excluded.add(f);
          included.delete(f);
        }
      }
    }
  }

  // files that fell into exclude after include are already removed; sort
  return Array.from(included).sort();
}

// Build the default snap file name for a given group.
// "" -> "spec.snap.txt"; "group1" -> "spec.snap-group1.txt"
function defaultSnapName(specName, groupName) {
  const base = specName.replace(/\.[^.]+$/, '');
  if (!groupName) return base + '.snap.txt';
  const safe = String(groupName).replace(/[^A-Za-z0-9._-]/g, '_');
  return base + '.snap-' + safe + '.txt';
}

function isSnapFileName(name) {
  return /\.snap.*\.txt$/i.test(name);
}

// Read the AI header for a spec (one global header per spec).
function readAiHeader(spec) {
  var headerLocations = null, aiHeaderFilename = "default.en.txt";
  for (var rule of spec.rules) {
    if (rule && rule["ai-header"]) {
      if (headerLocations) {
        console.error("Invalid snap spec: ai-header specified more than once");
        process.exit(1);
      }
      aiHeaderFilename = rule["ai-header"];
      headerLocations = [
        safeJoin(spec.rootDir, aiHeaderFilename),
        safeJoin(path.join(__dirname, "default-headers"), aiHeaderFilename),
      ];
    }
  }
  if (!headerLocations) {
    headerLocations = [safeJoin(path.join(__dirname, "default-headers"), aiHeaderFilename)];
  }

  var AI_HEADER;
  for (var headerLocation of headerLocations) {
    try {
      AI_HEADER = readFileSafe(headerLocation) + "\n";
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  if (!AI_HEADER) {
    throw new Error("Failed to read AI header from location " + aiHeaderFilename);
  }
  return AI_HEADER;
}

// Snap one group into a single .snap.txt file. Returns the absolute path.
function snapGroup(spec, groupName, aiHeader, snapFileName, outPath) {
  const group = (spec.groups || []).find(g => g.name === groupName);
  if (!group) throw new Error(`unknown group: "${groupName}"`);

  // Auto-exclude every default snap file name (all groups), so that
  // re-snapping a project never includes stale snap files.
  const allSnapNames = (spec.groups || [{ name: '' }]).map(g => defaultSnapName(spec.specName, g.name));
  const files = computeFileList(spec, allSnapNames, group.rules);
  const stateHash = computeStateHash(spec.rootDir, files);
  let out = aiHeader + `# state: ${stateHash}\n`;
  for (const f of files) {
    const content = readFileSafe(path.join(spec.rootDir, f));
    const lines = content.split('\n');
    let needsDelimiter = false;
    for (const line of lines) {
      if (RE_COMMAND.test(line) || /^======\S+\s*$/.test(line)) {
        needsDelimiter = true;
        break;
      }
    }
    out += `\n====== FILE "${f}"\n`;
    if (needsDelimiter) {
      let delim = '>>>';
      let guard = 0;
      while (content.includes('======' + delim)) {
        delim = '>' + delim;
        if (++guard > 20) { delim = '>' + Math.random().toString(36).slice(2); break; }
      }
      out += `======${delim}\n`;
      out += content;
      out += '\n';
      out += `======${delim}\n`;
    } else {
      out += content;
    }
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out, 'utf8');
  console.log(`Snap file written: ${outPath} (${files.length} files)`);
  return outPath;
}

// Snap groups of a spec.
//
//   doSnap(specFile)
//       -> snap all groups to their default file names
//   doSnap(specFile, explicitSnapPath)
//       -> snap a single (default "" only if spec has no groups) to a file
//   doSnap(specFile, explicitSnapPath, [groups...])
//       -> snap listed groups; explicitSnapPath allowed only for 1 group
//
// Returns the array of written absolute paths.
function doSnap(specFilePath, snapFilePath, groupNames) {
  const spec = loadSpec(specFilePath);
  const AI_HEADER = readAiHeader(spec);

  // Backwards compatibility: old signature doSnap(specFile, snapFilePath)
  // where snapFilePath may be either an explicit .snap file OR a group name.
  // Newer callers pass groups explicitly as third argument.
  let groups;
  let explicitOut = null;

  if (Array.isArray(groupNames)) {
    groups = groupNames.slice();
    if (snapFilePath) explicitOut = snapFilePath;
  } else if (snapFilePath) {
    // Disambiguate legacy two-arg call.
    if (isSnapFileName(path.basename(snapFilePath)) || /[\\/]/.test(snapFilePath)) {
      explicitOut = snapFilePath;
      groups = [''];
    } else {
      groups = [snapFilePath];
    }
  } else {
    groups = null; // all groups
  }

  if (!groups || !groups.length) {
    groups = (spec.groups || [{ name: '' }]).map(g => g.name);
  }

  // Validate group names
  for (const g of groups) {
    if (!(spec.groups || []).some(x => x.name === g)) {
      throw new Error(`unknown group: "${g}" (available: ${(spec.groups || []).map(x => x.name || '""').join(', ')})`);
    }
  }

  if (explicitOut) {
    if (groups.length !== 1) {
      throw new Error(
        `explicit snap file name "${explicitOut}" is only allowed when a single group is exported ` +
        `(got ${groups.length} groups: ${groups.map(g => g || '""').join(', ')})`
      );
    }
    const abs = path.resolve(explicitOut);
    return [snapGroup(spec, groups[0], AI_HEADER, path.basename(abs), abs)];
  }

  const written = [];
  for (const g of groups) {
    const name = defaultSnapName(spec.specName, g);
    const abs = path.join(spec.rootDir, name);
    written.push(snapGroup(spec, g, AI_HEADER, name, abs));
  }
  return written;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Usage:
  node bidisnap.js snap specfile.json [specfile.snap.txt]
  node bidisnap.js unsnap [--strict] [--no-state-check] specfile.unsnap.txt
  node bidisnap.js diff   [--strict] specfile.unsnap.txt
  node bidisnap.js check  [--strict] specfile.unsnap.txt
  node bidisnap.js help

Commands:
  snap    Collect files listed in the spec into a snap file.
          Groups can be selected: snap spec.json [group ...] [out.snap.txt]
          (out.snap.txt allowed only when a single group is exported).
  unsnap  Apply commands from one or more unsnap files to the project.
          Multiple files are concatenated in the given order (with an
          extra newline between them) before being applied.
  diff    Show the diff result of applying unsnap file(s) (dry-run).
  check   Only verify that the unsnap file(s) can be applied (no writes, no diff).
  help    Show this help.

Flags:
  --strict           Fail on unrecognized "======" lines in the input.
  --no-state-check   Skip comparing "# state:" in the flat header with
                     the current project state.
`);
}

// Parse leading "--flag" options from args; return {opts, rest}
function parseFlags(argv) {
  const opts = { strict: false, noStateCheck: false };
  const rest = [];
  for (const a of argv) {
    if (a === '--strict') opts.strict = true;
    else if (a === '--no-state-check') opts.noStateCheck = true;
    else rest.push(a);
  }
  return { opts, rest };
}

// Extract "# state: <hash>" from the header of the flat file, if present
function extractStateHash(text) {
  const m = /^#\s*state:\s*([0-9a-f]{64})\s*$/m.exec(text);
  return m ? m[1] : null;
}

function main() {
  const [, , cmd, ...args] = process.argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }
  if (cmd === 'snap') {
    if (!args[0]) {
      console.error('Usage: snap specfile.json [group ...] [out.snap.txt]');
      process.exit(1);
    }
    const specFile = args[0];
    const rest = args.slice(1);
    let outFile = null;
    let groups = [];
    for (const a of rest) {
      if (isSnapFileName(path.basename(a))) {
        if (outFile) { console.error('snap: only one output file name is allowed'); process.exit(1); }
        outFile = a;
      } else {
        groups.push(a);
      }
    }
    try {
      const written = outFile
        ? doSnap(specFile, outFile, groups)
        : (groups.length ? doSnap(specFile, null, groups) : doSnap(specFile));
      if (written.length > 1) {
        console.log(`Snapped ${written.length} group(s).`);
      }
    } catch (e) {
      console.error(`snap: ${e.message}`);
      process.exit(1);
    }
    return;
  }
  if (cmd === 'unsnap' || cmd === 'diff' || cmd === 'check') {
    const { opts, rest } = parseFlags(args);
    if (!rest[0]) { console.error(`Usage: ${cmd} [--strict] [--no-state-check] specfile.unsnap.txt [more.unsnap.txt ...]`); process.exit(1); }
    // Support multiple unsnap files: their contents are concatenated
    // in the given order with an extra "\n" at file boundaries.
    const files = rest.map(f => path.resolve(f));
    const rootDir = path.dirname(files[0]);
    const parts = [];
    for (const file of files) {
      let text;
      try { text = readFileSafe(file); }
      catch (e) { console.error(`Cannot read file: ${errCode(e)}`); process.exit(1); }
      parts.push(text);
    }
    const text = parts.join('\n');
    const parsed = parseFlat(text, { strict: opts.strict });
    if (parsed.errors.length) {
      for (const e of parsed.errors) console.error(`parse error: ${e}`);
      process.exit(2);
    }
    const commands = parsed.commands;

    // state check: warn if the snap file was produced from a different project state
    if (!opts.noStateCheck) {
      const expected = extractStateHash(text);
      if (expected) {
        // compute the list of files relevant to the snap file from its FILE
        // commands, plus files referenced by PATCH/DELETE/MOVE
        const touched = new Set();
        for (const c of commands) {
          if (c.type === 'FILE') touched.add(c.path);
          else if (c.type === 'PATCH') touched.add(c.path);
          else if (c.type === 'DELETE') touched.add(c.path);
          else if (c.type === 'MOVE') { touched.add(c.from); touched.add(c.to); }
        }
        const present = [];
        for (const rel of touched) {
          try { fs.accessSync(path.resolve(rootDir, rel)); present.push(rel); }
          catch (e) { /* missing files still participate in hash via absence */ }
        }
        // We can only recompute a meaningful hash over files that existed at
        // snap time AND that are referenced by this input. Since we do not
        // know the original list, we compare only presence: if the snap file
        // was generated by doSnap, it embedded the hash of the full list.
        // Recomputing without the list is impossible, so we treat this as a
        // soft check: verify that the hash looks well-formed and warn when
        // the project has obviously changed (heuristic: none of the touched
        // files exist).
        if (present.length === 0 && touched.size > 0) {
          process.stderr.write(
            `warning: snap state ${expected} was recorded, but none of ${touched.size} ` +
            `referenced file(s) exist under ${rootDir}; the patch may be stale.\n`
          );
        }
      }
    }

    const dryRun = cmd === 'diff';
    const checkOnly = cmd === 'check';
    const { results, diffs } = applyCommands(commands, rootDir, { dryRun: dryRun || checkOnly });
    const failed = results.filter(r => r.includes('FAILED'));
    const exitCode = failed.length ? 1 : 0;

    if (checkOnly) {
      if (failed.length) {
        process.stdout.write(failed.join('\n') + '\n');
      } else {
        process.stdout.write('# OK: unsnap input can be applied\n');
      }
      process.exit(exitCode);
    }

    if (dryRun) {
      process.stdout.write(diffs.join('\n'));
      if (failed.length) {
        process.stdout.write('\n# Errors:\n' + failed.join('\n') + '\n');
      }
      if (!failed.length && !diffs.length) {
        process.stdout.write('\n# No diffs introduced by unsnapping this input\n');
      }
    } else {
      process.stdout.write(results.join('\n') + '\n');
      if (failed.length) {
        process.stdout.write('\n# Errors:\n' + failed.join('\n') + '\n# Unsnap cancelled due to errors, no files have been changed');
      }
    }
    process.exit(exitCode);
  }
  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseFlat,          // new: returns { commands, errors }
  parseFlatLegacy,    // old: returns array
  applyCommands,
  doSnap,
  computeFileList,
  globToRegex,
  computeStateHash,
  safeJoin,
};
