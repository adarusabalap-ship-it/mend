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
  /** The moves that succeeded, old path and new path, in the order they were made. */
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

/** `--strict`: only tier 0 is tried when matching lines (SPEC.md section 5). */
let STRICT = false;

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileText {
  lines: string[];
  final: boolean;
  crlf: boolean;
}

function readFileText(text: string): FileText {
  if (text === '') return { lines: [], final: false, crlf: false };
  const nl = text.indexOf('\n');
  const crlf = nl > 0 && text[nl - 1] === '\r';
  const br = crlf ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, final, crlf };
}

function writeFileText(f: FileText): string {
  if (f.lines.length === 0) return '';
  const br = f.crlf ? '\r\n' : '\n';
  return f.lines.join(br) + (f.final ? br : '');
}

/** One line of a new side: `ctx` is its index in O when it is a context line. */
interface PL {
  text: string;
  ctx?: number;
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const trailOff = (s: string): string => s.replace(/[ \t]+$/, '');

/** A line as one matching tier compares it (SPEC.md section 5). */
function atTier(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trailOff(line);
  return trailOff(line.replace(/^[ \t]+/, ''));
}

const TIERS = (): number[] => (STRICT ? [0] : [0, 1, 2]);

/** Every position i where O matches the file's lines i.. at this tier (occurrences may overlap). */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let hit = true;
    for (let k = 0; k < o.length; k += 1) {
      if (atTier(lines[i + k]!, tier) !== atTier(o[k]!, tier)) {
        hit = false;
        break;
      }
    }
    if (hit) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs, and its first occurrence there. */
function firstTier(lines: string[], o: string[], from = 0, atEnd = false): { tier: number; pos: number } | null {
  for (const tier of TIERS()) {
    const occ = occurrences(lines, o, tier, from).filter((p) => !atEnd || p + o.length === lines.length);
    if (occ.length > 0) return { tier, pos: occ[0]! };
  }
  return null;
}

/** The first tier at which O occurs, and its occurrence nearest `target` (the earlier of two equals). */
function nearestTier(lines: string[], o: string[], target: number): { tier: number; pos: number } | null {
  for (const tier of TIERS()) {
    const occ = occurrences(lines, o, tier, 0);
    if (occ.length === 0) continue;
    let best = occ[0]!;
    for (const p of occ) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    return { tier, pos: best };
  }
  return null;
}

/** O's lines occur exactly once at their tier, or the match is ambiguous (SEARCH/REPLACE). */
function uniqueTier(lines: string[], o: string[]): { tier: number; pos: number } | 'ambiguous' | null {
  for (const tier of TIERS()) {
    const occ = occurrences(lines, o, tier, 0);
    if (occ.length === 1) return { tier, pos: occ[0]! };
    if (occ.length > 1) return 'ambiguous';
  }
  return null;
}

/** The first line at or after `from` equal to `anchor` at the first tier that has one (V4A anchors). */
function anchorTier(lines: string[], anchor: string, from: number): number | null {
  for (const tier of TIERS()) {
    for (let i = from; i < lines.length; i += 1) if (atTier(lines[i]!, tier) === atTier(anchor, tier)) return i;
  }
  return null;
}

/** N as the file's lines: context lines keep the file's own, other lines re-indent at tier 2. */
function render(lines: string[], pos: number, o: string[], n: PL[], tier: number): string[] {
  const f = leadWs(lines[pos] ?? '');
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  return n.map((item) => {
    if (item.ctx !== undefined) return lines[pos + item.ctx]!;
    if (tier !== 2 || item.text.trim() === '') return item.text;
    if (!item.text.startsWith(p)) return item.text;
    return f + item.text.slice(p.length);
  });
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, `a/` or `b/` removed. */
function headerPath(rest: string): string {
  const cut = rest.indexOf('\t');
  let p = (cut < 0 ? rest : rest.slice(0, cut)).replace(/^ +| +$/g, '');
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** `--- <old>` and `+++ <new>` before a section's first hunk: which is no file, and the paths. */
interface Header {
  old: string | null;
  new: string | null;
  oldNull: boolean;
  newNull: boolean;
  create: boolean;
  del: boolean;
  touched: boolean;
  /** A `---`/`+++` pair has named this section's paths: a second pair starts a new section. */
  pathsSet: boolean;
}

interface Hunk {
  a: number;
  o: string[];
  n: PL[];
  /** A `\` line followed the hunk's last context or `+` line: no final break. */
  noEol: boolean;
}

/** One unified section: its header, its hunks and the patch line each part came from. */
interface Section {
  header: Header;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The `\` lines of a body: which body line each follows, so the last one can drop a final break. */
function applyHunks(text: FileText, hunks: Hunk[]): void {
  let d = 0;
  for (const h of hunks) {
    const o = h.o;
    const target = h.a - 1 + d;
    let pos = 0;
    let tier = 0;
    if (o.length === 0) {
      // N is inserted after the first A + d lines, all of them when the file has fewer
      pos = Math.min(Math.max(target + 1, 0), text.lines.length);
    } else {
      const found = nearestTier(text.lines, o, target);
      if (found === null) throw new NoMatch();
      pos = found.pos;
      tier = found.tier;
    }
    const written = render(text.lines, pos, o, h.n, tier);
    const atEnd = o.length === 0 ? pos === text.lines.length : pos + o.length === text.lines.length;
    text.lines.splice(pos, o.length, ...written);
    if (atEnd) text.final = !h.noEol;
    d += written.length - o.length;
  }
}

class NoMatch extends Error {}

/** A path an edit names, checked for safety before anything else about it (SPEC.md section 10). */
function checked(p: string): string {
  if (!safe(p)) throw new Fail('unsafe', p);
  return p;
}

interface SectionState {
  cur: Section | null;
  hunk: Hunk | null;
  /** The kind of each body line read so far: a `\` line refers to the one before it. */
  kinds: Array<'ctx' | 'empty' | 'old' | 'new' | 'bs'>;
}

/** The sections of a unified patch, or the 1-based patch line that cannot be read (SPEC.md section 6). */
function unifiedSections(lines: string[]): Section[] | number {
  const sections: Section[] = [];
  const st: SectionState = { cur: null, hunk: null, kinds: [] };
  const newHeader = (): Header => ({ old: null, new: null, oldNull: false, newNull: false, create: false, del: false, touched: false, pathsSet: false });
  const closeHunk = (): void => {
    const hunk = st.hunk;
    if (hunk !== null && st.cur !== null) {
      // empty lines at the end of a body are not part of it
      while (st.kinds.length > 0 && st.kinds[st.kinds.length - 1] === 'empty') {
        hunk.o.pop();
        hunk.n.pop();
        st.kinds.pop();
      }
      // a `\` line after the hunk's last context or `+` line drops the final break
      let last = -1;
      for (let k = st.kinds.length - 1; k >= 0; k -= 1) {
        const kind = st.kinds[k];
        if (kind === 'ctx' || kind === 'empty' || kind === 'new') {
          last = k;
          break;
        }
      }
      hunk.noEol = last >= 0 && st.kinds[last + 1] === 'bs';
      st.cur.hunks.push(hunk);
    }
    st.hunk = null;
    st.kinds = [];
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      closeHunk();
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(l);
      if (m === null) return i + 1;
      const sec: Section = { header: newHeader(), hunks: [] };
      sec.header.old = m[1]!;
      sec.header.new = m[2]!;
      st.cur = sec;
      sections.push(sec);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      closeHunk();
      const h = newHeader();
      const old = headerPath(l.slice(4));
      h.oldNull = old === '/dev/null';
      h.old = h.oldNull ? null : old;
      const nw = headerPath(lines[i + 1]!.slice(4));
      h.newNull = nw === '/dev/null';
      h.new = h.newNull ? null : nw;
      h.touched = true;
      h.pathsSet = true;
      if (st.cur !== null && !st.cur.header.pathsSet && st.cur.hunks.length === 0) {
        // a `---`/`+++` pair inside a section's header: it names this section's paths, and
        // the `new file mode`/`deleted file mode` lines already read still say what it does
        h.create = h.create || st.cur.header.create;
        h.del = h.del || st.cur.header.del;
        st.cur.header = h;
      } else {
        const sec: Section = { header: h, hunks: [] };
        st.cur = sec;
        sections.push(sec);
      }
      i += 2;
      continue;
    }
    if (st.cur !== null && st.cur.hunks.length === 0 && st.hunk === null) {
      const h = st.cur.header;
      // a `rename` pair names the paths only when no `---`/`+++` pair does
      if (l.startsWith('rename from ') && !h.pathsSet) {
        h.old = l.slice(12);
        h.touched = true;
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ') && !h.pathsSet) {
        h.new = l.slice(10);
        h.touched = true;
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        h.create = true;
        h.touched = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        h.del = true;
        h.touched = true;
        i += 1;
        continue;
      }
      if (l.startsWith('--- ')) return i + 2; // the line after it cannot be read
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEADER.exec(l);
      if (m === null) return i + 1;
      if (st.cur === null) return i + 1; // a hunk before any section
      closeHunk();
      st.hunk = { a: Number(m[1]), o: [], n: [], noEol: false };
      st.kinds = [];
      i += 1;
      continue;
    }
    if (st.hunk !== null) {
      const hunk = st.hunk;
      if (l.startsWith(' ')) {
        hunk.o.push(l.slice(1));
        hunk.n.push({ text: l.slice(1), ctx: hunk.o.length - 1 });
        st.kinds.push('ctx');
        i += 1;
        continue;
      }
      if (l === '') {
        hunk.o.push('');
        hunk.n.push({ text: '', ctx: hunk.o.length - 1 });
        st.kinds.push('empty');
        i += 1;
        continue;
      }
      if (l.startsWith('-')) {
        hunk.o.push(l.slice(1));
        st.kinds.push('old');
        i += 1;
        continue;
      }
      if (l.startsWith('+')) {
        hunk.n.push({ text: l.slice(1) });
        st.kinds.push('new');
        i += 1;
        continue;
      }
      if (l.startsWith('\\')) {
        st.kinds.push('bs'); // refers to the body line before it
        i += 1;
        continue;
      }
      closeHunk(); // the body ends at the first other line
    }
    i += 1;
  }
  closeHunk();
  return sections;
}

/** The `+` lines of every hunk, in order, and whether the last of them has no break (a creation). */
function createdLines(sec: Section): { lines: string[]; noEol: boolean } {
  const out: string[] = [];
  let noEol = false;
  for (const hunk of sec.hunks) {
    for (const item of hunk.n) {
      if (item.ctx === undefined) {
        out.push(item.text);
        noEol = false;
      }
    }
    if (hunk.noEol && hunk.n.length > 0 && hunk.n[hunk.n.length - 1]!.ctx === undefined) noEol = true;
  }
  return { lines: out, noEol };
}

/** One unified section as one edit (SPEC.md section 6). */
function unifiedEdit(sec: Section): Edit {
  const h = sec.header;
  const create = h.oldNull || h.create;
  const del = h.newNull || h.del;
  if (create) {
    const p = h.new;
    const made = createdLines(sec);
    return (tree) => {
      if (p === null) throw new Fail('unsafe', '');
      checked(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, made.lines.length === 0 ? '' : made.lines.join('\n') + (made.noEol ? '' : '\n'));
    };
  }
  if (del) {
    const p = h.old;
    return (tree) => {
      if (p === null) throw new Fail('unsafe', '');
      checked(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const oldP = h.old;
  const newP = h.new;
  const move = oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (oldP === null) throw new Fail('unsafe', '');
    checked(oldP);
    if (move) checked(newP!);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (move && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const text = readFileText(before);
    try {
      applyHunks(text, sec.hunks);
    } catch (e) {
      if (e instanceof NoMatch) throw new Fail('no-match', oldP);
      throw e;
    }
    const out = writeFileText(text);
    if (move) {
      tree.now.set(oldP, null);
      tree.now.set(newP!, out);
      tree.moves.push([oldP, newP!]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

/** One SEARCH/REPLACE block: its path, its old and new lines, and the patch line its SEARCH is on. */
interface Block {
  path: string | null;
  o: string[];
  n: string[];
  searchLine: number;
}

/** The blocks of a SEARCH/REPLACE patch, or the 1-based patch line that cannot be read (SPEC.md section 7). */
function searchBlocks(lines: string[]): Block[] | number {
  const blocks: Block[] = [];
  const isSearch = (l: string): boolean => trailOff(l) === '<<<<<<< SEARCH';
  const isDiv = (l: string): boolean => trailOff(l) === '=======';
  const isReplace = (l: string): boolean => trailOff(l) === '>>>>>>> REPLACE';
  const findsPath = (l: string): boolean => {
    if (blank(l)) return false;
    return !l.trim().startsWith('```');
  };
  let i = 0;
  let since = 0; // the line after the previous block's REPLACE, or the start of the patch
  while (i < lines.length) {
    if (!isSearch(lines[i]!)) {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    // the path: the nearest line before the SEARCH line, after the previous block, that is a path
    let path: string | null = null;
    for (let k = i - 1; k >= since; k -= 1) {
      const l = lines[k]!;
      if (findsPath(l)) {
        path = l.trim();
        break;
      }
    }
    // the `=======` and `>>>>>>> REPLACE` lines
    let div = -1;
    let rep = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (div < 0 && isDiv(lines[k]!)) {
        div = k;
        continue;
      }
      if (div >= 0 && isReplace(lines[k]!)) {
        rep = k;
        break;
      }
    }
    if (div < 0 || rep < 0) return searchLine;
    const o = lines.slice(i + 1, div);
    const n = lines.slice(div + 1, rep);
    if (path === null && blocks.length === 0) return searchLine;
    blocks.push({ path: path ?? blocks[blocks.length - 1]!.path, o, n, searchLine });
    i = rep + 1;
    since = i;
  }
  return blocks;
}

/** One SEARCH/REPLACE block as one edit (SPEC.md section 7). */
function blockEdit(b: Block): Edit {
  const p = b.path!;
  const o = b.o;
  const n = b.n;
  if (o.length === 0) {
    return (tree) => {
      checked(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, n.length === 0 ? '' : n.join('\n') + '\n');
    };
  }
  return (tree) => {
    checked(p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const text = readFileText(before);
    const found = uniqueTier(text.lines, o);
    if (found === null) throw new Fail('no-match', p);
    if (found === 'ambiguous') throw new Fail('ambiguous', p);
    const pl: PL[] = n.map((t) => ({ text: t }));
    const written = render(text.lines, found.pos, o, pl, found.tier);
    const atEnd = found.pos + o.length === text.lines.length;
    text.lines.splice(found.pos, o.length, ...written);
    // a replacement that ran to the end of the file keeps the file's final break as it was
    if (atEnd) text.final = text.final;
    tree.now.set(p, writeFileText(text));
  };
}

/** The blocks as edits: a block with no path at all is a parse fault; an unsafe path is an edit's failure. */
function searchEdits(lines: string[]): Block[] | number {
  const blocks = searchBlocks(lines);
  if (typeof blocks === 'number') return blocks;
  for (const b of blocks) if (b.path === null) return b.searchLine;
  return blocks;
}

/** One V4A chunk: its anchor (null when none), O and N, and whether it is anchored to the end. */
interface Chunk {
  anchor: string | null;
  o: string[];
  n: PL[];
  atEnd: boolean;
}

/** One V4A section: what it does, its path, the path it moves to, and its chunks. */
interface V4aSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  to: string | null;
  addLines: string[];
  chunks: Chunk[];
  line: number;
}

const V4A_START = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];

/** The sections of a V4A patch, or the 1-based patch line that cannot be read (SPEC.md section 8). */
function v4aSections(lines: string[]): V4aSection[] | number {
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) if (!blank(lines[i]!)) { first = i; break; }
  if (first < 0) return 1;
  if (lines[first]!.trim() !== '*** Begin Patch') return first + 1;
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) if (!blank(lines[i]!)) { last = i; break; }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') return lines.length + 1;
  // the lines between the two markers, each with the patch line it is on
  const body: Array<{ text: string; at: number }> = [];
  for (let i = first + 1; i < last; i += 1) body.push({ text: lines[i]!, at: i + 1 });
  // split into sections
  const sections: V4aSection[] = [];
  let cur: V4aSection | null = null;
  let curLines: Array<{ text: string; at: number }> = [];
  const flush = (): number | null => {
    if (cur === null) return null;
    // blank lines at the end of a section are not part of it
    while (curLines.length > 0 && blank(curLines[curLines.length - 1]!.text)) curLines.pop();
    const bad = fillSection(cur, curLines);
    cur = null;
    curLines = [];
    return bad;
  };
  for (const item of body) {
    const t = item.text;
    let kind: 'add' | 'del' | 'update' | null = null;
    for (const k of V4A_START) if (t.startsWith(k)) kind = k === V4A_START[0] ? 'add' : k === V4A_START[1] ? 'del' : 'update';
    if (kind !== null) {
      const bad = flush();
      if (bad !== null) return bad;
      const rest = t.slice(V4A_START[kind === 'add' ? 0 : kind === 'del' ? 1 : 2].length);
      cur = { kind, path: rest.replace(/^ +| +$/g, ''), to: null, addLines: [], chunks: [], line: item.at };
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(t)) continue; // blank lines between sections are ignored
      return item.at;
    }
    curLines.push(item);
  }
  const bad = flush();
  if (bad !== null) return bad;
  return sections;
}

