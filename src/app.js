import { parsePatch, diffWordsWithSpace, diffArrays } from 'diff';
import './style.css';

/* ===========================================================================
   Constants
   =========================================================================== */

/**
 * Minimum similarity for two lines in a -/+ run to be treated as "the same
 * line, edited" rather than an unrelated delete plus insert. Below this the
 * lines are rendered as a plain removal and addition with no word-level
 * highlight, which avoids emitting misleading noise.
 *
 * The value is a judgement call and is expected to need tuning against real
 * patches.
 */
const PAIR_THRESHOLD = 0.5;

const PREFS_KEY = 'gitpatch-viewer:prefs';

const KIND_LABEL = {
  add: 'added',
  delete: 'deleted',
  rename: 'renamed',
  copy: 'copied',
  mode: 'mode',
  binary: 'binary',
  modify: 'modified',
};

/* ===========================================================================
   State
   =========================================================================== */

/** Parsed patch, or null when nothing is loaded. Never persisted. */
let model = null;

let prefs = { mode: 'unified', theme: null };

/* ===========================================================================
   Utilities
   =========================================================================== */

/** Strips git's `a/` `b/` (and the i/w/c/o/1/2 variants) path prefix. */
function cleanPath(path) {
  if (!path || path === '/dev/null') return null;
  return path.replace(/^[abciwo12]\//, '');
}

/**
 * Splits a line into identifier / whitespace / punctuation tokens. Used for
 * the similarity score only; word-level highlighting uses jsdiff's own
 * tokenizer.
 */
function tokenize(text) {
  return text.match(/[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/g) || [];
}

/**
 * Dice coefficient over token multisets, in [0, 1]. Order-insensitive, which
 * suits reordered arguments and rewrapped expressions.
 */
function similarity(a, b) {
  if (a === b) return 1;

  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.length && !tb.length) return 1;
  if (!ta.length || !tb.length) return 0;

  const remaining = new Map();
  for (const token of ta) remaining.set(token, (remaining.get(token) || 0) + 1);

  let common = 0;
  for (const token of tb) {
    const count = remaining.get(token);
    if (count > 0) {
      common++;
      remaining.set(token, count - 1);
    }
  }

  return (2 * common) / (ta.length + tb.length);
}

/* ===========================================================================
   Layer 2 — parse and post-process
   =========================================================================== */

function buildModel(text) {
  // parsePatch yields an entry for every stretch of input it walks, including
  // one for trailing prose and one for input that holds no diff at all, so an
  // empty result never signals "not a patch". An entry with neither hunks nor
  // paths carries nothing; the hunkless kinds that do mean something (mode,
  // rename, copy, binary) all still carry paths.
  return parsePatch(text)
    .map(buildFile)
    .filter((file) => file.hunks.length || file.oldPath || file.newPath);
}

function buildFile(file) {
  const oldPath = cleanPath(file.oldFileName);
  const newPath = cleanPath(file.newFileName);
  const hunks = file.hunks.map(buildHunk);

  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') additions++;
      else if (line.type === 'del') deletions++;
    }
  }

  return {
    oldPath,
    newPath,
    kind: classify(file, oldPath, newPath),
    oldMode: file.oldMode,
    newMode: file.newMode,
    hunks,
    additions,
    deletions,
  };
}

function classify(file, oldPath, newPath) {
  if (file.isBinary) return 'binary';
  if (file.isRename) return 'rename';
  if (file.isCopy) return 'copy';
  if (file.isCreate || !oldPath) return 'add';
  if (file.isDelete || !newPath) return 'delete';
  if (!file.hunks.length && file.oldMode && file.newMode) return 'mode';
  return 'modify';
}

/**
 * Turns a raw hunk into positioned lines, then pairs its -/+ runs so that both
 * views share one set of word-level highlights.
 */
function buildHunk(hunk) {
  const lines = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;

  for (const raw of hunk.lines) {
    // An empty string is a context line whose content is empty.
    const prefix = raw.charAt(0) || ' ';
    const text = raw.slice(1);

    // "\ No newline at end of file" annotates the line above it rather than
    // being a line of its own.
    if (prefix === '\\') {
      const previous = lines[lines.length - 1];
      if (previous) previous.noNewline = true;
      continue;
    }

    if (prefix === '+') lines.push({ type: 'add', text, newNo: newNo++ });
    else if (prefix === '-') lines.push({ type: 'del', text, oldNo: oldNo++ });
    else lines.push({ type: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
  }

  return {
    header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    lines,
    rows: pairLines(lines),
  };
}

/* ===========================================================================
   Layer 3 — pair removed lines with added lines
   =========================================================================== */

/**
 * Walks the hunk and turns it into side-by-side rows. Paired lines also get
 * their word-level segments attached here, so the unified view can reuse them.
 */
function pairLines(lines) {
  const rows = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].type === 'ctx') {
      rows.push({ left: lines[i], right: lines[i], kind: 'ctx' });
      i++;
      continue;
    }

    const removed = [];
    const added = [];
    while (i < lines.length && lines[i].type === 'del') removed.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') added.push(lines[i++]);

    rows.push(...pairRun(removed, added));
  }

  return rows;
}

