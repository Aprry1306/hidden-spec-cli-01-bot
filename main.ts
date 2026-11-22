// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

// ---------- Section 3: a file as lines, its own break, its final break ----------

interface FileModel {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) lines.pop();
  return { lines, br, finalBr };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBr ? m.br : '');
}

const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

// ---------- Section 5: matching lines at three tiers ----------

const NORMS: ((s: string) => string)[] = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

const tiers = (strict: boolean): number[] => (strict ? [0] : [0, 1, 2]);

/** A line array with its per-tier normalised forms cached. */
class NormLines {
  readonly lines: string[];
  private readonly cache: (string[] | null)[] = [null, null, null];
  constructor(lines: string[]) {
    this.lines = lines;
  }
  at(tier: number): string[] {
    if (tier === 0) return this.lines;
    let v = this.cache[tier];
    if (v === null) {
      v = this.lines.map(NORMS[tier]!);
      this.cache[tier] = v;
    }
    return v;
  }
}

/** Positions at or after `from` where O occurs at `tier` (overlaps count); at most `limit` (0: all). */
function occurrences(nl: NormLines, o: string[], tier: number, from: number, eofOnly: boolean, limit: number): number[] {
  const arr = nl.at(tier);
  const normO = o.map(NORMS[tier]!);
  const out: number[] = [];
  const last = nl.lines.length - o.length;
  let i = from;
  while (i <= last) {
    const j = arr.indexOf(normO[0]!, i);
    if (j < 0 || j > last) break;
    let ok = true;
    for (let k = 1; k < normO.length; k++) {
      if (arr[j + k] !== normO[k]) {
        ok = false;
        break;
      }
    }
    if (ok && (!eofOnly || j + o.length === nl.lines.length)) {
      out.push(j);
      if (limit > 0 && out.length >= limit) return out;
    }
    i = j + 1;
  }
  return out;
}

const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

/** The N lines as written: context lines are the file's own matched lines; at tier 2 the rest are re-indented. */
function buildReplacement(
  lines: string[],
  pos: number,
  tier: number,
  o: string[],
  n: string[],
  ctxIdx: (number | null)[],
): string[] {
  const out: string[] = [];
  const f = tier === 2 ? leadingWs(lines[pos]!) : '';
  const p = tier === 2 ? leadingWs(o[0]!) : '';
  for (let j = 0; j < n.length; j++) {
    const ci = ctxIdx[j]!;
    if (ci !== null) {
      out.push(lines[pos + ci]!);
      continue;
    }
    let s = n[j]!;
    if (tier === 2 && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
    out.push(s);
  }
  return out;
}

// ---------- Section 6: unified diffs ----------

interface UHunkBody {
  kind: 'ctx' | 'old' | 'new' | 'back';
  text: string;
  rawEmpty: boolean;
}
interface UHunk {
  a: number;
  body: UHunkBody[];
  noFinalBreak: boolean;
}
interface USection {
  gitX: string | null;
  gitY: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  plusOnly: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseHunkHeader(l: string, lineNo: number): UHunk {
  const m = HUNK_RE.exec(l);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return { a: parseInt(m[1]!, 10), body: [], noFinalBreak: false };
}

function parseGitLine(l: string, lineNo: number): [string, string] {
  const rest = l.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
  const sep = rest.lastIndexOf(' b/');
  if (sep < 2) throw new Exit2(`error: parse ${lineNo}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${lineNo}`);
  return [x, y];
}

/** The path a `--- `/`+++ ` line names: after the four characters, up to the first tab, spaces removed. */
function parseDiffPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = trimSpaces(p);
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  const n = lines.length;
  let section: USection | null = null;
  let inHeader = false;
  let hunk: UHunk | null = null;

  const newSection = (gx: string | null, gy: string | null): USection => ({
    gitX: gx,
    gitY: gy,
    pairOld: undefined,
    pairNew: undefined,
    plusOnly: undefined,
    renameFrom: null,
    renameTo: null,
    create: false,
    del: false,
    hunks: [],
  });
  const endHunk = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.rawEmpty) hunk.body.pop();
    let noFB = false;
    for (let j = hunk.body.length - 1; j >= 0; j--) {
      const b = hunk.body[j]!;
      if (b.kind === 'ctx' || b.kind === 'new') {
        noFB = hunk.body[j + 1] !== undefined && hunk.body[j + 1]!.kind === 'back';
        break;
      }
    }
    hunk.noFinalBreak = noFB;
    hunk = null;
  };

  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (hunk !== null) {
      if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        endHunk();
      } else if (l.startsWith('@@')) {
        endHunk();
      } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        if (l === '') hunk.body.push({ kind: 'ctx', text: '', rawEmpty: true });
        else if (l[0] === ' ') hunk.body.push({ kind: 'ctx', text: l.slice(1), rawEmpty: false });
        else if (l[0] === '-') hunk.body.push({ kind: 'old', text: l.slice(1), rawEmpty: false });
        else if (l[0] === '+') hunk.body.push({ kind: 'new', text: l.slice(1), rawEmpty: false });
        else hunk.body.push({ kind: 'back', text: l.slice(1), rawEmpty: false });
        i += 1;
        continue;
      } else {
        endHunk();
      }
    }
    if (l.startsWith('diff --git ')) {
      const [gx, gy] = parseGitLine(l, i + 1);
      section = newSection(gx, gy);
      sections.push(section);
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (section === null || !inHeader) {
        section = newSection(null, null);
        sections.push(section);
        inHeader = true;
      }
      section.pairOld = parseDiffPath(l);
      section.pairNew = parseDiffPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (section !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        section.plusOnly = parseDiffPath(l);
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        section.renameFrom = trimSpaces(l.slice(12));
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        section.renameTo = trimSpaces(l.slice(10));
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        section.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        section.del = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        const nh = parseHunkHeader(l, i + 1);
        section.hunks.push(nh);
        hunk = nh;
        inHeader = false;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (section === null) throw new Exit2(`error: parse ${i + 1}`);
      const nh = parseHunkHeader(l, i + 1);
      section.hunks.push(nh);
      hunk = nh;
      i += 1;
      continue;
    }
    i += 1;
  }
  endHunk();
  return sections;
}

