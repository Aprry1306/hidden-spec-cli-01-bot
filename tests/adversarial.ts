// Adversarial tests for mend, written by hand from SPEC.md (not from the practice set).
// Each case's expectation was computed from the SPEC sentence it tests.
// Run: node tests/adversarial.ts  (from the repo root)

import { runCheck } from '../runner.ts';

interface Case {
  name: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
  exit: number;
  stdout: string;
  changes: Record<string, string | null>;
}

const T = (name: string, argv: string[], stdin: string | null, files: Record<string, string>, exit: number, stdout: string, changes: Record<string, string | null>): Case => ({
  name,
  argv,
  stdin,
  files,
  exit,
  stdout,
  changes,
});

const cases: Case[] = [
  // --- trap 1: tier-2 re-indent with EMPTY P (§5): O flush-left, file indented -> N gains F ---
  T(
    'u2-reindent-empty-p',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n-x = 1\n-y = 2\n+ret = x + y\n+print(ret)\n',
    { 'f.txt': 'def a():\n    x = 1\n    y = 2\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'def a():\n    ret = x + y\n    print(ret)\n' },
  ),
  // --- trap 2: `\` after a `-` line NEVER changes the final break (§6) ---
  T(
    'u2-backslash-after-minus',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -2,2 +2,2 @@\n b\n-c\n\\ No newline at end of file\n+d\n',
    { 'f.txt': 'a\nb\nc\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'a\nb\nd\n' },
  ),
  // --- hunk touching EOF without `\` ADDS a final break (§6) ---
  T(
    'u2b-eof-adds-break',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -3,1 +3,1 @@\n-c\n+d\n',
    { 'f.txt': 'a\nb\nc' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'a\nb\nd\n' },
  ),
  // --- trap 3: mixed breaks; break = first LF only, whole file rewritten with it (§3) ---
  T(
    'u3-mixed-breaks',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-one\n+1\n',
    { 'f.txt': 'one\r\ntwo\nthree\r\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': '1\r\ntwo\nthree\r\n' },
  ),
  // --- trap 4: JSON array-form parse error reports the ARRAY's start line (§9) ---
  T(
    'j1-array-parse-line',
    ['patch.json'],
    null,
    {
      'patch.json':
        '[\n{"command": "create", "path": "a.txt", "file_text": "x\\n"},\n{"command": "create", "path": "b.txt", "file_text": "y\\n"},\n{"command": "create"},\n]\n',
    },
    2,
    'error: parse 1\n',
    {},
  ),
  // --- trap 5: str_replace counts OVERLAPPING occurrences (§9): "aa" in "aaa" = 2 -> ambiguous ---
  T(
    'j2-overlap-ambiguous',
    ['-'],
    '{"command": "str_replace", "path": "f.txt", "old_str": "aa", "new_str": "b"}\n',
    { 'f.txt': 'aaa\n' },
    1,
    'error: ambiguous f.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- trap 7: V4A chunk with anchor AND End of File (§8) ---
  T(
    'v1-anchor-eof',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n@@ middle\n common\n+inserted\n*** End of File\n*** End Patch\n',
    { 'f.txt': 'start\ncommon\nmiddle\ncommon\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'start\ncommon\nmiddle\ncommon\ninserted\n' },
  ),
  // --- trap 8: malformed hunk header in a DELETION section is still a parse error (§6) ---
  T(
    'u4-deletion-malformed',
    ['-'],
    '--- a/f.txt\n+++ /dev/null\n@@ bad header\n-x\n',
    { 'f.txt': 'x\n' },
    2,
    'error: parse 3\n',
    {},
  ),
  // --- trap 9a: format precedence: first non-blank line starts with `{` -> json, not unified (§4) ---
  T(
    'c1-precedence-json',
    ['-'],
    '{\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    { 'f.txt': 'a\n' },
    2,
    'error: parse 1\n',
    {},
  ),
  // --- trap 9b: `*** Begin Patch` first line -> v4a even with SEARCH markers inside (§4) ---
  T(
    'c2-precedence-v4a',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n*** End Patch\n',
    { 'f.txt': 'x\n' },
    2,
    'error: parse 3\n',
    {},
  ),
  // --- trap 10: the same option twice is a usage error (§1) ---
  T('c3-usage-double-check', ['--check', '--check', '-'], '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n', { 'f.txt': 'a\n' }, 2, 'error: usage\n', {}),
  T('c4-usage-double-format', ['--format=json', '--format=v4a', '-'], '{}\n', {}, 2, 'error: usage\n', {}),
  T('c5-usage-double-strict', ['--strict', '--strict', '-'], '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n', { 'f.txt': 'a\n' }, 2, 'error: usage\n', {}),
  // --- `--` ends options: `--check` after it is a positional PATCH path (§1) ---
  T('c6-dashdash', ['--', '--check'], null, {}, 2, 'error: no-patch\n', {}),
  // --- unified: wrong line numbers, nearest occurrence wins (§6) ---
  T(
    'u5-wrong-numbers',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -100,1 +100,1 @@\n-target\n+TARGET\n',
    { 'f.txt': 'x\ntarget\ny\nx\ntarget\ny\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'x\ntarget\ny\nx\nTARGET\ny\n' },
  ),
  // --- unified: nearest tie -> the earlier occurrence (§6) ---
  T(
    'u6-nearest-tie',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-target\n+T\n',
    { 'f.txt': 'target\na\ntarget\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'T\na\ntarget\n' },
  ),
  // --- SEARCH/REPLACE: old occurs twice -> ambiguous (§7) ---
  T(
    's1-search-ambiguous',
    ['-'],
    'f.txt\n<<<<<<< SEARCH\ndup\n=======\nDUP\n>>>>>>> REPLACE\n',
    { 'f.txt': 'dup\ndup\n' },
    1,
    'error: ambiguous f.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- unified: a hunk before any section is a parse error (§6) ---
  T(
    'u7-hunk-before-section',
    ['-'],
    '@@ -1,1 +1,1 @@\n-a\n+b\ndiff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    { 'f.txt': 'a\n' },
    2,
    'error: parse 1\n',
    {},
  ),
  // --- unified on a CRLF file: break preserved (§3, §6) ---
  T(
    'u8-crlf',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n a\n-b\n+B\n c\n',
    { 'f.txt': 'a\r\nb\r\nc\r\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'a\r\nB\r\nc\r\n' },
  ),
  // --- hunk not touching EOF: a missing final break stays missing (§3, §6) ---
  T(
    'u9-noeol-middle',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n b\n',
    { 'f.txt': 'a\nb\nc' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'A\nb\nc' },
  ),
  // --- empty O inserted at end, `\` after last `+` -> no final break (§6) ---
  T(
    'u10-empty-o-end-backslash',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -2,0 +3,1 @@\n+c\n\\ No newline at end of file\n',
    { 'f.txt': 'a\nb\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'a\nb\nc' },
  ),
  // --- empty O inserted in the middle (§6) ---
  T(
    'u11-empty-o-middle',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,0 +2,1 @@\n+X\n',
    { 'f.txt': 'a\nb\nc\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'a\nX\nb\nc\n' },
  ),
  // --- move named by rename from/to only, no ---/+++ pair (§6) ---
  T(
    'u12-rename-only',
    ['-'],
    'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n',
    { 'old.txt': 'hello\n' },
    0,
    'R old.txt -> new.txt\nok: 1 file\n',
    { 'old.txt': null, 'new.txt': 'hello\n' },
  ),
  // --- --check: same output and exit code, nothing written (§1) ---
  T(
    'c7-check-mode',
    ['--check', '-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
    { 'f.txt': 'a\n' },
    0,
    'M f.txt\nok: 1 file\n',
    {},
  ),
  // --- usage errors (§1) ---
  T('c8-usage-unknown', ['--foo', '-'], '', {}, 2, 'error: usage\n', {}),
  T('c9-usage-two-pos', ['a.patch', 'b.patch'], null, {}, 2, 'error: usage\n', {}),
  T('c10-usage-bad-format', ['--format=xml', '-'], '', {}, 2, 'error: usage\n', {}),
  // --- JSON Lines: a fault reports ITS line (§9) ---
  T(
    'j3-jsonlines-fault',
    ['-'],
    '{"command": "create", "path": "a.txt", "file_text": "hi\\n"}\n{"command": "create", "path": "b.txt", "file_text": "yo\\n"}\n{"command": "bogus", "path": "c.txt"}\n',
    {},
    2,
    'error: parse 3\n',
    {},
  ),
  // --- tier-2 re-indent with non-empty P (§5) ---
  T(
    'u13-tier2-reindent',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -2,2 +2,2 @@\n-  y = 1\n-  z = 2\n+  y = 9\n+  z = 8\n',
    { 'f.txt': 'if x:\n        y = 1\n        z = 2\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'if x:\n        y = 9\n        z = 8\n' },
  ),
  // --- V4A anchor matched at tier 1 (file line has trailing space) (§8, §5) ---
  T(
    'v2-anchor-tier1',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n@@ def foo():\n-    return 1\n+    return 2\n*** End Patch\n',
    { 'f.txt': 'def foo():  \n    return 1\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'def foo():  \n    return 2\n' },
  ),
  // --- V4A end-of-file chunk takes ONLY the occurrence ending at the last line (§8) ---
  T(
    'v3-eof-only',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n-dup\n+DUP\n*** End of File\n*** End Patch\n',
    { 'f.txt': 'dup\nmid\ndup\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'dup\nmid\nDUP\n' },
  ),
  // --- V4A cursor: the second chunk searches after the first chunk's write (§8) ---
  T(
    'v4-cursor',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n@@ a\n-b\n+B1\n@@ a\n-b\n+B2\n*** End Patch\n',
    { 'f.txt': 'a\nb\na\nb\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'a\nB1\na\nB2\n' },
  ),
  // --- SEARCH/REPLACE with empty old creates the file (§7) ---
  T(
    's2-search-create',
    ['-'],
    'new.txt\n<<<<<<< SEARCH\n=======\nhello\nworld\n>>>>>>> REPLACE\n',
    {},
    0,
    'A new.txt\nok: 1 file\n',
    { 'new.txt': 'hello\nworld\n' },
  ),
  // --- SEARCH/REPLACE create of an existing file -> exists (§7) ---
  T(
    's3-search-create-exists',
    ['-'],
    'new.txt\n<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\n',
    { 'new.txt': 'old\n' },
    1,
    'error: exists new.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- SEARCH/REPLACE: a block with no path line takes the previous block's path (§7) ---
  T(
    's4-path-inherit',
    ['-'],
    'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
    { 'f.txt': 'a\nb\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'A\nB\n' },
  ),
  // --- unified creation: `\` after the last `+` line -> no final break (§6) ---
  T(
    'u14-create-noeol',
    ['-'],
    'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+line1\n+line2\n\\ No newline at end of file\n',
    {},
    0,
    'A n.txt\nok: 1 file\n',
    { 'n.txt': 'line1\nline2' },
  ),
  // --- deletion: hunks are not read (§6) ---
  T(
    'u15-deletion-hunks-ignored',
    ['-'],
    '--- a/f.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-nonexistent\n',
    { 'f.txt': 'zzz\n' },
    0,
    'D f.txt\nok: 1 file\n',
    { 'f.txt': null },
  ),
  // --- deletion of a missing file -> missing (§6) ---
  T(
    'u16-deletion-missing',
    ['-'],
    '--- a/ghost.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n',
    {},
    1,
    'error: missing ghost.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- JSON insert at 0, at n, beyond n (§9) ---
  T(
    'j4a-insert-0',
    ['-'],
    '{"command": "insert", "path": "f.txt", "insert_line": 0, "new_str": "top"}\n',
    { 'f.txt': 'a\nb\nc\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'top\na\nb\nc\n' },
  ),
  T(
    'j4b-insert-n',
    ['-'],
    '{"command": "insert", "path": "f.txt", "insert_line": 3, "new_str": "end"}\n',
    { 'f.txt': 'a\nb\nc\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'a\nb\nc\nend\n' },
  ),
  T(
    'j4c-insert-beyond',
    ['-'],
    '{"command": "insert", "path": "f.txt", "insert_line": 4, "new_str": "end"}\n',
    { 'f.txt': 'a\nb\nc\n' },
    1,
    'error: no-match f.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- JSON str_replace in a CRLF file: both sides normalised, result back in CRLF (§9) ---
  T(
    'j5-str-replace-crlf',
    ['-'],
    '{"command": "str_replace", "path": "f.txt", "old_str": "a\\nb", "new_str": "p\\r\\nq"}\n',
    { 'f.txt': 'a\r\nb\r\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'p\r\nq\r\n' },
  ),
  // --- exit 1: every edit still runs, every failure reported, nothing written (§10) ---
  T(
    'c11-exit1-multi',
    ['-'],
    '{"command": "create", "path": "a.txt", "file_text": "x\\n"}\n{"command": "str_replace", "path": "ghost.txt", "old_str": "a", "new_str": "b"}\n{"command": "create", "path": "b.txt", "file_text": "y\\n"}\n',
    {},
    1,
    'error: missing ghost.txt\nfailed: 1 of 3 edits\n',
    {},
  ),
  // --- R lines sort by <new> (§2) ---
  T(
    'u17-r-sort',
    ['-'],
    'diff --git a/zz.txt b/aa.txt\nrename from zz.txt\nrename to aa.txt\ndiff --git a/mm.txt b/bb.txt\nrename from mm.txt\nrename to bb.txt\n',
    { 'zz.txt': 'z\n', 'mm.txt': 'm\n' },
    0,
    'R zz.txt -> aa.txt\nR mm.txt -> bb.txt\nok: 2 files\n',
    { 'zz.txt': null, 'aa.txt': 'z\n', 'mm.txt': null, 'bb.txt': 'm\n' },
  ),
  // --- --strict: a tier-1-only V4A match fails (§5, §1) ---
  T(
    'v5-strict-v4a',
    ['--strict', '-'],
    '*** Begin Patch\n*** Update File: f.txt\n-x = 1 \n+x = 2\n*** End Patch\n',
    { 'f.txt': 'x = 1\n' },
    1,
    'error: no-match f.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- V4A Add: interior empty lines are file lines, trailing blanks are not (§8) ---
  T(
    'v6-add-blanks',
    ['-'],
    '*** Begin Patch\n*** Add File: n.txt\n+line1\n+\n+line3\n\n*** End Patch\n',
    {},
    0,
    'A n.txt\nok: 1 file\n',
    { 'n.txt': 'line1\n\nline3\n' },
  ),
  // --- V4A Update with Move to and no chunks: a pure move (§8) ---
  T(
    'v7-move-only',
    ['-'],
    '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch\n',
    { 'old.txt': 'same\n' },
    0,
    'R old.txt -> new.txt\nok: 1 file\n',
    { 'old.txt': null, 'new.txt': 'same\n' },
  ),
  // --- V4A Update with no chunk and no Move to: parse error at its Update line (§8) ---
  T(
    'v8-update-nochunk',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n*** End Patch\n',
    { 'f.txt': 'x\n' },
    2,
    'error: parse 2\n',
    {},
  ),
  // --- unified section with no hunks changes nothing (§6) ---
  T(
    'u18-no-hunks',
    ['-'],
    'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n',
    { 'f.txt': 'x\n' },
    0,
    'ok: 0 files\n',
    {},
  ),
  // --- empty patch: no format detected (§4) ---
  T('c12-empty-patch', ['-'], '', {}, 2, 'error: format\n', {}),
  // --- V4A with Begin/End Patch but no edit at all -> parse 1 (§2) ---
  T('c13-v4a-no-edits', ['--format=v4a', '-'], '*** Begin Patch\n*** End Patch\n', {}, 2, 'error: parse 1\n', {}),
  // --- tier-1 context lines are written as the file's own lines (§5) ---
  T(
    'u19-context-file-own',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n func x() {  \n-    return 1\n+    return 2\n }\n',
    { 'f.txt': 'func x() {\n    return 1\n}\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'func x() {\n    return 2\n}\n' },
  ),
  // --- SEARCH/REPLACE at tier 2 re-indents the new lines (§5, §7) ---
  T(
    's5-search-tier2',
    ['-'],
    'f.txt\n<<<<<<< SEARCH\nalpha\nbeta\n=======\ngamma\ndelta\n>>>>>>> REPLACE\n',
    { 'f.txt': '    alpha\n    beta\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': '    gamma\n    delta\n' },
  ),
  // --- unified drift d: the second hunk's target includes earlier hunks' delta (§6) ---
  T(
    'u20-drift',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,2 @@\n x\n-a\n+a\n+a2\n x\n@@ -2,1 +3,1 @@\n-x\n+X\n',
    { 'f.txt': 'x\na\nx\nb\nx\nc\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'x\na\na2\nX\nb\nx\nc\n' },
  ),
  // --- JSON create writes file_text byte for byte (§9, §3) ---
  T(
    'j6-create-bytes',
    ['-'],
    '{"command": "create", "path": "n.txt", "file_text": "a\\r\\nb"}\n',
    {},
    0,
    'A n.txt\nok: 1 file\n',
    { 'n.txt': 'a\r\nb' },
  ),
  // --- --format forces the format whatever the text holds (§1, §4) ---
  T(
    'c14-format-forced',
    ['--format=json', '-'],
    'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    { 'f.txt': 'a\n' },
    2,
    'error: parse 1\n',
    {},
  ),
  // --- unified header paths stop at the first tab (§6) ---
  T(
    'u21-tab-header',
    ['-'],
    '--- a/f.txt\t2026-11-22\n+++ b/f.txt\t2026-11-22\n@@ -1,1 +1,1 @@\n-a\n+A\n',
    { 'f.txt': 'a\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'A\n' },
  ),
  // --- `--- ` in a header not followed by `+++ `: parse error at THE LINE AFTER it (§6) ---
  T(
    'u22-dashdash-header',
    ['-'],
    'diff --git a/f.txt b/f.txt\n--- a/f.txt\nindex abc..def 100644\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
    { 'f.txt': 'a\n' },
    2,
    'error: parse 3\n',
    {},
  ),
  // --- malformed `diff --git` line: parse error at its line (§6) ---
  T(
    'u23-bad-diff-git',
    ['-'],
    'diff --git a/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
    { 'f.txt': 'a\n' },
    2,
    'error: parse 1\n',
    {},
  ),
  // --- V4A: first non-blank line is not Begin Patch -> parse at that line (§8) ---
  T('v9-first-line', ['--format=v4a', '-'], 'hello\n*** Begin Patch\n*** End Patch\n', {}, 2, 'error: parse 1\n', {}),
  // --- SEARCH/REPLACE: first block with no path line -> parse at its SEARCH line (§7) ---
  T('s6-no-path', ['-'], '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n', { 'f.txt': 'a\n' }, 2, 'error: parse 1\n', {}),
  // --- unsafe path in a SEARCH/REPLACE block (§2, §3) ---
  T(
    's7-unsafe-path',
    ['-'],
    'a/../b\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n',
    {},
    1,
    'error: unsafe a/../b\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- move to an existing path -> exists (§6) ---
  T(
    'u24-move-exists',
    ['-'],
    'diff --git a/old.txt b/taken.txt\nrename from old.txt\nrename to taken.txt\n',
    { 'old.txt': 'o\n', 'taken.txt': 't\n' },
    1,
    'error: exists taken.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- move from a missing file -> missing (§6) ---
  T(
    'u25-move-missing',
    ['-'],
    'diff --git a/ghost.txt b/new.txt\nrename from ghost.txt\nrename to new.txt\n',
    {},
    1,
    'error: missing ghost.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- JSON insert into an empty file at line 0: the file's (absent) final break stays (§9) ---
  T(
    'j7-insert-empty-file',
    ['-'],
    '{"command": "insert", "path": "f.txt", "insert_line": 0, "new_str": "x"}\n',
    { 'f.txt': '' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'x' },
  ),
  // --- two sections, each starting at a ---/+++ pair, no diff --git lines (§6) ---
  T(
    'u26-two-sections-nogit',
    ['-'],
    '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-b\n+B\n',
    { 'a.txt': 'a\n', 'b.txt': 'b\n' },
    0,
    'M a.txt\nM b.txt\nok: 2 files\n',
    { 'a.txt': 'A\n', 'b.txt': 'B\n' },
  ),
  // --- tier precedence: tier 0 wins even when a tier-1 occurrence is nearer the hunk (§5, §6) ---
  T(
    'u27-tier-precedence',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n-foo \n-bar\n+FOO\n+BAR\n',
    { 'f.txt': 'foo\nbar\nfoo \nbar\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'foo\nbar\nFOO\nBAR\n' },
  ),
  // --- tier precedence: once at tier 0 is NOT ambiguous even if twice at tier 1 (§5, §7) ---
  T(
    's8-tier-precedence',
    ['-'],
    'f.txt\n<<<<<<< SEARCH\nx = 1\n=======\nx = 2\n>>>>>>> REPLACE\n',
    { 'f.txt': 'x = 1\nx = 1 \n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'x = 2\nx = 1 \n' },
  ),
  // --- V4A: O occurring only before the cursor is no-match (§8) ---
  T(
    'v10-before-cursor',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n@@ a\n-b\n+B\n*** End Patch\n',
    { 'f.txt': 'b\na\nc\n' },
    1,
    'error: no-match f.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- JSON array form with a non-object element -> parse at the array start (§9) ---
  T('j8-array-nonobject', ['-'], '[1]\n', {}, 2, 'error: parse 1\n', {}),
  // --- JSON create missing file_text -> parse fault (§9) ---
  T('j9-create-nofiletext', ['-'], '{"command": "create", "path": "x.txt"}\n', {}, 2, 'error: parse 1\n', {}),
  // --- unified empty-O insert into an empty file (§6) ---
  T(
    'u28-insert-empty-file',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n+x\n',
    { 'f.txt': '' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'x\n' },
  ),
  // --- --format=auto behaves like the default (§1) ---
  T(
    'c15-format-auto',
    ['--format=auto', '-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
    { 'f.txt': 'a\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'A\n' },
  ),
  // --- two failures reported in patch order (§2, §10) ---
  T(
    'c16-two-failures',
    ['-'],
    '{"command": "str_replace", "path": "g1.txt", "old_str": "a", "new_str": "b"}\n{"command": "str_replace", "path": "g2.txt", "old_str": "a", "new_str": "b"}\n',
    {},
    1,
    'error: missing g1.txt\nerror: missing g2.txt\nfailed: 2 of 2 edits\n',
    {},
  ),
  // --- a CRLF patch file: patch lines lose one trailing CR each (§3) ---
  T(
    'c17-crlf-patch',
    ['-'],
    '--- a/f.txt\r\n+++ b/f.txt\r\n@@ -1,1 +1,1 @@\r\n-a\r\n+A\r\n',
    { 'f.txt': 'a\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'A\n' },
  ),
  // --- V4A Move to an unsafe path (§8, §2) ---
  T(
    'v11-move-unsafe',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n*** Move to: ../evil\n*** End Patch\n',
    { 'f.txt': 'x\n' },
    1,
    'error: unsafe ../evil\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- hunk header may carry trailing text (§6) ---
  T(
    'u29-hunk-trailing-text',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@ func main\n-a\n+A\n',
    { 'f.txt': 'a\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'A\n' },
  ),
  // --- SEARCH/REPLACE path line is trimmed (§7) ---
  T(
    's9-path-trimmed',
    ['-'],
    '  f.txt  \n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
    { 'f.txt': 'a\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'A\n' },
  ),
  // --- V4A anchor has its surrounding spaces removed (§8) ---
  T(
    'v12-anchor-trimmed',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n@@   foo   \n-bar\n+BAR\n*** End Patch\n',
    { 'f.txt': 'foo\nbar\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'foo\nBAR\n' },
  ),
  // --- V4A empty-O chunk inserts at the cursor, after its anchor (§8) ---
  T(
    'v13-insert-at-cursor',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n@@ a\n+X\n*** End Patch\n',
    { 'f.txt': 'a\nb\nc\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'a\nX\nb\nc\n' },
  ),
  // --- V4A empty-O end-of-file chunk inserts at the end of the file (§8) ---
  T(
    'v14-insert-at-eof',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n+X\n*** End of File\n*** End Patch\n',
    { 'f.txt': 'a\nb\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'a\nb\nX\n' },
  ),
  // --- unified empty-O insert past the end inserts after all lines (§6) ---
  T(
    'u30-insert-past-end',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -100,0 +101,1 @@\n+c\n',
    { 'f.txt': 'a\nb\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'a\nb\nc\n' },
  ),
  // --- move into a directory that does not exist yet: directories are created (§3) ---
  T(
    'u31-move-nested-dir',
    ['-'],
    'diff --git a/old.txt b/deep/dir/new.txt\nrename from old.txt\nrename to deep/dir/new.txt\n',
    { 'old.txt': 'hi\n' },
    0,
    'R old.txt -> deep/dir/new.txt\nok: 1 file\n',
    { 'old.txt': null, 'deep/dir/new.txt': 'hi\n' },
  ),
  // --- unified creation in a directory that does not exist yet (§3, §6) ---
  T(
    'u32-create-nested-dir',
    ['-'],
    'diff --git a/deep/n.txt b/deep/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/deep/n.txt\n@@ -0,0 +1,1 @@\n+hi\n',
    {},
    0,
    'A deep/n.txt\nok: 1 file\n',
    { 'deep/n.txt': 'hi\n' },
  ),
  // --- no R line when the moved-from path exists again after the patch (§2) ---
  T(
    'u33-r-suppressed-recreate',
    ['-'],
    'diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\ndiff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+brand new\n',
    { 'a.txt': 'old content\n' },
    0,
    'M a.txt\nA b.txt\nok: 2 files\n',
    { 'a.txt': 'brand new\n', 'b.txt': 'old content\n' },
  ),
  // --- JSON array-form fault reports the line where the ARRAY starts, even after blank lines (§9) ---
  T(
    'j10-array-start-after-blanks',
    ['-'],
    '\n\n[{"command": "create", "path": "a.txt", "file_text": "x"},\n{"command": "bogus"}]\n',
    {},
    2,
    'error: parse 3\n',
    {},
  ),
  // --- `\` after the last context line does NOT change the final break when the hunk misses EOF (§6) ---
  T(
    'u34-backslash-mid-file',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n\\ No newline at end of file\n',
    { 'f.txt': 'a\nb\nc' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'A\nb\nc' },
  ),
  // --- V4A anchor may match at tier 2 (leading whitespace ignored, §8 + §5) ---
  T(
    'v15-anchor-tier2',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n@@ foo\n-bar\n+BAR\n*** End Patch\n',
    { 'f.txt': '   foo\nbar\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': '   foo\nBAR\n' },
  ),
  // --- SEARCH/REPLACE path search skips a ``` fence line (§7) ---
  T(
    's10-path-skips-fence',
    ['-'],
    '```diff\nf.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
    { 'f.txt': 'a\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'A\n' },
  ),
  // --- str_replace: in an LF file an old_str holding CRLF is NOT normalised, so no-match (§9) ---
  T(
    'j11-crlf-old-in-lf-file',
    ['-'],
    '{"command": "str_replace", "path": "f.txt", "old_str": "a\\r\\nb", "new_str": "x"}\n',
    { 'f.txt': 'a\nb\n' },
    1,
    'error: no-match f.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- V4A: after an anchor the chunk's O is searched past the anchor line (§8) ---
  T(
    'v16-anchor-then-o',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n@@ a\n-b\n+B\n*** End Patch\n',
    { 'f.txt': 'a\nb\nc\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'a\nB\nc\n' },
  ),
  // --- FIX #1 (Gate 2): a body line after *** End of File flushed the first chunk (§8) ---
  // Only the FIRST chunk may start at a body line; the -b line here is parse 6.
  T(
    'v17-body-after-eof',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n-a\n+A\n*** End of File\n-b\n+B\n*** End Patch\n',
    { 'f.txt': 'a\n' },
    2,
    'error: parse 6\n',
    {},
  ),
  // --- FIX #2 (Gate 2): SEARCH/REPLACE block with no =======, single block (§7) ---
  T(
    's11-no-eq-single',
    ['-'],
    'f.txt\n<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n',
    { 'f.txt': 'a\n' },
    2,
    'error: parse 2\n',
    {},
  ),
  // --- FIX #2 (Gate 2): first block with no =======, followed by a complete block (§7) ---
  T(
    's12-no-eq-multi',
    ['-'],
    'f.txt\n<<<<<<< SEARCH\na\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
    { 'f.txt': 'a\nb\n' },
    2,
    'error: parse 2\n',
    {},
  ),
  // --- FIX #2 (Gate 2): block with no >>>>>>> REPLACE before the next block (§7) ---
  T(
    's13-no-replace-next-block',
    ['-'],
    'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
    { 'f.txt': 'a\nb\n' },
    2,
    'error: parse 2\n',
    {},
  ),
  // --- SEARCH/REPLACE block with no >>>>>>> REPLACE at end of patch (§7) ---
  T(
    's14-no-replace-eof',
    ['-'],
    'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n',
    { 'f.txt': 'a\n' },
    2,
    'error: parse 2\n',
    {},
  ),
  // --- unified: paths from `diff --git` only, no ---/+++ pair, no rename (§6) ---
  T(
    'u35-diff-git-only',
    ['-'],
    'diff --git a/f.txt b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
    { 'f.txt': 'a\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'A\n' },
  ),
  // --- unified: move via ---/+++ pair only, no rename lines, no hunks (§6) ---
  T(
    'u36-move-pair-no-rename',
    ['-'],
    '--- a/old.txt\n+++ b/new.txt\n',
    { 'old.txt': 'hello\n' },
    0,
    'R old.txt -> new.txt\nok: 1 file\n',
    { 'old.txt': null, 'new.txt': 'hello\n' },
  ),
  // --- unified: move via ---/+++ pair WITH hunks: R line + changed content (§6) ---
  T(
    'u37-move-with-hunks',
    ['-'],
    '--- a/old.txt\n+++ b/new.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
    { 'old.txt': 'a\n' },
    0,
    'R old.txt -> new.txt\nok: 1 file\n',
    { 'old.txt': null, 'new.txt': 'A\n' },
  ),
  // --- unified: change on a file that does not exist -> missing (§6) ---
  T(
    'u38-change-missing',
    ['-'],
    '--- a/ghost.txt\n+++ b/ghost.txt\n@@ -1,1 +1,1 @@\n-x\n+Y\n',
    {},
    1,
    'error: missing ghost.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- unified: creation on a path that already exists -> exists (§6) ---
  T(
    'u39-create-exists',
    ['-'],
    'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+hi\n',
    { 'n.txt': 'old\n' },
    1,
    'error: exists n.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- V4A Add File to a path that already exists -> exists (§8) ---
  T(
    'v18-add-exists',
    ['-'],
    '*** Begin Patch\n*** Add File: f.txt\n+hi\n*** End Patch\n',
    { 'f.txt': 'old\n' },
    1,
    'error: exists f.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- V4A Delete File of a file that does not exist -> missing (§8) ---
  T(
    'v19-delete-missing',
    ['-'],
    '*** Begin Patch\n*** Delete File: ghost.txt\n*** End Patch\n',
    {},
    1,
    'error: missing ghost.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- V4A anchor not found anywhere at or after the cursor -> no-match (§8) ---
  T(
    'v20-anchor-nomatch',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n@@ zzz\n-a\n+A\n*** End Patch\n',
    { 'f.txt': 'a\nb\n' },
    1,
    'error: no-match f.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- V4A: last non-blank line is not *** End Patch -> parse n+1 (§8) ---
  T(
    'v21-end-patch-missing',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n-a\n+A\n',
    { 'f.txt': 'a\n' },
    2,
    'error: parse 5\n',
    {},
  ),
  // --- auto-detect: a non-empty patch matching no format -> error: format (§4) ---
  T('c18-format-unknown', ['-'], 'hello world\n', {}, 2, 'error: format\n', {}),
  // --- --format without = is not an option at all -> usage (§1) ---
  T('c19-format-no-equals', ['--format', 'json', '-'], '{}\n', {}, 2, 'error: usage\n', {}),
  // --- usage error wins over no-patch (§2) ---
  T('c20-usage-beats-nopatch', ['--foo', 'missing.patch'], null, {}, 2, 'error: usage\n', {}),
  // --- --check with a failing edit: same output and exit 1, nothing written (§1) ---
  T(
    'c21-check-exit1',
    ['--check', '-'],
    '--- a/ghost.txt\n+++ b/ghost.txt\n@@ -1,1 +1,1 @@\n-x\n+Y\n',
    {},
    1,
    'error: missing ghost.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- tier 2: an N line NOT starting with P is written as it is (§5) ---
  T(
    'u40-tier2-noline-p',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-  a\n+x\n',
    { 'f.txt': '    a\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'x\n' },
  ),
  // --- tier 2: an N line that is only whitespace is NOT re-indented (§5) ---
  T(
    'u41-tier2-whitespace-n',
    ['-'],
    '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-  a\n+  \n+  b\n',
    { 'f.txt': '    a\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': '  \n    b\n' },
  ),
  // --- JSON str_replace without new_str replaces with empty (§9) ---
  T(
    'j12-str-replace-no-newstr',
    ['-'],
    '{"command": "str_replace", "path": "f.txt", "old_str": "a"}\n',
    { 'f.txt': 'a\nb\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': '\nb\n' },
  ),
  // --- JSON str_replace with an empty old_str is a parse fault (§9) ---
  T(
    'j13-str-replace-empty-old',
    ['-'],
    '{"command": "str_replace", "path": "f.txt", "old_str": "", "new_str": "x"}\n',
    { 'f.txt': 'a\n' },
    2,
    'error: parse 1\n',
    {},
  ),
  // --- JSON insert with a negative insert_line -> no-match (§9) ---
  T(
    'j14-insert-negative',
    ['-'],
    '{"command": "insert", "path": "f.txt", "insert_line": -1, "new_str": "x"}\n',
    { 'f.txt': 'a\nb\n' },
    1,
    'error: no-match f.txt\nfailed: 1 of 1 edits\n',
    {},
  ),
  // --- JSON Lines: blank lines are ignored (§9) ---
  T(
    'j15-jsonlines-blank',
    ['-'],
    '{"command": "create", "path": "a.txt", "file_text": "x\\n"}\n\n{"command": "create", "path": "b.txt", "file_text": "y\\n"}\n',
    {},
    0,
    'A a.txt\nA b.txt\nok: 2 files\n',
    { 'a.txt': 'x\n', 'b.txt': 'y\n' },
  ),
  // --- output lines sort in byte order: 'B' (0x42) before 'a' (0x61) (§2) ---
  T(
    'c22-sort-byte-order',
    ['-'],
    '{"command": "create", "path": "a.txt", "file_text": "x\\n"}\n{"command": "create", "path": "B.txt", "file_text": "y\\n"}\n',
    {},
    0,
    'A B.txt\nA a.txt\nok: 2 files\n',
    { 'a.txt': 'x\n', 'B.txt': 'y\n' },
  ),
  // --- FIX #3: `*** End of File` with no chunk running is a parse error at its line (§8) ---
  // A stray End of File must not conjure an empty end-of-file chunk: the section
  // has no chunk, and (probe 2) a following @@ chunk must not inherit a poisoned cursor.
  T(
    'v22-eof-no-chunk',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n*** End of File\n*** End Patch\n',
    { 'f.txt': 'a\nb\n' },
    2,
    'error: parse 3\n',
    {},
  ),
  // --- FIX #3: `*** End of File` before an @@ chunk is a parse error at the End of File line (§8) ---
  T(
    'v23-eof-then-chunk',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n*** End of File\n@@ b\n-b\n+B\n*** End Patch\n',
    { 'f.txt': 'a\nb\n' },
    2,
    'error: parse 3\n',
    {},
  ),
  // --- FIX #3 (control): a chunk WITH content closed by `*** End of File` still applies (§8) ---
  T(
    'v24-eof-closes-chunk',
    ['-'],
    '*** Begin Patch\n*** Update File: f.txt\n a\n-b\n+B\n*** End of File\n*** End Patch\n',
    { 'f.txt': 'a\nb\n' },
    0,
    'M f.txt\nok: 1 file\n',
    { 'f.txt': 'a\nB\n' },
  ),
];

let passed = 0;
for (const c of cases) {
  const want: Record<string, string> = { ...c.files };
  for (const [p, v] of Object.entries(c.changes)) {
    if (v === null) delete want[p];
    else want[p] = v;
  }
  const got = runCheck({ id: c.name, argv: c.argv, stdin: c.stdin, files: c.files });
  const why: string[] = [];
  if (got.exit !== c.exit) why.push(`exit ${got.exit}, expected ${c.exit}`);
  if (got.stdout !== c.stdout) why.push(`stdout ${JSON.stringify(got.stdout)}, expected ${JSON.stringify(c.stdout)}`);
  for (const p of new Set([...Object.keys(want), ...Object.keys(got.files)])) {
    if (want[p] === undefined) why.push(`${p} should not exist`);
    else if (got.files[p] === undefined) why.push(`${p} is missing`);
    else if (got.files[p] !== want[p]) why.push(`${p} differs: expected ${JSON.stringify(want[p])}, got ${JSON.stringify(got.files[p])}`);
  }
  if (why.length === 0) passed += 1;
  else process.stdout.write(`FAIL ${c.name}\n  ${why.join('\n  ')}\n`);
}
process.stdout.write(`${passed} of ${cases.length} adversarial passed\n`);
if (passed !== cases.length) process.exitCode = 1;