function pairRun(removed, added) {
  if (!removed.length) return added.map((line) => ({ left: null, right: line, kind: 'add' }));
  if (!added.length) return removed.map((line) => ({ left: line, right: null, kind: 'del' }));

  // Reduce pairing to a Myers diff over the two runs, where "equal" means
  // "similar enough to be the same line". The common parts of the result are
  // the pairs, matched in order.
  const parts = diffArrays(removed, added, {
    comparator: (a, b) => similarity(a.text, b.text) >= PAIR_THRESHOLD,
  });

  const rows = [];
  let r = 0;
  let a = 0;

  for (const part of parts) {
    const count = part.value.length;

    if (part.removed) {
      for (let k = 0; k < count; k++) {
        rows.push({ left: removed[r++], right: null, kind: 'del' });
      }
    } else if (part.added) {
      for (let k = 0; k < count; k++) {
        rows.push({ left: null, right: added[a++], kind: 'add' });
      }
    } else {
      for (let k = 0; k < count; k++) {
        const left = removed[r++];
        const right = added[a++];
        attachSegments(left, right);
        rows.push({ left, right, kind: 'change' });
      }
    }
  }

  return rows;
}

/* ===========================================================================
   Layer 4 — word-level differences
   =========================================================================== */

/**
 * Computes the word-level diff of a paired line once and stores each side's
 * segments on its line, so unified and side-by-side stay consistent.
 *
 * `diffWordsWithSpace` is used rather than `diffWords` because the latter
 * ignores whitespace, which would leave indent-only edits with no highlight
 * at all.
 */
function attachSegments(left, right) {
  const parts = diffWordsWithSpace(left.text, right.text);
  const leftSegments = [];
  const rightSegments = [];

  for (const part of parts) {
    if (part.added) {
      rightSegments.push({ text: part.value, changed: true });
    } else if (part.removed) {
      leftSegments.push({ text: part.value, changed: true });
    } else {
      leftSegments.push({ text: part.value, changed: false });
      rightSegments.push({ text: part.value, changed: false });
    }
  }

  left.segments = leftSegments;
  right.segments = rightSegments;
}

/* ===========================================================================
   Layer 5 — rendering
   =========================================================================== */

function render() {
  const container = document.getElementById('files');
  container.textContent = '';

  if (!model) return;

  for (const file of model) {
    container.appendChild(renderFile(file));
  }
}

function renderFile(file) {
  const section = document.createElement('section');
  section.className = 'file';

  section.appendChild(renderFileHead(file));

  const body = document.createElement('div');
  body.className = 'file-body';

  if (file.hunks.length) {
    const scroll = document.createElement('div');
    scroll.className = 'diff-scroll';
    scroll.appendChild(
      prefs.mode === 'split' ? renderSplitTable(file) : renderUnifiedTable(file),
    );
    body.appendChild(scroll);
  } else {
    body.appendChild(renderFileNote(file));
  }

  section.appendChild(body);
  return section;
}

function renderFileHead(file) {
  const head = document.createElement('header');
  head.className = 'file-head';

  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = '▾';
  head.appendChild(twisty);

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = KIND_LABEL[file.kind];
  head.appendChild(badge);

  const path = document.createElement('span');
  path.className = 'path';
  if (file.kind === 'rename' || file.kind === 'copy') {
    path.append(file.oldPath || '', spanWith('arrow', ' → '), file.newPath || '');
  } else {
    path.textContent = file.newPath || file.oldPath || '(unknown)';
  }
  head.appendChild(path);

  const stat = document.createElement('span');
  stat.className = 'stat';
  stat.append(
    spanWith('plus', `+${file.additions}`),
    ' ',
    spanWith('minus', `−${file.deletions}`),
  );
  head.appendChild(stat);

  head.addEventListener('click', () => {
    head.parentElement.classList.toggle('is-collapsed');
  });

  return head;
}