/** Read one section's lines into it, or the 1-based patch line that cannot be read. */
function fillSection(sec: V4aSection, body: Array<{ text: string; at: number }>): number | null {
  if (sec.kind === 'add') {
    for (const item of body) {
      const t = item.text;
      if (t.startsWith('+')) sec.addLines.push(t.slice(1));
      else if (t === '') sec.addLines.push('');
      else return item.at;
    }
    return null;
  }
  if (sec.kind === 'del') {
    // a Delete File section has no lines
    return body.length === 0 ? null : body[0]!.at;
  }
  // Update File: an optional `*** Move to:` first, then chunks
  let i = 0;
  if (body.length > 0 && body[0]!.text.startsWith('*** Move to: ')) {
    sec.to = body[0]!.text.slice(13).replace(/^ +| +$/g, '');
    i = 1;
  }
  let chunk: Chunk | null = null;
  let lastWasPlus = false;
  const push = (): void => {
    if (chunk !== null) sec.chunks.push(chunk);
    chunk = null;
  };
  for (; i < body.length; i += 1) {
    const item = body[i]!;
    const t = item.text;
    if (t.startsWith('@@')) {
      push();
      const text = t.slice(2).replace(/^ +| +$/g, '');
      chunk = { anchor: text === '' ? null : text, o: [], n: [], atEnd: false };
      lastWasPlus = false;
      continue;
    }
    if (t === '*** End of File') {
      if (chunk === null) return item.at;
      chunk.atEnd = true;
      push();
      lastWasPlus = false;
      continue;
    }
    if (chunk === null) {
      // the first chunk may start at a body line
      if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
        chunk = { anchor: null, o: [], n: [], atEnd: false };
      } else {
        return item.at;
      }
    }
    const c = chunk;
    if (t.startsWith(' ') || t === '') {
      c.o.push(t.slice(1));
      c.n.push({ text: t.slice(1), ctx: c.o.length - 1 });
      lastWasPlus = false;
    } else if (t.startsWith('-')) {
      c.o.push(t.slice(1));
      lastWasPlus = false;
    } else if (t.startsWith('+')) {
      c.n.push({ text: t.slice(1) });
      lastWasPlus = true;
    } else {
      return item.at;
    }
  }
  push();
  void lastWasPlus;
  if (sec.to === null && sec.chunks.length === 0) return sec.line;
  return null;
}

