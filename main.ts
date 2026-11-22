// mend: one patch tool for every AI edit format, as SPEC.md specifies (MIT starter, sections 1-4, 9, 10;
// sections 5-8 written fresh from the spec). It reads a patch in one of four formats -- a unified diff (often
// with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, or text-editor tool calls as JSON --
// and applies it to the tree of text files in the working directory, all or nothing: every file is changed or
// nothing is. Old lines are matched at the first of three tiers at which they occur (exact; trailing
// spaces/tabs ignored; leading and trailing spaces/tabs ignored), `--strict` tries the exact tier only.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// Section 3: a file's line break is CRLF when its first line feed follows a carriage return, LF otherwise.
// Its lines are its text split at that break; the empty piece after a final break is not a line. An empty
// file has no lines and no final break, and a file of no lines is written empty.
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a move edit performed, in patch order; an R line needs the pair to end as D old + A new. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// Section 5: matching lines at three tiers. Tier 0 compares lines exactly; tier 1 ignores trailing spaces
// and tabs on both sides; tier 2 ignores leading and trailing spaces and tabs on both sides.

const TRAILING_WS = /[ \t]+$/;
const EDGE_WS = /^[ \t]+|[ \t]+$/g;
const LEADING_WS = /^[ \t]*/;

function normAt(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(TRAILING_WS, '');
  return line.replace(EDGE_WS, '');
}

/** Every start position where pat occurs in hay at the tier, overlaps included (Knuth-Morris-Pratt). */
function occurrences(hay: string[], pat: string[], tier: number): number[] {
  const m = pat.length;
  const n = hay.length;
  if (m === 0 || m > n) return [];
  const p = pat.map((l) => normAt(l, tier));
  const h = hay.map((l) => normAt(l, tier));
  const pi = new Array<number>(m).fill(0);
  for (let i = 1, j = 0; i < m; i++) {
    while (j > 0 && p[i] !== p[j]) j = pi[j - 1]!;
    if (p[i] === p[j]) j += 1;
    pi[i] = j;
  }
  const out: number[] = [];
  for (let i = 0, j = 0; i < n; i++) {
    while (j > 0 && h[i] !== p[j]) j = pi[j - 1]!;
    if (h[i] === p[j]) j += 1;
    if (j === m) {
      out.push(i - m + 1);
      j = pi[j - 1]!;
    }
  }
  return out;
}