/** Files with no hunks still carry meaning: explain them instead of a blank. */
function renderFileNote(file) {
  const note = document.createElement('div');
  note.className = 'file-note';

  if (file.kind === 'binary') {
    note.textContent = 'Binary file — content not shown.';
  } else if (file.kind === 'rename') {
    note.textContent = 'File renamed with no content change.';
  } else if (file.kind === 'copy') {
    note.textContent = 'File copied with no content change.';
  } else if (file.kind === 'mode') {
    note.append('File mode changed from ');
    note.appendChild(codeWith(file.oldMode));
    note.append(' to ');
    note.appendChild(codeWith(file.newMode));
    note.append('.');
  } else {
    note.textContent = 'No content change.';
  }

  return note;
}

function renderUnifiedTable(file) {
  const table = document.createElement('table');
  table.className = 'diff unified';

  for (const hunk of file.hunks) {
    table.appendChild(hunkRow(hunk.header, 3));

    // Unified keeps the patch's own line order; pairing only supplies the
    // word-level segments.
    for (const line of hunk.lines) {
      const tr = document.createElement('tr');
      tr.appendChild(numCell(line.oldNo, line.type));
      tr.appendChild(numCell(line.newNo, line.type));
      tr.appendChild(codeCell(line, line.type));
      table.appendChild(tr);
    }
  }

  return table;
}

function renderSplitTable(file) {
  const table = document.createElement('table');
  table.className = 'diff split';

  for (const hunk of file.hunks) {
    table.appendChild(hunkRow(hunk.header, 4));

    for (const row of hunk.rows) {
      const tr = document.createElement('tr');
      const leftType = row.left ? (row.kind === 'ctx' ? 'ctx' : 'del') : null;
      const rightType = row.right ? (row.kind === 'ctx' ? 'ctx' : 'add') : null;

      tr.appendChild(numCell(row.left && row.left.oldNo, leftType));
      tr.appendChild(codeCell(row.left, leftType));

      const rightNum = numCell(row.right && row.right.newNo, rightType);
      rightNum.classList.add('right');
      tr.appendChild(rightNum);
      tr.appendChild(codeCell(row.right, rightType));

      table.appendChild(tr);
    }
  }

  return table;
}

function hunkRow(header, span) {
  const tr = document.createElement('tr');
  tr.className = 'hunk';
  const td = document.createElement('td');
  td.colSpan = span;
  td.textContent = header;
  tr.appendChild(td);
  return tr;
}

function numCell(value, type) {
  const td = document.createElement('td');
  td.className = 'num';
  if (type === 'add' || type === 'del') td.classList.add(type);
  td.textContent = value == null ? '' : String(value);
  return td;
}

function codeCell(line, type) {
  const td = document.createElement('td');
  td.className = 'code';

  if (!line) {
    td.classList.add('filler');
    return td;
  }

  if (type === 'add' || type === 'del') td.classList.add(type);

  const marker = type === 'add' ? '+' : type === 'del' ? '-' : ' ';
  td.appendChild(document.createTextNode(marker));

  const segments = line.segments || [{ text: line.text, changed: false }];
  for (const segment of segments) appendSegment(td, segment);

  if (line.noNewline) {
    const note = document.createElement('span');
    note.className = 'nonewline';
    note.textContent = ' ⏎ no newline at end of file';
    td.appendChild(note);
  }

  return td;
}

/**
 * Appends one word-level segment. Whitespace inside a changed segment gets its
 * own marker so indent-only edits are visible; the text itself is untouched so
 * copying still yields the original line.
 */
function appendSegment(parent, segment) {
  if (!segment.changed) {
    parent.appendChild(document.createTextNode(segment.text));
    return;
  }

  const mark = document.createElement('span');
  mark.className = 'seg';

  for (const piece of segment.text.split(/(\s+)/)) {
    if (!piece) continue;
    if (/^\s+$/.test(piece)) {
      const ws = document.createElement('span');
      ws.className = 'ws';
      ws.textContent = piece;
      mark.appendChild(ws);
    } else {
      mark.appendChild(document.createTextNode(piece));
    }
  }

  parent.appendChild(mark);
}

