// tests/adversarial.ts -- adversarial checks for mend, written from SPEC.md alone (not from the practice
// set). Each case runs `node main.ts` once in a fresh temporary directory and compares the exit code, all
// of stdout, and every file afterwards. Run from the repo root: `node tests/adversarial.ts`.
//
// Coverage: CLI/usage (15), unified (36), SEARCH/REPLACE (16), V4A (25), JSON (18), format detection (3),
// atomicity/order (3) -- 116 cases, including the ten traps from the pre-open analysis and the three SPEC
// fixes (V4A body line after End of File, bounded SEARCH/REPLACE scan, stray End of File).

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../main.ts', import.meta.url));

interface Case {
  name: string;
  args?: string[];
  stdin?: string;
  patch?: string;
  files?: Record<string, string>;
  code: number;
  out: string[];
  after?: Record<string, string | null>;
}

const cases: Case[] = [];
const t = (name: string, c: Omit<Case, 'name'>): void => {
  cases.push({ name, ...c });
};

const F5 = 'one\ntwo\nthree\nfour\nfive\n';

function walk(dir: string, base: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, walk(p, base));
    else if (e.isFile()) out[relative(base, p).split(sep).join('/')] = readFileSync(p, 'utf8');
  }
  return out;
}

function runCase(c: Case): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'mend-adv-'));
  try {
    const initial: Record<string, string> = { ...(c.files ?? {}) };
    if (c.patch !== undefined && c.stdin === undefined) initial['patch.txt'] = c.patch;
    for (const [p, v] of Object.entries(initial)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), v);
    }
    const args = c.args ?? (c.stdin !== undefined ? [] : ['patch.txt']);
    const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: dir, input: c.stdin, encoding: 'utf8', timeout: 10000 });
    const problems: string[] = [];
    if (r.status !== c.code) problems.push(`exit ${r.status}, expected ${c.code}`);
    const wantOut = c.out.map((l) => `${l}\n`).join('');
    if (r.stdout !== wantOut) problems.push(`stdout ${JSON.stringify(r.stdout)}, expected ${JSON.stringify(wantOut)}`);
    const want: Record<string, string> = { ...initial };
    for (const [p, v] of Object.entries(c.after ?? {})) {
      if (v === null) delete want[p];
      else want[p] = v;
    }
    const got = walk(dir, dir);
    for (const p of new Set([...Object.keys(want), ...Object.keys(got)])) {
      if (want[p] === undefined) problems.push(`${p} should not exist`);
      else if (got[p] === undefined) problems.push(`${p} is missing`);
      else if (got[p] !== want[p]) problems.push(`${p} differs: expected ${JSON.stringify(want[p])}, got ${JSON.stringify(got[p])}`);
    }
    if (r.error) problems.push(`spawn error: ${String(r.error)}`);
    if (problems.length > 0 && r.stderr) problems.push(`stderr: ${r.stderr.slice(0, 500)}`);
    return problems;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// CLI / usage (section 1, 2)