/** The first tier at which pat occurs at least once, with every occurrence there; null when it never does. */
function findTier(hay: string[], pat: string[], strict: boolean): { tier: number; at: number[] } | null {
  const top = strict ? 1 : 3;
  for (let tier = 0; tier < top; tier++) {
    const at = occurrences(hay, pat, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of a hunk or chunk body, in body order: context (in both O and N), old (in O only), new (in N only). */
type BodyLine = { kind: 'ctx'; text: string } | { kind: 'old'; text: string } | { kind: 'new'; text: string };

/**
 * The lines N that replace the k matched lines at pos. A context line is written as the file's own matched
 * line, never the patch's. At tier 2 every other line of N is re-indented: F is the leading spaces and tabs
 * of the file's first matched line, P those of O's first line; a line of N that is not empty and not only
 * whitespace, and starts with P, has that P replaced by F. (When P is empty, F is put in front of every such
 * line.) At tiers 0 and 1 the lines of N are written as they are.
 */
function buildReplacement(body: BodyLine[], fileLines: string[], pos: number, tier: number): string[] {
  let p = '';
  let f = '';
  if (tier === 2) {
    const oFirst = body.find((b) => b.kind !== 'new');
    p = LEADING_WS.exec(oFirst === undefined ? '' : oFirst.text)?.[0] ?? '';
    f = LEADING_WS.exec(fileLines[pos]!)?.[0] ?? '';
  }
  const out: string[] = [];
  let oIdx = 0;
  for (const b of body) {
    if (b.kind === 'old') {
      oIdx += 1;
      continue;
    }
    if (b.kind === 'ctx') {
      out.push(fileLines[pos + oIdx]!);
      oIdx += 1;
      continue;
    }
    let t = b.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** The first line at or after cursor equal to the anchor, at the first tier where one is; null when none. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const top = strict ? 1 : 3;
  for (let tier = 0; tier < top; tier++) {
    const a = normAt(anchor, tier);
    for (let i = cursor; i < lines.length; i++) {
      if (normAt(lines[i]!, tier) === a) return i;
    }
  }
  return null;
}

// Section 4: detecting the format, in the order v4a, json, search-replace, unified.
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// Section 6: unified diffs. A section is one edit: a creation, a deletion, a move, or a change of one path.

interface Hunk {
  /** A from `@@ -A[,B] +C[,D] @@`: the hunk's start line in the old file, 1-based. */
  a: number;
  body: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNewline: boolean;
  /** A `\` line follows the hunk's last `+` line (creation only). */
  noNewlinePlus: boolean;
}

interface Section {
  diffA: string | null;
  diffB: string | null;
  /** The `---`/`+++` pair; undefined when the section has none, null when a side is /dev/null. */
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, spaces removed. */
function parseDiffPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** A hunk's raw body lines (empty lines at the end of a body are not part of it). */
function parseHunkBody(raw: string[]): { body: BodyLine[]; noNewline: boolean; noNewlinePlus: boolean } {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === '') end -= 1;
  const lines = raw.slice(0, end);
  let lastCtx = -1;
  let lastPlus = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) lastCtx = i;
    if (l.startsWith('+')) lastPlus = i;
  }
  const noNewline = lastCtx >= 0 && lines[lastCtx + 1] !== undefined && lines[lastCtx + 1]!.startsWith('\\');
  const noNewlinePlus = lastPlus >= 0 && lines[lastPlus + 1] !== undefined && lines[lastPlus + 1]!.startsWith('\\');
  const body: BodyLine[] = [];
  for (const l of lines) {
    if (l.startsWith('\\')) continue;
    if (l === '' || l.startsWith(' ')) body.push({ kind: 'ctx', text: l === '' ? '' : l.slice(1) });
    else if (l.startsWith('-')) body.push({ kind: 'old', text: l.slice(1) });
    else if (l.startsWith('+')) body.push({ kind: 'new', text: l.slice(1) });
  }
  return { body, noNewline, noNewlinePlus };
}

const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let state: 'out' | 'header' | 'body' | 'between' = 'out';
  let hunkA: number | null = null;
  let rawBody: string[] = [];
  const closeHunk = (): void => {
    if (hunkA !== null && cur !== null) {
      const { body, noNewline, noNewlinePlus } = parseHunkBody(rawBody);
      cur.hunks.push({ a: hunkA, body, noNewline, noNewlinePlus });
    }
    hunkA = null;
    rawBody = [];
  };
  const closeSection = (): void => {
    closeHunk();
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  const blankSection = (): Section => ({
    diffA: null,
    diffB: null,
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const next = lines[i + 1];
    const isDiff = l === 'diff --git' || l.startsWith('diff --git ');
    const isPairStart = l.startsWith('--- ') && next !== undefined && next.startsWith('+++ ');

    if (state === 'body') {
      if (!isDiff && !isPairStart && (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\'))) {
        rawBody.push(l);
        i += 1;
        continue;
      }
      closeHunk();
      state = 'between';
    }

    if (isDiff) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      closeSection();
      cur = blankSection();
      cur.diffA = m[1]!;
      cur.diffB = m[2]!;
      state = 'header';
      i += 1;
      continue;
    }

    if (isPairStart) {
      if (state === 'header' && cur !== null && cur.pairOld === undefined) {
        cur.pairOld = parseDiffPath(l);
        cur.pairNew = parseDiffPath(next!);
        i += 2;
        continue;
      }
      closeSection();
      cur = blankSection();
      cur.pairOld = parseDiffPath(l);
      cur.pairNew = parseDiffPath(next!);
      state = 'header';
      i += 2;
      continue;
    }

    if (l.startsWith('--- ')) {
      if (state === 'header') throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }

    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      hunkA = Number(m[1]);
      rawBody = [];
      state = 'body';
      i += 1;
      continue;
    }

    if (state === 'header' && cur !== null) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length);
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length);
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }

    i += 1;
  }
  closeSection();
  return sections.map((s) => sectionEdit(s, strict));
}