/** A hunk's O (context + `-`), N (context + `+`) and, for each N line, its O index when it is a context line. */
function hunkON(h: UHunk): { o: string[]; n: string[]; ctxIdx: (number | null)[] } {
  const o: string[] = [];
  const n: string[] = [];
  const ctxIdx: (number | null)[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      ctxIdx.push(o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === 'old') o.push(b.text);
    else if (b.kind === 'new') {
      ctxIdx.push(null);
      n.push(b.text);
    }
  }
  return { o, n, ctxIdx };
}

/** The occurrence at the first tier with one, nearest to `target` (ties: the earlier). */
function nearestOccurrence(nl: NormLines, o: string[], strict: boolean, target: number): { pos: number; tier: number } | null {
  for (const tier of tiers(strict)) {
    const occ = occurrences(nl, o, tier, 0, false, 0);
    if (occ.length === 0) continue;
    let best = occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    return { pos: best, tier };
  }
  return null;
}

function applyHunk(model: FileModel, h: UHunk, d: number, strict: boolean, path: string): { model: FileModel; delta: number } {
  const { o, n, ctxIdx } = hunkON(h);
  const lines = model.lines;
  if (o.length === 0) {
    const at = Math.max(0, Math.min(h.a + d, lines.length));
    const out = [...lines.slice(0, at), ...n, ...lines.slice(at)];
    const finalBr = at === lines.length ? !h.noFinalBreak : model.finalBr;
    return { model: { lines: out, br: model.br, finalBr }, delta: n.length };
  }
  const nl = new NormLines(lines);
  const found = nearestOccurrence(nl, o, strict, h.a - 1 + d);
  if (found === null) throw new Fail('no-match', path);
  const written = buildReplacement(lines, found.pos, found.tier, o, n, ctxIdx);
  const out = [...lines.slice(0, found.pos), ...written, ...lines.slice(found.pos + o.length)];
  const finalBr = found.pos + o.length === lines.length ? !h.noFinalBreak : model.finalBr;
  return { model: { lines: out, br: model.br, finalBr }, delta: n.length - o.length };
}