t('cli-usage-unknown', { args: ['--bogus'], patch: 'x\n', code: 2, out: ['error: usage'] });
t('cli-usage-check-twice', { args: ['--check', '--check', 'patch.txt'], patch: 'x\n', code: 2, out: ['error: usage'] });
t('cli-usage-format-twice', { args: ['--format=json', '--format=v4a', 'patch.txt'], patch: 'x\n', code: 2, out: ['error: usage'] });
t('cli-usage-strict-twice', { args: ['--strict', '--strict', 'patch.txt'], patch: 'x\n', code: 2, out: ['error: usage'] });
t('cli-usage-bad-format', { args: ['--format=bogus', 'patch.txt'], patch: 'x\n', code: 2, out: ['error: usage'] });
t('cli-usage-two-positional', { args: ['patch.txt', 'other.txt'], patch: 'x\n', code: 2, out: ['error: usage'] });
t('cli-usage-format-noeq', { args: ['--format', 'patch.txt'], patch: 'x\n', code: 2, out: ['error: usage'] });
t('cli-dashdash', { args: ['--', '--check'], patch: 'x\n', code: 2, out: ['error: no-patch'] });
t('cli-no-patch', { args: ['missing.patch'], patch: 'x\n', code: 2, out: ['error: no-patch'] });
t('cli-format-none', { patch: 'just prose\nno markers here\n', code: 2, out: ['error: format'] });
t('cli-usage-beats-nopatch', { args: ['--bogus', 'missing.patch'], patch: 'x\n', code: 2, out: ['error: usage'] });
t('cli-empty-json-parse1', { args: ['--format=json'], stdin: '', code: 2, out: ['error: parse 1'] });
t('cli-empty-auto-format', { stdin: '', code: 2, out: ['error: format'] });
t('cli-stdin-create', {
  stdin: '{"command":"create","path":"a.txt","file_text":"hi\\n"}\n',
  args: [],
  code: 0,
  out: ['A a.txt', 'ok: 1 file'],
  after: { 'a.txt': 'hi\n' },
});
t('cli-check-no-write', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -2,1 +2,1 @@
 two
-three
+THREE
 four
`,
  args: ['--check', 'patch.txt'],
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
});

// Unified diffs (section 6)
t('u-basic', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -2,1 +2,1 @@
 two
-three
+THREE
 four
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\ntwo\nTHREE\nfour\nfive\n' },
});
t('u-wrong-line-numbers', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -99,1 +99,1 @@
 two
-three
+THREE
 four
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\ntwo\nTHREE\nfour\nfive\n' },
});
t('u-nearest-tie-earlier', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -4,2 +4,2 @@
-a
-b
+A
+B
`,
  files: { 'f.txt': 'q\na\nb\nq\nq\na\nb\nq\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'q\nA\nB\nq\nq\na\nb\nq\n' },
});
t('u-nearest-later', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -5,2 +5,2 @@
-a
-b
+A
+B
`,
  files: { 'f.txt': 'q\na\nb\nq\nq\na\nb\nq\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'q\na\nb\nq\nq\nA\nB\nq\n' },
});
t('u-empty-o-insert', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -3,0 +4,2 @@
+X
+Y
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\ntwo\nthree\nX\nY\nfour\nfive\n' },
});
t('u-empty-o-beyond-eof', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -99,0 +100,1 @@
+Z
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\ntwo\nthree\nfour\nfive\nZ\n' },
});
t('u-tier1', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`,
  files: { 'f.txt': 'one\ntwo  \nthree\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\nTWO\nthree\n' },
});
t('u-tier2-reindent-p-empty', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -2,2 +2,2 @@
-x = 1
-y = 2
+x = 10
+y = 20
`,
  files: { 'f.txt': 'def f():\n    x = 1\n    y = 2\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'def f():\n    x = 10\n    y = 20\n' },
});
t('u-tier2-reindent-p-nonempty', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
-  x = 1
-  y = 2
+  x = 10
+zzz
`,
  files: { 'f.txt': '    x = 1\n    y = 2\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': '    x = 10\nzzz\n' },
});
t('u-no-newline-at-end', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -2,1 +2,1 @@
 a
-b
+B
\\ No newline at end of file
`,
  files: { 'f.txt': 'a\nb' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'a\nB' },
});
t('u-backslash-after-minus', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,1 @@
 a
-b
\\ No newline at end of file
`,
  files: { 'f.txt': 'a\nb\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'a\n' },
});
t('u-backslash-mid-file', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -1,1 +1,1 @@
-a
+A
\\ No newline at end of file
`,
  files: { 'f.txt': 'a\nb\nc\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'A\nb\nc\n' },
});
t('u-create-dev-null', {
  patch: `--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`,
  code: 0,
  out: ['A new.txt', 'ok: 1 file'],
  after: { 'new.txt': 'hello\nworld\n' },
});
t('u-create-no-newline', {
  patch: `--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello
\\ No newline at end of file
`,
  code: 0,
  out: ['A new.txt', 'ok: 1 file'],
  after: { 'new.txt': 'hello' },
});

t('u-create-exists', {
  patch: `--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`,
  files: { 'new.txt': 'old\n' },
  code: 1,
  out: ['error: exists new.txt', 'failed: 1 of 1 edits'],
});
t('u-delete-dev-null', {
  patch: `--- a/f.txt
+++ /dev/null
@@ -1,5 +0,0 @@
-one
-two
-three
-four
-five
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['D f.txt', 'ok: 1 file'],
  after: { 'f.txt': null },
});
t('u-delete-malformed-hunk', {
  patch: `--- a/f.txt
+++ /dev/null
@@ bogus
`,
  files: { 'f.txt': F5 },
  code: 2,
  out: ['error: parse 3'],
});
t('u-move-rename-pair', {
  patch: `diff --git a/old.txt b/new.txt
rename from old.txt
rename to new.txt
--- a/old.txt
+++ b/new.txt
@@ -1,1 +1,1 @@
-x
+X
`,
  files: { 'old.txt': 'x\n' },
  code: 0,
  out: ['R old.txt -> new.txt', 'ok: 1 file'],
  after: { 'old.txt': null, 'new.txt': 'X\n' },
});
t('u-move-rename-only', {
  patch: `diff --git a/old.txt b/new.txt
rename from old.txt
rename to new.txt
`,
  files: { 'old.txt': 'x\n' },
  code: 0,
  out: ['R old.txt -> new.txt', 'ok: 1 file'],
  after: { 'old.txt': null, 'new.txt': 'x\n' },
});
t('u-move-exists', {
  patch: `diff --git a/old.txt b/new.txt
rename from old.txt
rename to new.txt
`,
  files: { 'old.txt': 'x\n', 'new.txt': 'y\n' },
  code: 1,
  out: ['error: exists new.txt', 'failed: 1 of 1 edits'],
});
t('u-change-missing', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -2,1 +2,1 @@
 two
-three
+THREE
 four
`,
  code: 1,
  out: ['error: missing f.txt', 'failed: 1 of 1 edits'],
});
t('u-no-match', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -1,1 +1,1 @@
-zzz
+ZZZ
`,
  files: { 'f.txt': F5 },
  code: 1,
  out: ['error: no-match f.txt', 'failed: 1 of 1 edits'],
});
t('u-multi-hunk-d', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -1,1 +1,2 @@
-a
+A1
+A2
@@ -5,1 +5,1 @@
-a
+A3
`,
  files: { 'f.txt': 'a\nb\na\nb\na\nb\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'A1\nA2\nb\na\nb\nA3\nb\n' },
});
t('u-multi-section', {
  patch: `--- a/b.txt
+++ b/b.txt
@@ -1,1 +1,1 @@
-y
+Y
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-x
+X
`,
  files: { 'a.txt': 'x\n', 'b.txt': 'y\n' },
  code: 0,
  out: ['M a.txt', 'M b.txt', 'ok: 2 files'],
  after: { 'a.txt': 'X\n', 'b.txt': 'Y\n' },
});
t('u-prose-fences', {
  patch: `Here is the fix:

\`\`\`diff
--- a/f.txt
+++ b/f.txt
@@ -2,1 +2,1 @@
 two
-three
+THREE
 four
\`\`\`

Done.
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\ntwo\nTHREE\nfour\nfive\n' },
});
t('u-lone-dash-header', {
  patch: `diff --git a/f.txt b/f.txt
--- a/f.txt
not a plus line
`,
  code: 2,
  out: ['error: parse 3'],
});

t('u-malformed-diff-git', { patch: 'diff --git a/f.txt\n', code: 2, out: ['error: parse 1'] });
t('u-malformed-hunk-header', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ bogus @@
`,
  code: 2,
  out: ['error: parse 3'],
});
t('u-hunk-before-section', { args: ['--format=unified', 'patch.txt'], patch: '@@ -1 +1 @@\n', code: 2, out: ['error: parse 1'] });
t('u-trailing-empty-body', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
 a
-b
+B

`,
  files: { 'f.txt': 'a\nb\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'a\nB\n' },
});
t('u-mixed-breaks', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -1,1 +1,1 @@
-a
+A
`,
  files: { 'f.txt': 'a\r\nb\nc\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'A\r\nb\nc\n' },
});
t('u-strict-tier1-fails', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`,
  args: ['--strict', 'patch.txt'],
  files: { 'f.txt': 'one\ntwo  \nthree\n' },
  code: 1,
  out: ['error: no-match f.txt', 'failed: 1 of 1 edits'],
});
t('u-unsafe-path', {
  patch: `--- a/../x.txt
+++ b/../x.txt
@@ -1,1 +1,1 @@
-a
+b
`,
  code: 1,
  out: ['error: unsafe ../x.txt', 'failed: 1 of 1 edits'],
});
t('u-r-sorts-by-new', {
  patch: `diff --git a/z.txt b/a.txt
rename from z.txt
rename to a.txt
--- a/z.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-z
+Z
--- a/m.txt
+++ b/m.txt
@@ -1,1 +1,1 @@
-m
+M
`,
  files: { 'z.txt': 'z\n', 'm.txt': 'm\n' },
  code: 0,
  out: ['R z.txt -> a.txt', 'M m.txt', 'ok: 2 files'],
  after: { 'z.txt': null, 'a.txt': 'Z\n', 'm.txt': 'M\n' },
});
t('u-diff-git-paths', {
  patch: `diff --git a/f.txt b/f.txt
@@ -1,1 +1,1 @@
-one
+ONE
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'ONE\ntwo\nthree\nfour\nfive\n' },
});
t('u-new-file-mode', {
  patch: `diff --git a/n.txt b/n.txt
new file mode 100644
@@ -0,0 +1,1 @@
+hi
`,
  code: 0,
  out: ['A n.txt', 'ok: 1 file'],
  after: { 'n.txt': 'hi\n' },
});

