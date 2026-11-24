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

/** Move pairs recorded by successful move edits, for the R output lines (section 2). */
const moves: Array<{ old: string; nw: string }> = [];

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

/** A file's lines, its own line break, and whether it ends with one (section 3). */
function fileLines(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    lines.pop();
    final = true;
  }
  return { lines, br, final };
}

function joinFile(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimEnds = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** Line equality at one matching tier (section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimEnds(a) === trimEnds(b);
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2; 0 only when strict) at which o occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NewLine {
  text: string;
  /** Index into O for a context line, null for a line only in N. */
  ctx: number | null;
}

/** The lines that replace a match: a context line is the file's own matched line; at tier 2 the other lines of N
 * are re-indented from O's first line's leading whitespace to the file's first matched line's (section 5). */
function reindent(n: NewLine[], o: string[], file: string[], pos: number, tier: number): string[] {
  if (tier !== 2) return n.map((e) => (e.ctx !== null ? file[pos + e.ctx]! : e.text));
  const f = leadWs(file[pos]!);
  const p = leadWs(o[0]!);
  return n.map((e) => {
    if (e.ctx !== null) return file[pos + e.ctx]!;
    const t = e.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

// ---- Unified diffs (section 6) ----

interface HunkLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  /** True when this context line came from a patch line that was empty. */
  emptyPatch?: boolean;
}

interface Hunk {
  a: number;
  body: HunkLine[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function parseHunkHeader(l: string): { a: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
  if (m === null) return null;
  return { a: Number(m[1]) };
}

function parseHunkBody(lines: string[], start: number): { body: HunkLine[]; end: number } {
  const body: HunkLine[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') { body.push({ kind: 'ctx', text: '', emptyPatch: true }); i++; continue; }
    const c = l[0]!;
    if (c === ' ') { body.push({ kind: 'ctx', text: l.slice(1) }); i++; continue; }
    if (c === '-') { body.push({ kind: 'old', text: l.slice(1) }); i++; continue; }
    if (c === '+') { body.push({ kind: 'new', text: l.slice(1) }); i++; continue; }
    if (c === '\\') { body.push({ kind: 'bs', text: l.slice(1) }); i++; continue; }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.emptyPatch) body.pop();
  return { body, end: i };
}

/** O and N of a hunk body, and whether a backslash line follows its last context or + line. */
function hunkON(body: HunkLine[]): { o: string[]; n: NewLine[]; noNL: boolean } {
  const o: string[] = [];
  const n: NewLine[] = [];
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    const b = body[j]!;
    if (b.kind === 'ctx') { o.push(b.text); n.push({ text: b.text, ctx: o.length - 1 }); last = j; }
    else if (b.kind === 'old') o.push(b.text);
    else if (b.kind === 'new') { n.push({ text: b.text, ctx: null }); last = j; }
  }
  const noNL = last >= 0 && body[last + 1]?.kind === 'bs';
  return { o, n, noNL };
}

/** A ---/+++ path: text after the four characters, up to the first tab, spaces removed, a/ or b/ removed. */
function diffPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, hasPair: false, create: false, del: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const h = parseHunkHeader(l);
      if (h === null) throw new Exit2(`error: parse ${i + 1}`);
      const b = parseHunkBody(lines, i + 1);
      cur.hunks.push({ a: h.a, body: b.body });
      inHeader = false;
      i = b.end;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = diffPath(lines[i]!.slice(4));
      const newP = diffPath(lines[i + 1]!.slice(4));
      if (cur === null || !inHeader || cur.hasPair) {
        cur = { oldPath: oldP === '/dev/null' ? null : oldP, newPath: newP === '/dev/null' ? null : newP, hasPair: true, create: false, del: false, hunks: [] };
        sections.push(cur);
      } else {
        cur.oldPath = oldP === '/dev/null' ? null : oldP;
        cur.newPath = newP === '/dev/null' ? null : newP;
        cur.hasPair = true;
      }
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ') && !cur.hasPair) cur.oldPath = l.slice(12).trim();
      else if (l.startsWith('rename to ') && !cur.hasPair) cur.newPath = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function unifiedSectionEdit(s: USection, strict: boolean): Edit {
  const oldP = s.oldPath;
  const newP = s.newPath;
  const isCreate = s.create || oldP === null;
  const isDelete = s.del || newP === null;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) return;
      const target = newP;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      let noNL = false;
      for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const body = s.hunks[hi]!.body;
        let lastPlus = -1;
        for (let j = 0; j < body.length; j++) if (body[j]!.kind === 'new') lastPlus = j;
        if (lastPlus >= 0) { noNL = body[lastPlus + 1]?.kind === 'bs'; break; }
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      const target = oldP;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const isMove = oldP !== newP;
    const src = oldP!;
    const dst = newP!;
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);
    const f = fileLines(before);
    let lines = f.lines;
    let final = f.final;
    let d = 0;
    for (const h of s.hunks) {
      const { o, n, noNL } = hunkON(h.body);
      if (o.length === 0) {
        const at = Math.min(h.a + d, lines.length);
        const atEnd = at === lines.length;
        const inserted = n.map((e) => e.text);
        lines = [...lines.slice(0, at), ...inserted, ...lines.slice(at)];
        if (atEnd) final = !noNL;
      } else {
        const found = findTier(lines, o, strict);
        if (found === null) throw new Fail('no-match', src);
        const targetPos = h.a - 1 + d;
        let best = found.occ[0]!;
        for (const p of found.occ) {
          if (Math.abs(p - targetPos) < Math.abs(best - targetPos)) best = p;
        }
        const atEnd = best + o.length === lines.length;
        const rep = reindent(n, o, lines, best, found.tier);
        lines = [...lines.slice(0, best), ...rep, ...lines.slice(best + o.length)];
        if (atEnd) final = !noNL;
      }
      d += n.length - o.length;
    }
    const out = joinFile({ lines, br: f.br, final });
    if (isMove) {
      tree.now.set(src, null);
      tree.now.set(dst, out);
      moves.push({ old: src, nw: dst });
    } else {
      tree.now.set(src, out);
    }
  };
}

// ---- SEARCH/REPLACE blocks (section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = fileLines(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const n = newLines.map((t): NewLine => ({ text: t, ctx: null }));
    const rep = reindent(n, oldLines, f.lines, pos, found.tier);
    const lines = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ lines, br: f.br, final: f.final }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let searchFrom = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- V4A patches (section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewLine[];
}