function spanWith(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function codeWith(text) {
  const code = document.createElement('code');
  code.textContent = text || '';
  return code;
}

/* ===========================================================================
   Layer 1 — loading
   =========================================================================== */

function load(text) {
  const errorBox = document.getElementById('error');
  errorBox.hidden = true;
  errorBox.textContent = '';

  // TEMPORARY: measuring where load time goes. Remove once decided.
  const t0 = performance.now();

  let parsed;
  try {
    parsed = buildModel(text);
  } catch (error) {
    model = null;
    render();
    showSummary();
    showError('Could not parse this patch.', error.message);
    document.getElementById('intro').hidden = false;
    document.getElementById('reset-btn').hidden = true;
    return;
  }

  if (!parsed.length) {
    model = null;
    render();
    showSummary();
    showError('No diff found in this file.', 'Expected a line starting with "diff --git" or "--- ".');
    document.getElementById('intro').hidden = false;
    document.getElementById('reset-btn').hidden = true;
    return;
  }

  const t1 = performance.now();

  model = parsed;
  document.getElementById('intro').hidden = true;
  document.getElementById('reset-btn').hidden = false;
  render();
  showSummary();

  const lines = model.reduce(
    (sum, file) => sum + file.hunks.reduce((n, hunk) => n + hunk.lines.length, 0),
    0,
  );
  console.log(
    `${model.length} files, ${lines} lines — ` +
      `model ${(t1 - t0).toFixed(0)}ms, render ${(performance.now() - t1).toFixed(0)}ms`,
  );
}

function reset() {
  model = null;
  document.getElementById('intro').hidden = false;
  document.getElementById('reset-btn').hidden = true;
  document.getElementById('error').hidden = true;
  document.getElementById('paste-area').value = '';
  render();
  showSummary();
}

function showError(message, detail) {
  const box = document.getElementById('error');
  box.textContent = message;
  if (detail) {
    const pre = document.createElement('pre');
    pre.textContent = detail;
    box.appendChild(pre);
  }
  box.hidden = false;
}

function showSummary() {
  const box = document.getElementById('summary');

  if (!model) {
    box.hidden = true;
    box.textContent = '';
    return;
  }

  const additions = model.reduce((sum, file) => sum + file.additions, 0);
  const deletions = model.reduce((sum, file) => sum + file.deletions, 0);

  box.textContent = '';
  box.append(
    `${model.length} file${model.length === 1 ? '' : 's'} changed`,
    spanWith('plus', `+${additions}`),
    spanWith('minus', `−${deletions}`),
  );
  box.hidden = false;
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => load(String(reader.result));
  reader.onerror = () => showError('Could not read that file.', String(reader.error));
  reader.readAsText(file);
}

/* ===========================================================================
   Layer 6 — preferences and UI wiring
   =========================================================================== */

function loadPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (stored.mode === 'unified' || stored.mode === 'split') prefs.mode = stored.mode;
    if (stored.theme === 'light' || stored.theme === 'dark') prefs.theme = stored.theme;
  } catch {
    // Corrupt or unavailable storage is not worth surfacing; defaults apply.
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private browsing and full quotas both land here; preferences are
    // optional, so failing to persist them is not an error worth showing.
  }
}

/** The theme actually in effect, resolving the unset case against the system. */
function effectiveTheme() {
  if (prefs.theme) return prefs.theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  if (prefs.theme) document.documentElement.dataset.theme = prefs.theme;
  else delete document.documentElement.dataset.theme;

  const current = effectiveTheme();
  const button = document.getElementById('theme-toggle');
  button.textContent = current === 'dark' ? 'Theme: Dark' : 'Theme: Light';
  button.title = `Switch to ${current === 'dark' ? 'light' : 'dark'} theme`;
}

function applyMode() {
  for (const button of document.querySelectorAll('#view-toggle button')) {
    button.classList.toggle('is-active', button.dataset.mode === prefs.mode);
  }
}

function init() {
  loadPrefs();
  applyTheme();
  applyMode();

  document.getElementById('file-input').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) readFile(file);
    event.target.value = '';
  });

  document.getElementById('paste-btn').addEventListener('click', () => {
    const text = document.getElementById('paste-area').value;
    if (text.trim()) load(text);
  });

  document.getElementById('reset-btn').addEventListener('click', reset);

  document.getElementById('view-toggle').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    prefs.mode = button.dataset.mode;
    savePrefs();
    applyMode();
    render();
  });

  document.getElementById('theme-toggle').addEventListener('click', () => {
    prefs.theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
    savePrefs();
    applyTheme();
  });

  // While no explicit choice is stored the page follows the system, so the
  // label has to follow it too.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!prefs.theme) applyTheme();
  });

  wireDragAndDrop();
}

function wireDragAndDrop() {
  const overlay = document.getElementById('drop-overlay');
  let depth = 0;

  document.addEventListener('dragenter', (event) => {
    event.preventDefault();
    depth++;
    overlay.hidden = false;
  });

  document.addEventListener('dragover', (event) => event.preventDefault());

  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });

  document.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    overlay.hidden = true;

    const file = event.dataTransfer.files[0];
    if (file) readFile(file);
  });
}

init();