// SEARCH/REPLACE blocks (section 7)
t('s-basic', {
  patch: `f.txt
<<<<<<< SEARCH
two
three
=======
TWO
THREE
>>>>>>> REPLACE
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\nTWO\nTHREE\nfour\nfive\n' },
});
t('s-create-empty-old', {
  patch: `new.txt
<<<<<<< SEARCH
=======
hello
world
>>>>>>> REPLACE
`,
  code: 0,
  out: ['A new.txt', 'ok: 1 file'],
  after: { 'new.txt': 'hello\nworld\n' },
});
t('s-create-exists', {
  patch: `new.txt
<<<<<<< SEARCH
=======
hello
world
>>>>>>> REPLACE
`,
  files: { 'new.txt': 'x\n' },
  code: 1,
  out: ['error: exists new.txt', 'failed: 1 of 1 edits'],
});
t('s-ambiguous', {
  patch: `f.txt
<<<<<<< SEARCH
a
b
=======
A
B
>>>>>>> REPLACE
`,
  files: { 'f.txt': 'a\nb\na\nb\n' },
  code: 1,
  out: ['error: ambiguous f.txt', 'failed: 1 of 1 edits'],
});
t('s-no-match', {
  patch: `f.txt
<<<<<<< SEARCH
zzz
=======
ZZZ
>>>>>>> REPLACE
`,
  files: { 'f.txt': F5 },
  code: 1,
  out: ['error: no-match f.txt', 'failed: 1 of 1 edits'],
});
t('s-tier1', {
  patch: `f.txt
<<<<<<< SEARCH
two
=======
TWO
>>>>>>> REPLACE
`,
  files: { 'f.txt': 'one\ntwo  \nthree\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\nTWO\nthree\n' },
});

t('s-tier2-reindent', {
  patch: `f.txt
<<<<<<< SEARCH
x = 1
y = 2
=======
x = 10
y = 20
>>>>>>> REPLACE
`,
  files: { 'f.txt': 'def f():\n    x = 1\n    y = 2\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'def f():\n    x = 10\n    y = 20\n' },
});
t('s-path-fence-skipped', {
  patch: `f.txt
\`\`\`diff
<<<<<<< SEARCH
two
=======
TWO
>>>>>>> REPLACE
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\nTWO\nthree\nfour\nfive\n' },
});
t('s-path-fallback', {
  patch: `f.txt
<<<<<<< SEARCH
one
=======
ONE
>>>>>>> REPLACE

<<<<<<< SEARCH
two
=======
TWO
>>>>>>> REPLACE
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'ONE\nTWO\nthree\nfour\nfive\n' },
});
t('s-first-block-no-path', {
  patch: `<<<<<<< SEARCH
two
=======
TWO
>>>>>>> REPLACE
`,
  code: 2,
  out: ['error: parse 1'],
});
t('s-search-no-separator', {
  patch: `f.txt
<<<<<<< SEARCH
two
>>>>>>> REPLACE
`,
  files: { 'f.txt': F5 },
  code: 2,
  out: ['error: parse 2'],
});
t('s-search-no-replace', {
  patch: `f.txt
<<<<<<< SEARCH
two
=======
TWO
`,
  files: { 'f.txt': F5 },
  code: 2,
  out: ['error: parse 2'],
});
t('s-missing-separator-bounded', {
  patch: `f.txt
<<<<<<< SEARCH
one
>>>>>>> REPLACE
<<<<<<< SEARCH
two
=======
TWO
>>>>>>> REPLACE
`,
  files: { 'f.txt': F5 },
  code: 2,
  out: ['error: parse 2'],
});
t('s-missing-replace-bounded', {
  patch: `f.txt
<<<<<<< SEARCH
one
=======
ONE
<<<<<<< SEARCH
two
=======
TWO
>>>>>>> REPLACE
`,
  files: { 'f.txt': F5 },
  code: 2,
  out: ['error: parse 2'],
});
t('s-markers-trailing-ws', {
  patch: `f.txt
<<<<<<< SEARCH   
two
=======   
TWO
>>>>>>> REPLACE   
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\nTWO\nthree\nfour\nfive\n' },
});
t('s-separator-in-new-lines', {
  patch: `f.txt
<<<<<<< SEARCH
two
=======
=======
TWO
>>>>>>> REPLACE
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\n=======\nTWO\nthree\nfour\nfive\n' },
});