function unifiedEdit(sec: USection, strict: boolean, recordMove: (o: string, n: string) => void): Edit {
  const hasPair = sec.pairOld !== undefined;
  const oldP = hasPair ? sec.pairOld! : (sec.renameFrom ?? sec.gitX);
  const newP = hasPair ? sec.pairNew! : (sec.plusOnly ?? sec.renameTo ?? sec.gitY);
  const isCreate = oldP === null || sec.create;
  const isDelete = !isCreate && (newP === null || sec.del);
  const isMove = !isCreate && !isDelete && oldP !== newP;
  return (tree) => {
    if (isCreate) {
      const target = newP ?? oldP ?? '';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      let lastPlusBack = false;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          if (h.body[j]!.kind === 'new') {
            plus.push(h.body[j]!.text);
            lastPlusBack = h.body[j + 1] !== undefined && h.body[j + 1]!.kind === 'back';
          }
        }
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBack ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldP!;
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const src = oldP!;
    const dst = newP!;
    if (!safe(src)) throw new Fail('unsafe', src);
    if (!safe(dst)) throw new Fail('unsafe', dst);
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);
    let model = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyHunk(model, h, d, strict, src);
      model = r.model;
      d += r.delta;
    }
    const out = joinFile(model);
    if (isMove) {
      tree.now.set(dst, out);
      tree.now.set(src, null);
      recordMove(src, dst);
    } else {
      tree.now.set(src, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean, recordMove: (o: string, n: string) => void): Edit[] {
  return parseUnified(lines).map((sec) => unifiedEdit(sec, strict, recordMove));
}

// ---------- Section 7: SEARCH/REPLACE blocks ----------

interface SBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SBlock[] {
  const blocks: SBlock[] = [];
  const n = lines.length;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return blocks;
}

function searchReplaceEdit(b: SBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = splitFile(before);
    const nl = new NormLines(model.lines);
    let found: { pos: number; tier: number } | null = null;
    for (const tier of tiers(strict)) {
      const occ = occurrences(nl, b.oldLines, tier, 0, false, 2);
      if (occ.length === 0) continue;
      if (occ.length > 1) throw new Fail('ambiguous', b.path);
      found = { pos: occ[0]!, tier };
      break;
    }
    if (found === null) throw new Fail('no-match', b.path);
    const written = buildReplacement(model.lines, found.pos, found.tier, b.oldLines, b.newLines, b.newLines.map(() => null));
    const out = [...model.lines.slice(0, found.pos), ...written, ...model.lines.slice(found.pos + b.oldLines.length)];
    tree.now.set(b.path, joinFile({ lines: out, br: model.br, finalBr: model.finalBr }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((b) => searchReplaceEdit(b, strict));
}

// ---------- Section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  oLines: string[];
  nLines: string[];
  ctxIdx: (number | null)[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | undefined;
  chunks: VChunk[];
  updateLine: number;
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4aChunks(raw: { text: string; no: number }[]): VChunk[] {
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; o: string[]; n: string[]; ctx: (number | null)[]; eof: boolean } | null = null;
  const flush = (): void => {
    if (cur !== null) {
      chunks.push({ anchor: cur.anchor, oLines: cur.o, nLines: cur.n, ctxIdx: cur.ctx, eof: cur.eof });
      cur = null;
    }
  };
  for (const r of raw) {
    const l = r.text;
    if (l.startsWith('@@')) {
      flush();
      const anchor = trimSpaces(l.slice(2));
      cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], ctx: [], eof: false };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) cur = { anchor: null, o: [], n: [], ctx: [], eof: false };
      cur.eof = true;
      flush();
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) cur = { anchor: null, o: [], n: [], ctx: [], eof: false };
      if (l === '' || l.startsWith(' ')) {
        const t = l === '' ? '' : l.slice(1);
        cur.ctx.push(cur.o.length);
        cur.o.push(t);
        cur.n.push(t);
      } else if (l.startsWith('-')) cur.o.push(l.slice(1));
      else {
        cur.ctx.push(null);
        cur.n.push(l.slice(1));
      }
      continue;
    }
    throw new Exit2(`error: parse ${r.no}`);
  }
  flush();
  return chunks;
}