function v4aUpdateEdit(path: string, items: Array<{ text: string; num: number }>, updLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let rest = items;
  if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
    moveTo = rest[0]!.text.slice(13).trim();
    rest = rest.slice(1);
  }
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; body: HunkLine[] } | null = null;
  let afterEof = false;
  const close = (eof: boolean): void => {
    if (cur === null) return;
    const o: string[] = [];
    const n: NewLine[] = [];
    for (const b of cur.body) {
      if (b.kind === 'ctx') { o.push(b.text); n.push({ text: b.text, ctx: o.length - 1 }); }
      else if (b.kind === 'old') o.push(b.text);
      else if (b.kind === 'new') n.push({ text: b.text, ctx: null });
    }
    chunks.push({ anchor: cur.anchor, eof, o, n });
    cur = null;
  };
  for (const it of rest) {
    const t = it.text;
    if (t.startsWith('@@')) {
      close(false);
      afterEof = false;
      cur = { anchor: t.slice(2).trim() || null, body: [] };
      continue;
    }
    if (t.trimEnd() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${it.num}`);
      close(true);
      afterEof = true;
      continue;
    }
    if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
      if (cur === null) {
        if (afterEof) throw new Exit2(`error: parse ${it.num}`);
        cur = { anchor: null, body: [] };
      }
      const kind = t === '' ? 'ctx' : t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'old' : 'new';
      cur.body.push({ kind, text: t === '' ? '' : t.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${it.num}`);
  }
  close(false);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = fileLines(before);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundIdx: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let j = cursor; j < lines.length; j++) {
            if (lineEq(lines[j]!, ch.anchor, t)) { foundIdx = j; break; }
          }
          if (foundIdx !== null) break;
        }
        if (foundIdx === null) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const inserted = ch.n.map((e) => e.text);
        lines = [...lines.slice(0, at), ...inserted, ...lines.slice(at)];
        cursor = at + inserted.length;
      } else {
        const tiers = strict ? [0] : [0, 1, 2];
        let found: { tier: number; pos: number } | null = null;
        for (const t of tiers) {
          const occ = occurrences(lines, ch.o, t).filter((p) => p >= cursor);
          const q = ch.eof ? occ.filter((p) => p + ch.o.length === lines.length) : occ;
          if (q.length > 0) { found = { tier: t, pos: q[0]! }; break; }
        }
        if (found === null) throw new Fail('no-match', path);
        const rep = reindent(ch.n, ch.o, lines, found.pos, found.tier);
        lines = [...lines.slice(0, found.pos), ...rep, ...lines.slice(found.pos + ch.o.length)];
        cursor = found.pos + rep.length;
      }
    }
    const out = joinFile({ lines, br: f.br, final: f.final });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    if (isSectionStart(l)) {
      const kind = l.startsWith('*** Add') ? 'add' : l.startsWith('*** Delete') ? 'del' : 'upd';
      const prefixLen = kind === 'add' ? 14 : 17;
      const path = l.slice(prefixLen).trim();
      const startLine = i + 1;
      const items: Array<{ text: string; num: number }> = [];
      i++;
      while (i < last && !isSectionStart(lines[i]!)) {
        items.push({ text: lines[i]!, num: i + 1 });
        i++;
      }
      while (items.length > 0 && blank(items[items.length - 1]!.text)) items.pop();
      if (kind === 'add') {
        const ls: string[] = [];
        for (const it of items) {
          if (it.text === '') ls.push('');
          else if (it.text.startsWith('+')) ls.push(it.text.slice(1));
          else throw new Exit2(`error: parse ${it.num}`);
        }
        edits.push((tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) !== null) throw new Fail('exists', path);
          tree.now.set(path, ls.length === 0 ? '' : ls.join('\n') + '\n');
        });
      } else if (kind === 'del') {
        for (const it of items) {
          if (!blank(it.text)) throw new Exit2(`error: parse ${it.num}`);
        }
        edits.push((tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) === null) throw new Fail('missing', path);
          tree.now.set(path, null);
        });
      } else {
        edits.push(v4aUpdateEdit(path, items, startLine, strict));
      }
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
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

function run(args: string[]): { code: number; out: string[] } {
  moves.length = 0;
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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? srEdits(lines, strict)
      : v4aEdits(lines, strict);
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
  const outRows: Array<{ key: string; text: string }> = [];
  const covered = new Set<string>();
  const seenR = new Set<string>();
  for (const m of moves) {
    if (tree.original(m.old) === null || tree.original(m.nw) !== null) continue;
    if (tree.get(m.old) !== null || tree.get(m.nw) === null) continue;
    const k = `${m.old}\0${m.nw}`;
    if (seenR.has(k)) continue;
    seenR.add(k);
    outRows.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
    covered.add(m.old);
    covered.add(m.nw);
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    outRows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  outRows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  const texts = outRows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
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