// V4A patches (section 8)
t('v-basic-anchor', {
  patch: `*** Begin Patch
*** Update File: f.txt
@@ one
 two
-three
+THREE
*** End Patch
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\ntwo\nTHREE\nfour\nfive\n' },
});
t('v-first-chunk-no-at', {
  patch: `*** Begin Patch
*** Update File: f.txt
 two
-three
+THREE
*** End Patch
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\ntwo\nTHREE\nfour\nfive\n' },
});
t('v-add-file', {
  patch: `*** Begin Patch
*** Add File: n.txt
+hello
+
+world
*** End Patch
`,
  code: 0,
  out: ['A n.txt', 'ok: 1 file'],
  after: { 'n.txt': 'hello\n\nworld\n' },
});
t('v-delete-file', {
  patch: `*** Begin Patch
*** Delete File: f.txt
*** End Patch
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['D f.txt', 'ok: 1 file'],
  after: { 'f.txt': null },
});
t('v-move-to', {
  patch: `*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
@@ a
-x
+X
*** End Patch
`,
  files: { 'old.txt': 'a\nx\n' },
  code: 0,
  out: ['R old.txt -> new.txt', 'ok: 1 file'],
  after: { 'old.txt': null, 'new.txt': 'a\nX\n' },
});
t('v-move-to-only', {
  patch: `*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
*** End Patch
`,
  files: { 'old.txt': 'x\n' },
  code: 0,
  out: ['R old.txt -> new.txt', 'ok: 1 file'],
  after: { 'old.txt': null, 'new.txt': 'x\n' },
});

t('v-anchor-tier2', {
  patch: `*** Begin Patch
*** Update File: f.txt
@@ indented
-x
+X
*** End Patch
`,
  files: { 'f.txt': '    indented\nx\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': '    indented\nX\n' },
});
t('v-anchor-not-found', {
  patch: `*** Begin Patch
*** Update File: f.txt
@@ zzz
-two
+TWO
*** End Patch
`,
  files: { 'f.txt': F5 },
  code: 1,
  out: ['error: no-match f.txt', 'failed: 1 of 1 edits'],
});
t('v-cursor-second-chunk', {
  patch: `*** Begin Patch
*** Update File: f.txt
@@ a
-b
+B
@@
-a
+A
*** End Patch
`,
  files: { 'f.txt': 'a\nb\na\nb\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'a\nB\nA\nb\n' },
});
t('v-anchor-then-o', {
  patch: `*** Begin Patch
*** Update File: f.txt
@@ x
-x
-y
+X
+Y
*** End Patch
`,
  files: { 'f.txt': 'x\ny\nx\ny\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'x\ny\nX\nY\n' },
});
t('v-eof-chunk', {
  patch: `*** Begin Patch
*** Update File: f.txt
@@ four
-five
+FIVE
*** End of File
*** End Patch
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\ntwo\nthree\nfour\nFIVE\n' },
});
t('v-eof-not-at-end', {
  patch: `*** Begin Patch
*** Update File: f.txt
@@ one
-two
+TWO
*** End of File
*** End Patch
`,
  files: { 'f.txt': F5 },
  code: 1,
  out: ['error: no-match f.txt', 'failed: 1 of 1 edits'],
});
t('v-empty-o-insert-cursor', {
  patch: `*** Begin Patch
*** Update File: f.txt
@@ two
+NEW
*** End Patch
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\ntwo\nNEW\nthree\nfour\nfive\n' },
});
t('v-empty-o-eof-insert', {
  patch: `*** Begin Patch
*** Update File: f.txt
@@ two
+NEW
*** End of File
*** End Patch
`,
  files: { 'f.txt': F5 },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'one\ntwo\nthree\nfour\nfive\nNEW\n' },
});
t('v-first-nonblank-not-begin', {
  args: ['--format=v4a', 'patch.txt'],
  patch: 'hello\n*** Begin Patch\n*** End Patch\n',
  code: 2,
  out: ['error: parse 1'],
});
t('v-no-nonblank', { args: ['--format=v4a', 'patch.txt'], patch: '\n\n  \n', code: 2, out: ['error: parse 1'] });
t('v-last-nonblank-not-end', {
  args: ['--format=v4a', 'patch.txt'],
  patch: `*** Begin Patch
*** Update File: f.txt
-x
+X
`,
  code: 2,
  out: ['error: parse 5'],
});
t('v-update-no-chunk-no-move', {
  patch: `*** Begin Patch
*** Update File: f.txt
*** End Patch
`,
  code: 2,
  out: ['error: parse 2'],
});
t('v-stray-eof', {
  patch: `*** Begin Patch
*** Update File: f.txt
*** End of File
*** End Patch
`,
  code: 2,
  out: ['error: parse 3'],
});

t('v-body-after-eof', {
  patch: `*** Begin Patch
*** Update File: f.txt
@@ one
-two
+TWO
*** End of File
+STRAY
*** End Patch
`,
  code: 2,
  out: ['error: parse 7'],
});
t('v-trailing-blanks-add', {
  patch: `*** Begin Patch
*** Add File: n.txt
+hello


*** End Patch
`,
  code: 0,
  out: ['A n.txt', 'ok: 1 file'],
  after: { 'n.txt': 'hello\n' },
});
t('v-add-exists', {
  patch: `*** Begin Patch
*** Add File: n.txt
+hello
+
+world
*** End Patch
`,
  files: { 'n.txt': 'x\n' },
  code: 1,
  out: ['error: exists n.txt', 'failed: 1 of 1 edits'],
});
t('v-update-missing', {
  patch: `*** Begin Patch
*** Update File: f.txt
@@ one
 two
-three
+THREE
*** End Patch
`,
  code: 1,
  out: ['error: missing f.txt', 'failed: 1 of 1 edits'],
});
t('v-bad-line-in-add', {
  patch: `*** Begin Patch
*** Add File: n.txt
-x
*** End Patch
`,
  code: 2,
  out: ['error: parse 3'],
});
t('v-move-to-not-first', {
  patch: `*** Begin Patch
*** Update File: f.txt
@@ one
-two
+TWO
*** Move to: g.txt
*** End Patch
`,
  code: 2,
  out: ['error: parse 6'],
});

// JSON edits (section 9)
t('j-array-create', {
  patch: '[{"command":"create","path":"n.txt","file_text":"hi"}]\n',
  code: 0,
  out: ['A n.txt', 'ok: 1 file'],
  after: { 'n.txt': 'hi' },
});
t('j-array-str-replace', {
  patch: '[{"command":"str_replace","path":"f.txt","old_str":"world","new_str":"there"}]\n',
  files: { 'f.txt': 'hello world\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'hello there\n' },
});
t('j-array-insert', {
  patch: '[{"command":"insert","path":"f.txt","insert_line":1,"new_str":"X\\nY"}]\n',
  files: { 'f.txt': 'a\nb\nc\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'a\nX\nY\nb\nc\n' },
});
t('j-json-lines', {
  patch: `{"command":"create","path":"a.txt","file_text":"x"}
{"command":"create","path":"b.txt","file_text":"y"}
`,
  code: 0,
  out: ['A a.txt', 'A b.txt', 'ok: 2 files'],
  after: { 'a.txt': 'x', 'b.txt': 'y' },
});
t('j-array-fault-at-start', {
  patch: `[
{"command":"create","path":"a.txt","file_text":"x"},
{"command":"bogus","path":"b.txt"}
]
`,
  code: 2,
  out: ['error: parse 1'],
});
t('j-jsonl-fault-at-line', {
  patch: `{"command":"create","path":"a.txt","file_text":"x"}
{"command":"bogus","path":"b.txt"}
`,
  code: 2,
  out: ['error: parse 2'],
});
t('j-overlap-ambiguous', {
  patch: '[{"command":"str_replace","path":"f.txt","old_str":"aa","new_str":"b"}]\n',
  files: { 'f.txt': 'aaa\n' },
  code: 1,
  out: ['error: ambiguous f.txt', 'failed: 1 of 1 edits'],
});
t('j-crlf-str-replace', {
  patch: '[{"command":"str_replace","path":"f.txt","old_str":"foo\\nbar","new_str":"FOO\\nBAR"}]\n',
  files: { 'f.txt': 'foo\r\nbar\r\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'FOO\r\nBAR\r\n' },
});
t('j-str-replace-ambiguous', {
  patch: '[{"command":"str_replace","path":"f.txt","old_str":"x","new_str":"z"}]\n',
  files: { 'f.txt': 'x\ny\nx\n' },
  code: 1,
  out: ['error: ambiguous f.txt', 'failed: 1 of 1 edits'],
});
t('j-insert-out-of-range', {
  patch: '[{"command":"insert","path":"f.txt","insert_line":99,"new_str":"Z"}]\n',
  files: { 'f.txt': 'a\nb\nc\n' },
  code: 1,
  out: ['error: no-match f.txt', 'failed: 1 of 1 edits'],
});

t('j-insert-at-0', {
  patch: '[{"command":"insert","path":"f.txt","insert_line":0,"new_str":"Z"}]\n',
  files: { 'f.txt': 'a\nb\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'Z\na\nb\n' },
});
t('j-insert-at-end', {
  patch: '[{"command":"insert","path":"f.txt","insert_line":2,"new_str":"Z"}]\n',
  files: { 'f.txt': 'a\nb\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'a\nb\nZ\n' },
});
t('j-insert-keeps-no-final', {
  patch: '[{"command":"insert","path":"f.txt","insert_line":1,"new_str":"X"}]\n',
  files: { 'f.txt': 'a\nb' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'a\nX\nb' },
});
t('j-create-byte-for-byte-crlf', {
  patch: '[{"command":"create","path":"n.txt","file_text":"a\\r\\nb"}]\n',
  code: 0,
  out: ['A n.txt', 'ok: 1 file'],
  after: { 'n.txt': 'a\r\nb' },
});
t('j-wrong-command', { patch: '{"command":"explode","path":"f.txt"}\n', code: 2, out: ['error: parse 1'] });
t('j-missing-key', { patch: '{"command":"create","path":"x.txt"}\n', code: 2, out: ['error: parse 1'] });
t('j-extra-keys-ignored', {
  patch: '{"command":"create","path":"n.txt","file_text":"x","extra":123}\n',
  code: 0,
  out: ['A n.txt', 'ok: 1 file'],
  after: { 'n.txt': 'x' },
});
t('j-new-str-absent', {
  patch: '[{"command":"str_replace","path":"f.txt","old_str":"x"}]\n',
  files: { 'f.txt': 'ax\n' },
  code: 0,
  out: ['M f.txt', 'ok: 1 file'],
  after: { 'f.txt': 'a\n' },
});

// Format detection precedence (section 4)
t('d-unified-first-line-brace', {
  patch: `{
--- a/f.txt
+++ b/f.txt
@@ -1,1 +1,1 @@
-one
+ONE
`,
  code: 2,
  out: ['error: parse 1'],
});
t('d-search-in-v4a', {
  patch: `*** Begin Patch
<<<<<<< SEARCH
*** End Patch
`,
  code: 2,
  out: ['error: parse 2'],
});
t('d-explicit-format-overrides', {
  args: ['--format=json', 'patch.txt'],
  patch: `--- a/f.txt
+++ b/f.txt
@@ -2,1 +2,1 @@
 two
-three
+THREE
 four
`,
  code: 2,
  out: ['error: parse 1'],
});

// Order and atomicity (section 10)
t('a-exit1-all-failures', {
  patch: `--- a/f.txt
+++ b/f.txt
@@ -1,1 +1,1 @@
-zzz
+ZZZ
--- a/g.txt
+++ b/g.txt
@@ -1,1 +1,1 @@
-yyy
+YYY
`,
  files: { 'f.txt': F5 },
  code: 1,
  out: ['error: no-match f.txt', 'error: missing g.txt', 'failed: 2 of 2 edits'],
});
t('a-later-sees-earlier', {
  patch: '[{"command":"create","path":"a.txt","file_text":"hello"}, {"command":"str_replace","path":"a.txt","old_str":"hello","new_str":"bye"}]\n',
  code: 0,
  out: ['A a.txt', 'ok: 1 file'],
  after: { 'a.txt': 'bye' },
});
t('a-create-then-delete', {
  patch: `--- /dev/null
+++ b/n.txt
@@ -0,0 +1,1 @@
+hi
--- a/n.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-hi
`,
  code: 0,
  out: ['ok: 0 files'],
});

let passed = 0;
for (const c of cases) {
  const problems = runCase(c);
  if (problems.length === 0) passed += 1;
  else process.stdout.write(`FAIL ${c.name}\n  ${problems.join('\n  ')}\n`);
}
process.stdout.write(`${passed} of ${cases.length} passed\n`);
process.exitCode = passed === cases.length ? 0 : 1;