function parseV4a(lines: string[]): VSection[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = trimSpaces(l.slice('*** Add File: '.length));
      const raw: { text: string; no: number }[] = [];
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) {
        raw.push({ text: lines[j]!, no: j + 1 });
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const secLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) secLines.push(r.text.slice(1));
        else if (r.text === '') secLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      sections.push({ kind: 'add', path, lines: secLines, moveTo: undefined, chunks: [], updateLine: 0 });
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = trimSpaces(l.slice('*** Delete File: '.length));
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      sections.push({ kind: 'delete', path, lines: [], moveTo: undefined, chunks: [], updateLine: 0 });
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = trimSpaces(l.slice('*** Update File: '.length));
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | undefined;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = trimSpaces(lines[i]!.slice('*** Move to: '.length));
        i += 1;
      }
      const raw: { text: string; no: number }[] = [];
      let j = i;
      while (j < last && !isV4aSectionStart(lines[j]!)) {
        raw.push({ text: lines[j]!, no: j + 1 });
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const chunks = parseV4aChunks(raw);
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind: 'update', path, lines: [], moveTo, chunks, updateLine });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

/** The first line at or after `cursor` equal to the anchor at the first tier with one, or -1. */
function findAnchor(nl: NormLines, anchor: string, strict: boolean, cursor: number): number {
  for (const tier of tiers(strict)) {
    const idx = nl.at(tier).indexOf(NORMS[tier]!(anchor), cursor);
    if (idx >= 0) return idx;
  }
  return -1;
}

function v4aEdit(sec: VSection, strict: boolean, recordMove: (o: string, n: string) => void): Edit {
  return (tree) => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : `${sec.lines.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let model = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      const nl = new NormLines(model.lines);
      if (ch.anchor !== null) {
        const aPos = findAnchor(nl, ch.anchor, strict, cursor);
        if (aPos < 0) throw new Fail('no-match', sec.path);
        cursor = aPos + 1;
      }
      if (ch.oLines.length === 0) {
        const at = ch.eof ? model.lines.length : cursor;
        const out = [...model.lines.slice(0, at), ...ch.nLines, ...model.lines.slice(at)];
        model = { lines: out, br: model.br, finalBr: model.finalBr };
        cursor = at + ch.nLines.length;
        continue;
      }
      let found: { pos: number; tier: number } | null = null;
      for (const tier of tiers(strict)) {
        const occ = occurrences(nl, ch.oLines, tier, cursor, ch.eof, 1);
        if (occ.length > 0) {
          found = { pos: occ[0]!, tier };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', sec.path);
      const written = buildReplacement(model.lines, found.pos, found.tier, ch.oLines, ch.nLines, ch.ctxIdx);
      const out = [...model.lines.slice(0, found.pos), ...written, ...model.lines.slice(found.pos + ch.oLines.length)];
      model = { lines: out, br: model.br, finalBr: model.finalBr };
      cursor = found.pos + written.length;
    }
    const outText = joinFile(model);
    if (sec.moveTo !== undefined) {
      tree.now.set(sec.moveTo, outText);
      tree.now.set(sec.path, null);
      recordMove(sec.path, sec.moveTo);
    } else {
      tree.now.set(sec.path, outText);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, recordMove: (o: string, n: string) => void): Edit[] {
  return parseV4a(lines).map((sec) => v4aEdit(sec, strict, recordMove));
}

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
  const moves: [string, string][] = [];
  const recordMove = (o: string, n: string): void => {
    moves.push([o, n]);
  };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, recordMove)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict, recordMove);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const seenPairs = new Set<string>();
  const rByNew = new Map<string, string>();
  for (const [o, n] of moves) {
    const k = `${o}\n${n}`;
    if (seenPairs.has(k)) continue;
    seenPairs.add(k);
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) rByNew.set(n, o);
  }
  const coveredOld = new Set<string>([...rByNew.values()]);
  const rows: { key: string; text: string }[] = [];
  for (const [n, o] of rByNew) rows.push({ key: n, text: `R ${o} -> ${n}` });
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rByNew.has(p) || coveredOld.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
