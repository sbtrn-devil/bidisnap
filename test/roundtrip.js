#!/usr/bin/env node
'use strict';

// Round-trip test: build a small project, snap it, unsnap into an empty
// directory, compare trees. Also exercises PATCH, DELETE, MOVE, and the
// path-traversal guard.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bidisnap.js');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function readTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) out[rel] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function assertTreesEqual(a, b, msg) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  assert.deepStrictEqual(ka, kb, `${msg}: file lists differ`);
  for (const k of ka) assert.strictEqual(a[k], b[k], `${msg}: content differs in ${k}`);
}

function run(args, cwd) {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

function main() {
  const src = mkTmp('bidisnap-roundtrip-src-');
  const dst = mkTmp('bidisnap-roundtrip-dst-');

  // Fixture
  write(path.join(src, 'src/a.js'), 'export const a = 1;\n');
  write(path.join(src, 'src/b.js'), 'export const b = 2;\n');
  write(path.join(src, 'README.md'), '# demo\n');
  write(path.join(src, 'spec.json'), JSON.stringify([
    { include: ['src/**', 'README.md'] },
    {exclude: ['**/*.tmp'] }
  ], null, 2));

  // 1) snap
  run(['snap', 'spec.json', 'project.snap.txt'], src);
  const snapPath = path.join(src, 'project.snap.txt');
  const snapText = fs.readFileSync(snapPath, 'utf8');
  assert.ok(/^# state: [0-9a-f]{64}$/m.test(snapText), 'snap header must contain state hash');

  // 2) unsnap into a clean directory
  //    Copy the snap file into dst so that rootDir == dst
  fs.copyFileSync(snapPath, path.join(dst, 'project.snap.txt'));
  run(['unsnap', 'project.snap.txt'], dst);

  // 3) compare (ignore the spec/snap files themselves — they are auto-excluded
  //    from snap output, so they won't be in dst)
  const srcTree = readTree(src);
  const dstTree = readTree(dst);
  delete srcTree['spec.json'];
  delete srcTree['project.snap.txt'];
  delete dstTree['project.snap.txt'];
  assertTreesEqual(srcTree, dstTree, 'roundtrip');

  // 4) PATCH: modify a file, re-snap, apply diff
  write(path.join(src, 'src/a.js'), 'export const a = 42;\n');
  run(['snap', 'spec.json', 'project2.snap.txt'], src);
  // Replace "a = 1" with "a = 42" is a full-file rewrite in flat; simulate
  // a targeted PATCH instead, to exercise the PATCH path.
  const patchFile = path.join(dst, 'edit.snap.txt');
  fs.writeFileSync(patchFile, [
    '====== PATCH "src/a.js"',
    '<<<<<<< FIND',
    'export const a = 1;',
    '=======',
    'export const a = 42;',
    '>>>>>>> REPLACE',
    '',
  ].join('\n'), 'utf8');
  run(['check', 'edit.snap.txt'], dst);
  run(['unsnap', 'edit.snap.txt'], dst);
  assert.strictEqual(
    fs.readFileSync(path.join(dst, 'src/a.js'), 'utf8'),
    'export const a = 42;\n',
    'PATCH applied'
  );

  // 5) DELETE
  fs.writeFileSync(path.join(dst, 'del.snap.txt'),
    '====== DELETE "src/b.js"\n', 'utf8');
  run(['unsnap', 'del.snap.txt'], dst);
  assert.ok(!fs.existsSync(path.join(dst, 'src/b.js')), 'DELETE applied');

  // 6) MOVE
  fs.writeFileSync(path.join(dst, 'mv.snap.txt'),
    '====== MOVE "src/a.js" "src/c.js"\n', 'utf8');
  run(['unsnap', 'mv.snap.txt'], dst);
  assert.ok(!fs.existsSync(path.join(dst, 'src/a.js')), 'MOVE removed source');
  assert.ok(fs.existsSync(path.join(dst, 'src/c.js')), 'MOVE created dest');

  // 7) Path traversal must be rejected
  fs.writeFileSync(path.join(dst, 'evil.snap.txt'),
    '====== FILE "../evil.txt"\npwned\n', 'utf8');
  let threw = false;
  try { run(['unsnap', 'evil.snap.txt'], dst); } catch (e) { threw = true; }
  assert.ok(threw, 'path traversal must fail with non-zero exit');
  assert.ok(!fs.existsSync(path.join(path.dirname(dst), 'evil.txt')), 'no file written outside root');

  // 8) check on a bogus PATCH must fail
  fs.writeFileSync(path.join(dst, 'bad.snap.txt'), [
    '====== PATCH "src/c.js"',
    '<<<<<<< FIND',
    'this line does not exist',
    '=======',
    'x',
    '>>>>>>> REPLACE',
    '',
  ].join('\n'), 'utf8');
  let badThrew = false;
  try { run(['check', 'bad.snap.txt'], dst); } catch (e) { badThrew = true; }
  assert.ok(badThrew, 'check must fail on non-applicable PATCH');

  // 8b) Multiple unsnap files are concatenated in order (extra newline at boundary)
  fs.writeFileSync(path.join(dst, 'multi-1.snap.txt'),
    '====== FILE "multi/one.txt"\none\n', 'utf8');
  fs.writeFileSync(path.join(dst, 'multi-2.snap.txt'),
    '====== FILE "multi/two.txt"\ntwo\n', 'utf8');
  run(['unsnap', 'multi-1.snap.txt', 'multi-2.snap.txt'], dst);
  assert.strictEqual(fs.readFileSync(path.join(dst, 'multi/one.txt'), 'utf8'), 'one\n',
    'multi unsnap: first file applied');
  assert.strictEqual(fs.readFileSync(path.join(dst, 'multi/two.txt'), 'utf8'), 'two\n',
    'multi unsnap: second file applied');

  // 8c) Boundary between files behaves like an extra newline: a FILE command
  //     whose body is at the very end of file-1 should not swallow the first
  //     line of file-2 (which must be parsed as a separate command).
  fs.writeFileSync(path.join(dst, 'multi-a.snap.txt'),
    '====== FILE "multi/a.txt"\nA', 'utf8'); // no trailing newline
  fs.writeFileSync(path.join(dst, 'multi-b.snap.txt'),
    '====== FILE "multi/b.txt"\nB\n', 'utf8');
  run(['unsnap', 'multi-a.snap.txt', 'multi-b.snap.txt'], dst);
  assert.strictEqual(fs.readFileSync(path.join(dst, 'multi/a.txt'), 'utf8'), 'A',
    'multi unsnap boundary: file-a content');
  assert.strictEqual(fs.readFileSync(path.join(dst, 'multi/b.txt'), 'utf8'), 'B\n',
    'multi unsnap boundary: file-b content');

  // 8d) diff with multiple files produces combined diff
  fs.writeFileSync(path.join(dst, 'multi-d1.snap.txt'),
    '====== FILE "multi/one.txt"\nONE\n', 'utf8');
  fs.writeFileSync(path.join(dst, 'multi-d2.snap.txt'),
    '====== FILE "multi/two.txt"\nTWO\n', 'utf8');
  const multiDiff = run(['diff', 'multi-d1.snap.txt', 'multi-d2.snap.txt'], dst);
  assert.ok(multiDiff.includes('multi/one.txt'), 'multi diff: mentions one.txt');
  assert.ok(multiDiff.includes('multi/two.txt'), 'multi diff: mentions two.txt');
  assert.ok(multiDiff.includes('+ONE'), 'multi diff: includes one.txt change');
  assert.ok(multiDiff.includes('+TWO'), 'multi diff: includes two.txt change');

  // 9) strict mode must reject unrecognized "======" lines
  fs.writeFileSync(path.join(dst, 'strict.snap.txt'),
    '====== BOGUS "x"\nfoo\n', 'utf8');
  let strictThrew = false;
  try { run(['check', '--strict', 'strict.snap.txt'], dst); } catch (e) { strictThrew = true; }
  assert.ok(strictThrew, '--strict must reject unknown commands');

  // 10) Grouped spec: default "" group + named groups, and per-group snaps
  const gsrc = mkTmp('bidisnap-groups-src-');
  write(path.join(gsrc, 'app/main.js'), 'console.log(1);\n');
  write(path.join(gsrc, 'lib/util.js'), 'export const u = 1;\n');
  write(path.join(gsrc, 'docs/readme.md'), '# docs\n');
  write(path.join(gsrc, 'spec-groups.json'), JSON.stringify([
    { include: ['app/**'] },
    { group: 'lib', list: [ { include: ['lib/**'] } ] },
    { group: 'docs', list: [ { include: ['docs/**'] } ] },
  ], null, 2));

  // all groups -> default names
  run(['snap', 'spec-groups.json'], gsrc);
  assert.ok(fs.existsSync(path.join(gsrc, 'spec-groups.snap.txt')), 'default group snap');
  assert.ok(fs.existsSync(path.join(gsrc, 'spec-groups.snap-lib.txt')), 'lib group snap');
  assert.ok(fs.existsSync(path.join(gsrc, 'spec-groups.snap-docs.txt')), 'docs group snap');

  // default group snap contains app/main.js but not lib/util.js
  const defSnap = fs.readFileSync(path.join(gsrc, 'spec-groups.snap.txt'), 'utf8');
  assert.ok(defSnap.includes('app/main.js'), 'default group includes app/main.js');
  assert.ok(!defSnap.includes('lib/util.js'), 'default group excludes lib/util.js');

  // lib group snap contains lib/util.js only
  const libSnap = fs.readFileSync(path.join(gsrc, 'spec-groups.snap-lib.txt'), 'utf8');
  assert.ok(libSnap.includes('lib/util.js'), 'lib group includes lib/util.js');
  assert.ok(!libSnap.includes('app/main.js'), 'lib group excludes app/main.js');

  // select a single group + explicit output name
  run(['snap', 'spec-groups.json', 'docs', 'only-docs.snap.txt'], gsrc);
  assert.ok(fs.existsSync(path.join(gsrc, 'only-docs.snap.txt')), 'explicit single-group output');

  // explicit output name with multiple groups must fail
  let multiThrew = false;
  try { run(['snap', 'spec-groups.json', 'lib', 'docs', 'bad.snap.txt'], gsrc); }
  catch (e) { multiThrew = true; }
  assert.ok(multiThrew, 'explicit output with multiple groups must fail');

  // unknown group must fail
  let unkThrew = false;
  try { run(['snap', 'spec-groups.json', 'nope'], gsrc); }
  catch (e) { unkThrew = true; }
  assert.ok(unkThrew, 'unknown group must fail');

  console.log('roundtrip OK');
}

main();