/** The hunks of a section, in order, each to the result of the ones before it. */
function applyHunks(lines: string[], hunks: Hunk[], strict: boolean, path: string, final: boolean): { lines: string[]; final: boolean } {
  let cur = lines;
  let fin = final;
  let d = 0;
  for (const h of hunks) {
    const o = h.body.filter((b) => b.kind !== 'new').map((b) => b.text);
    const n = h.body.filter((b) => b.kind !== 'old').map((b) => b.text);
    if (o.length === 0) {
      const ins = Math.max(0, Math.min(h.a + d, cur.length));
      const atEnd = ins === cur.length;
      cur = [...cur.slice(0, ins), ...n, ...cur.slice(ins)];
      if (atEnd) fin = !h.noNewline;
      d += n.length;
      continue;
    }
    const found = findTier(cur, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.at[0]!;
    for (const p of found.at) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const touchesEnd = best + o.length === cur.length;
    const repl = buildReplacement(h.body, cur, best, found.tier);
    cur = [...cur.slice(0, best), ...repl, ...cur.slice(best + o.length)];
    if (touchesEnd) fin = !h.noNewline;
    d += repl.length - o.length;
  }
  return { lines: cur, final: fin };
}

function sectionEdit(s: Section, strict: boolean): Edit {
  let oldPath: string | null;
  let newPath: string | null;
  if (s.pairOld !== undefined) {
    oldPath = s.pairOld;
    newPath = s.pairNew!;
  } else {
    oldPath = s.renameFrom ?? s.diffA;
    newPath = s.renameTo ?? s.diffB;
  }
  const isCreate = oldPath === null || s.newFile;
  const isDelete = !isCreate && (newPath === null || s.deletedFile);
  if (isCreate) {
    const target = newPath;
    if (target === null) return () => undefined;
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      let noNl = false;
      for (const h of s.hunks) {
        let hasPlus = false;
        for (const b of h.body) {
          if (b.kind === 'new') {
            plus.push(b.text);
            hasPlus = true;
          }
        }
        if (hasPlus) noNl = h.noNewlinePlus;
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
    };
  }
  if (isDelete) {
    const target = oldPath!;
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  if (oldPath !== newPath) {
    const from = oldPath!;
    const to = newPath!;
    return (tree) => {
      if (!safe(from)) throw new Fail('unsafe', from);
      if (!safe(to)) throw new Fail('unsafe', to);
      const before = tree.get(from);
      if (before === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const { lines, br, final } = splitFile(before);
      const out = applyHunks(lines, s.hunks, strict, from, final);
      tree.now.set(to, joinFile(out.lines, br, out.final));
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    };
  }
  const target = oldPath!;
  return (tree) => {
    if (!safe(target)) throw new Fail('unsafe', target);
    const before = tree.get(target);
    if (before === null) throw new Fail('missing', target);
    const { lines, br, final } = splitFile(before);
    const out = applyHunks(lines, s.hunks, strict, target, final);
    tree.now.set(target, joinFile(out.lines, br, out.final));
  };
}

// Section 7: SEARCH/REPLACE blocks. Each block is one edit, applied in order.

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  if (oldLines.length === 0) {
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
    };
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { lines, br, final } = splitFile(before);
    const found = findTier(lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const body: BodyLine[] = [
      ...oldLines.map((t): BodyLine => ({ kind: 'old', text: t })),
      ...newLines.map((t): BodyLine => ({ kind: 'new', text: t })),
    ];
    const repl = buildReplacement(body, lines, pos, found.tier);
    const out = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(out, br, final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    // The `=======` belongs to this block: the scan stops at the next SEARCH or REPLACE line, so a block
    // missing its separator cannot swallow the next block's markers.
    let sep = -1;
    let j = searchIdx + 1;
    for (; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
      if (t === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (j = sep + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, sep), lines.slice(sep + 1, rep), strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

// Section 8: V4A patches. `*** Begin Patch` opens, `*** End Patch` closes; between them, Add File, Delete
// File and Update File sections, each one edit, applied in order.

interface V4AChunk {
  /** Null when the chunk has no `@@` line, or its anchor text is empty. */
  anchor: string | null;
  body: BodyLine[];
  /** Ended by a `*** End of File` line: anchored to the end of the file. */
  eof: boolean;
}

const V4A_HEADERS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const header = V4A_HEADERS.find((h) => l.startsWith(h));
    if (header === undefined) throw new Exit2(`error: parse ${i + 1}`);
    const kind = header.slice(4, 7);
    const path = l.slice(header.length).trim();
    const headerLine = i + 1;
    const rawStart = i + 1;
    let j = rawStart;
    while (j < last && !V4A_HEADERS.some((h) => lines[j]!.startsWith(h))) j += 1;
    const raw = lines.slice(rawStart, j);
    let end = raw.length;
    while (end > 0 && blank(raw[end - 1]!)) end -= 1;
    const body = raw.slice(0, end);
    const lineNo = (k: number): number => rawStart + k + 1;

    if (kind === 'Add') {
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (bl === '') fileLines.push('');
        else if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else throw new Exit2(`error: parse ${lineNo(k)}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'Del') {
      if (body.length > 0) throw new Exit2(`error: parse ${lineNo(0)}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
        moveTo = body[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      let afterEof = false;
      for (; k < body.length; k++) {
        const bl = body[k]!;
        if (bl.startsWith('@@')) {
          const anchor = bl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(cur);
          afterEof = false;
          continue;
        }
        if (bl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo(k)}`);
          cur.eof = true;
          cur = null;
          afterEof = true;
          continue;
        }
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (afterEof) throw new Exit2(`error: parse ${lineNo(k)}`);
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          if (bl === '' || bl.startsWith(' ')) cur.body.push({ kind: 'ctx', text: bl === '' ? '' : bl.slice(1) });
          else if (bl.startsWith('-')) cur.body.push({ kind: 'old', text: bl.slice(1) });
          else cur.body.push({ kind: 'new', text: bl.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${lineNo(k)}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

/** An Update File edit: chunks apply in order, with a cursor that starts at line 0. */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const { lines, br, final } = splitFile(before);
    let cur = lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(cur, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o = chunk.body.filter((b) => b.kind !== 'new').map((b) => b.text);
      const n = chunk.body.filter((b) => b.kind !== 'old').map((b) => b.text);
      if (o.length === 0) {
        const ins = chunk.eof ? cur.length : cursor;
        cur = [...cur.slice(0, ins), ...n, ...cur.slice(ins)];
        cursor = ins + n.length;
        continue;
      }
      const top = strict ? 1 : 3;
      let found: { pos: number; tier: number } | null = null;
      for (let tier = 0; tier < top && found === null; tier++) {
        for (const p of occurrences(cur, o, tier)) {
          if (p < cursor) continue;
          if (chunk.eof && p + o.length !== cur.length) continue;
          found = { pos: p, tier };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const repl = buildReplacement(chunk.body, cur, found.pos, found.tier);
      cur = [...cur.slice(0, found.pos), ...repl, ...cur.slice(found.pos + o.length)];
      cursor = found.pos + repl.length;
    }
    const text = joinFile(cur, br, final);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

// Sections 1, 2 and 10: the command line, the output and exit codes, order and atomicity.
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; line: string }> = [];
  const used = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (o !== undefined && o.was !== null && o.now === null && n !== undefined && n.was === null && n.now !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      used.add(oldP);
      used.add(newP);
    }
  }
  for (const [p, c] of changed) {
    if (used.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...changed.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = changed.get(p)!.now;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