/** The first occurrence of O at or after `from` at the first tier with one; `atEnd` takes only a last-line one. */
function firstFrom(lines: string[], o: string[], from: number, atEnd: boolean): { tier: number; pos: number } | null {
  for (const tier of TIERS()) {
    const occ = occurrences(lines, o, tier, from).filter((p) => !atEnd || p + o.length === lines.length);
    if (occ.length > 0) return { tier, pos: occ[0]! };
  }
  return null;
}

/** One V4A section as one edit (SPEC.md section 8). */
function v4aEdit(sec: V4aSection): Edit {
  if (sec.kind === 'add') {
    const p = sec.path;
    const made = sec.addLines;
    return (tree) => {
      checked(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, made.length === 0 ? '' : made.join('\n') + '\n');
    };
  }
  if (sec.kind === 'del') {
    const p = sec.path;
    return (tree) => {
      checked(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = sec.path;
  const to = sec.to;
  return (tree) => {
    checked(p);
    if (to !== null) checked(to);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
    const text = readFileText(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const at = anchorTier(text.lines, chunk.anchor, cursor);
        if (at === null) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const o = chunk.o;
      if (o.length === 0) {
        const pos = chunk.atEnd ? text.lines.length : Math.min(cursor, text.lines.length);
        const written = chunk.n.map((item) => item.text);
        text.lines.splice(pos, 0, ...written);
        cursor = pos + written.length;
        continue;
      }
      const found = firstFrom(text.lines, o, cursor, chunk.atEnd);
      if (found === null) throw new Fail('no-match', p);
      const written = render(text.lines, found.pos, o, chunk.n, found.tier);
      text.lines.splice(found.pos, o.length, ...written);
      cursor = found.pos + written.length;
    }
    const out = writeFileText(text);
    if (to !== null) {
      tree.now.set(p, null);
      tree.now.set(to, out);
      tree.moves.push([p, to]);
    } else {
      tree.now.set(p, out);
    }
  };
}

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
  STRICT = strict;
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
    else if (kind === 'unified') {
      const sections = unifiedSections(lines);
      if (typeof sections === 'number') throw new Exit2(`error: parse ${sections}`);
      edits = sections.map(unifiedEdit);
    } else if (kind === 'search-replace') {
      const blocks = searchEdits(lines);
      if (typeof blocks === 'number') throw new Exit2(`error: parse ${blocks}`);
      edits = blocks.map(blockEdit);
    } else if (kind === 'v4a') {
      const sections = v4aSections(lines);
      if (typeof sections === 'number') throw new Exit2(`error: parse ${sections}`);
      edits = sections.map(v4aEdit);
    } else edits = [];
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
  // a move that succeeded prints one `R <old> -> <new>` line in place of that pair's D and A lines
  const moved = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (tree.original(from) === null || tree.original(to) !== null) continue;
    if (tree.now.get(from) !== null || tree.now.get(to) === null) continue;
    moved.add(from);
    moved.add(to);
  }
  const rows: Array<{ sort: string; line: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moved.has(p)) continue;
    rows.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [from, to] of tree.moves) {
    if (!moved.has(to)) continue;
    if (rows.some((r) => r.line === `R ${from} -> ${to}`)) continue;
    rows.push({ sort: to, line: `R ${from} -> ${to}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  for (const row of rows) {
    if (check) continue;
    const m = /^R (.*) -> (.*)$/.exec(row.line);
    if (m !== null) {
      rmSync(m[1]!, { force: true });
      const now = tree.now.get(m[2]!)!;
      if (now !== null) {
        mkdirSync(dirname(m[2]!), { recursive: true });
        writeFileSync(m[2]!, now);
      }
      continue;
    }
    const p = row.sort;
    const now = tree.now.get(p)!;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
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
