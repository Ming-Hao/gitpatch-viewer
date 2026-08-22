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

/**
 * Order files take within a directory. Kinds absent from this list sort last,
 * so an unrecognised kind degrades to "at the end" rather than to a crash.
 */
const KIND_ORDER = ['modify', 'add', 'delete', 'rename', 'copy', 'mode', 'binary'];

/**
 * How many group colours the stylesheet defines as --g0..--g5. Directories are
 * numbered in encounter order and take a slot modulo this, so neighbouring
 * directories never land on the same colour.
 */
const GROUP_SLOTS = 6;

/**
 * Line budget for one batch of hunks. An opened file starts at the first batch
 * and grows a batch at a time, so a file that changes tens of thousands of
 * lines costs a few hundred table rows on the click instead of all of them —
 * a generated lockfile can otherwise carry a thousand hunks on its own.
 *
 * Counted in lines rather than hunks because the two are not proportional:
 * twenty three-line hunks and twenty two-hundred-line hunks are two orders of
 * magnitude apart, and only a line budget keeps the cost of a batch even.
 */
const BATCH_LINES = 300;

/**
 * Tooltip copy for the two display controls, keyed by the state in effect.
 * Each entry says what the current setting does, then what pressing the control
 * would do — the second half never just names the other mode, because a name
 * alone leaves the reader to guess the effect.
 */
const CONTROL_COPY = {
  scale: {
    linear: {
      now: 'Bar length is proportional to the number of lines changed.',
      then: 'Click for a logarithmic scale, which keeps small files visible next to very large ones.',
    },
    log: {
      now: 'Bar length grows logarithmically, so files orders of magnitude apart all stay readable.',
      then: 'Click for a linear scale, where length is proportional to the number of lines changed.',
    },
  },
  focus: {
    on: {
      now: 'Hovering a row fades the other directories back.',
      then: 'Click to keep every row at full strength on hover.',
    },
    off: {
      now: 'Every row keeps its full strength when another is hovered.',
      then: 'Click to fade directories other than the one under the pointer.',
    },
  },
};

/* ===========================================================================
   State
   =========================================================================== */

/** Parsed patch, or null when nothing is loaded. Never persisted. */
let model = null;

let prefs = { mode: 'unified', theme: null, focus: true, scale: 'linear' };

/* ===========================================================================
   Utilities
   =========================================================================== */

/** Strips git's `a/` `b/` (and the i/w/c/o/1/2 variants) path prefix. */
function cleanPath(path) {
  if (!path || path === '/dev/null') return null;
  return path.replace(/^[abciwo12]\//, '');
}

/** Directory portion of a path, trailing slash included; '' at the root. */
function dirOf(path) {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut + 1);
}

/** Filename portion of a path. */
function nameOf(path) {
  return path.slice(dirOf(path).length);
}

/** Lowercased extension of a filename, or null when it has none. */
function extOf(path) {
  const name = nameOf(path);
  const cut = name.lastIndexOf('.');
  return cut <= 0 ? null : name.slice(cut + 1).toLowerCase();
}

/** The path a file is filed under: its new path, or its old one once deleted. */
function sortPath(file) {
  return file.newPath || file.oldPath || '';
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
  const files = parsePatch(text)
    .map(buildFile)
    .filter((file) => file.hunks.length || file.oldPath || file.newPath);

  return groupByDirectory(files);
}

/**
 * Returns the files reordered for display and stamped with the group index the
 * list renders from. Directories keep the order the patch introduced them in —
 * git already emits them sorted, and honouring that order keeps the colours
 * stable for a given patch — while the files inside one directory are reordered
 * by kind so modifications lead and renames and binaries trail.
 *
 * The index is assigned here rather than at render time because both the colour
 * and the hover grouping read it, and it must not change between renders.
 */
function groupByDirectory(files) {
  const groups = new Map();
  for (const file of files) {
    const dir = dirOf(sortPath(file));
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(file);
  }

  const rank = (kind) => {
    const index = KIND_ORDER.indexOf(kind);
    return index === -1 ? KIND_ORDER.length : index;
  };

  const ordered = [];
  let group = 0;
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => rank(a.kind) - rank(b.kind) || sortPath(a).localeCompare(sortPath(b)));
    for (const file of bucket) {
      file.group = group;
      ordered.push(file);
    }
    group++;
  }
  return ordered;
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

/**
 * Paths whose rows are currently expanded. Kept outside the DOM so switching
 * between unified and side-by-side can rebuild the open bodies in the new mode
 * instead of collapsing everything.
 */
const expanded = new Set();

/** The largest single-file change in the patch, the full width of a row's bar. */
let maxChange = 0;

/**
 * `*.ts` / `.ts` filters by suffix (so `glob.test.ts` still matches `*.ts`);
 * anything else is a case-insensitive substring against the full path.
 */
function parseFilterQuery(raw) {
  const query = raw.trim().toLowerCase();
  if (!query) return null;
  if (query.startsWith('*.')) return { mode: 'suffix', value: query.slice(1) };
  if (/^\.[a-z0-9]+$/.test(query)) return { mode: 'suffix', value: query };
  return { mode: 'substring', value: query };
}

function fileMatchesFilter(path, parsed) {
  if (!parsed) return true;
  const lower = path.toLowerCase();
  return parsed.mode === 'suffix' ? lower.endsWith(parsed.value) : lower.includes(parsed.value);
}

/**
 * The current patch's extension chips. Rebuilt by renderFilterChips() once per
 * render() — which extensions exist doesn't change while the reader is typing
 * into the filter — and re-measured against the row's width by
 * layoutFilterChips(), whose resize listener is bound once in init() and reads
 * these fresh on every call instead of closing over a stale set.
 */
let filterChipEls = [];
let filterChipsExpanded = false;

function render() {
  const container = document.getElementById('files');
  container.textContent = '';

  const filterStrip = document.getElementById('filter-strip');

  if (!model) {
    filterStrip.hidden = true;
    return;
  }

  filterStrip.hidden = false;

  maxChange = model.reduce((max, file) => Math.max(max, file.additions + file.deletions), 0);

  const list = document.createElement('div');
  list.className = 'file-list';

  for (const file of model) {
    const row = renderRow(file);
    list.appendChild(row);
    // Rebuilding rather than preserving the old body is what makes a mode
    // switch take effect on files the reader already had open. The class has to
    // be restored alongside it, or the row keeps a collapsed twisty and the
    // next click expands a file that is already expanded.
    //
    // A file reopened this way starts at its first batch again: `expanded`
    // records which files are open, not how far into each one the reader got.
    if (expanded.has(sortPath(file))) {
      row.classList.add('is-open');
      row.after(renderBody(file, row));
    }
  }

  wireGroupHover(list);
  container.appendChild(list);

  renderFilterChips();
  applyFilter();
}

/**
 * Rebuilds the extension chip set from the current model, then lays it out.
 * A chip click sets the filter input to `*.ext` (or clears it if that chip is
 * already active) and re-applies the filter.
 */
function renderFilterChips() {
  const counts = new Map();
  for (const file of model) {
    const ext = extOf(sortPath(file));
    if (!ext) continue;
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  filterChipsExpanded = false;
  filterChipEls = sorted.map(([ext, count]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.ext = ext;
    chip.append(`.${ext} `, spanWith('n', String(count)));
    chip.addEventListener('click', () => {
      const input = document.getElementById('filter-input');
      input.value = chip.classList.contains('is-active') ? '' : `*.${ext}`;
      applyFilter();
    });
    return chip;
  });

  layoutFilterChips();
}

function filterChipMoreButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip more';
  button.addEventListener('click', () => {
    filterChipsExpanded = !filterChipsExpanded;
    layoutFilterChips();
  });
  return button;
}

/**
 * Fits as many extension chips as the row's current width allows onto one
 * line, folding the rest behind "+N more" — recomputed on every resize.
 * "Show fewer" / "+N more" is a manual override: once expanded it stays
 * expanded regardless of width, until toggled back.
 */
function layoutFilterChips() {
  const container = document.getElementById('filter-chips');
  container.textContent = '';
  container.classList.toggle('is-expanded', filterChipsExpanded);

  if (!filterChipEls.length) return;

  if (filterChipsExpanded) {
    container.append(...filterChipEls, filterChipMoreButton());
    container.lastChild.textContent = 'Show fewer';
    return;
  }

  const available = container.clientWidth;
  const gap = 6;

  // Measure the "more" button at its widest plausible label so a later,
  // shorter label never lets one extra chip sneak in and then get pushed
  // back out again next resize.
  const more = filterChipMoreButton();
  more.textContent = `+${filterChipEls.length} more`;
  container.appendChild(more);
  const moreWidth = more.getBoundingClientRect().width;
  container.removeChild(more);

  let used = 0;
  let shown = 0;
  for (const chip of filterChipEls) {
    container.appendChild(chip);
    const width = chip.getBoundingClientRect().width;
    const nextUsed = shown === 0 ? width : used + gap + width;
    const remaining = filterChipEls.length - shown - 1;
    const budget = remaining > 0 ? available - gap - moreWidth : available;
    if (nextUsed > budget && shown > 0) {
      container.removeChild(chip);
      break;
    }
    used = nextUsed;
    shown++;
  }

  const hiddenCount = filterChipEls.length - shown;
  if (hiddenCount > 0) {
    more.textContent = `+${hiddenCount} more`;
    container.appendChild(more);
  }
}

/**
 * Hides file rows (and their open bodies, if any) that don't match the filter
 * input, and updates the count and the summary's parenthetical. Runs on every
 * keystroke, so it only toggles `hidden` — it never rebuilds rows.
 *
 * model[i] and the file-list's .file-row children share the same order, since
 * only rows carry that class — an open row's body is a `.file-body` sibling,
 * not a row of its own — so they can be walked in lockstep by index.
 */
function applyFilter() {
  if (!model) return;

  const list = document.querySelector('.file-list');
  const rows = list.querySelectorAll(':scope > .file-row');
  const parsed = parseFilterQuery(document.getElementById('filter-input').value);

  let shownCount = 0;
  let shownAdditions = 0;
  let shownDeletions = 0;

  model.forEach((file, index) => {
    const row = rows[index];
    const hit = fileMatchesFilter(sortPath(file), parsed);
    row.hidden = !hit;
    const body = row.nextElementSibling;
    if (body && body.classList.contains('file-body')) body.hidden = !hit;
    if (hit) {
      shownCount++;
      shownAdditions += file.additions;
      shownDeletions += file.deletions;
    }
  });

  let empty = list.querySelector('.filter-empty');
  if (!empty) {
    empty = document.createElement('div');
    empty.className = 'filter-empty';
    empty.textContent = 'No file matches this filter.';
    list.appendChild(empty);
  }
  empty.hidden = shownCount > 0;

  document.getElementById('filter-count').textContent = parsed
    ? `${shownCount} / ${model.length} files`
    : `${model.length} files`;

  const note = document.getElementById('filter-summary-note');
  if (parsed) {
    note.textContent = '';
    note.append(
      `(${shownCount} shown, `,
      spanWith('plus', `+${shownAdditions}`),
      ' ',
      spanWith('minus', `−${shownDeletions}`),
      ')',
    );
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  const activeExt = parsed && parsed.mode === 'suffix' ? parsed.value.replace(/^\./, '') : null;
  for (const chip of filterChipEls) chip.classList.toggle('is-active', chip.dataset.ext === activeExt);
}

/**
 * One file as a single row. The diff itself is deliberately absent: a file that
 * is never opened costs one row, which is what keeps a patch of a few hundred
 * files from building a DOM the browser struggles to tear down again.
 */
function renderRow(file) {
  const row = document.createElement('div');
  row.className = 'file-row';
  // Pointing at the token rather than a literal colour lets a theme change
  // repaint every rule without rebuilding the list.
  row.style.setProperty('--group', `var(--g${file.group % GROUP_SLOTS})`);
  row.dataset.group = String(file.group);
  // Lets applyScale() re-measure the bar without going back to the model.
  row.dataset.total = String(file.additions + file.deletions);

  row.appendChild(renderRowLayers(file));

  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = '▸';
  row.appendChild(twisty);

  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = KIND_LABEL[file.kind];
  row.appendChild(kind);

  row.appendChild(renderRowPath(file));

  // Empty and hidden until a batch lands; see paintPartial().
  const partial = spanWith('partial', '');
  partial.hidden = true;
  row.appendChild(partial);

  const stat = document.createElement('span');
  stat.className = 'stat';
  stat.append(
    spanWith('plus', `+${file.additions}`),
    ' ',
    spanWith('minus', `−${file.deletions}`),
  );
  row.appendChild(stat);

  row.addEventListener('click', () => toggleFile(row, file));
  return row;
}

/**
 * A row's bar as a percentage of the row's width.
 *
 * Both scales share the same full mark — the largest change in the patch — so
 * the longest bar is full either way and the two modes agree at that end. The
 * logarithmic one exists because a single generated or deleted file of several
 * thousand lines drives every other bar below a pixel: on a linear scale a
 * 24-line change next to a 14000-line one is 0.16% wide, which is nothing.
 *
 * log1p rather than log, so a file with no line changes (a rename, a binary)
 * lands on zero instead of negative infinity.
 */
function barWidth(total) {
  if (!total || !maxChange) return 0;
  if (prefs.scale === 'log') return (Math.log1p(total) / Math.log1p(maxChange)) * 100;
  return (total / maxChange) * 100;
}

/**
 * The bar and the hover veil, wrapped in one negatively stacked container.
 * Because the wrapper carries the z-index, the two layers stack against each
 * other inside it and both stay behind the row's text.
 */
function renderRowLayers(file) {
  const layers = document.createElement('span');
  layers.className = 'layers';

  const total = file.additions + file.deletions;
  const fill = document.createElement('span');
  fill.className = 'fill';
  fill.style.width = `${barWidth(total)}%`;

  // Both sides are flexed by their line counts, so the split within the bar
  // matches the split within the file.
  if (file.additions) {
    const add = document.createElement('span');
    add.className = 'add';
    add.style.flex = String(file.additions);
    fill.appendChild(add);
  }
  if (file.deletions) {
    const del = document.createElement('span');
    del.className = 'del';
    del.style.flex = String(file.deletions);
    fill.appendChild(del);
  }

  layers.appendChild(fill);
  layers.appendChild(spanWith('veil', ''));
  return layers;
}

/** Directory dimmed, filename at full strength, so the name stays findable. */
function renderRowPath(file) {
  const path = document.createElement('span');
  path.className = 'path';

  if (file.kind === 'rename' || file.kind === 'copy') {
    const from = file.oldPath || '';
    const to = file.newPath || '';
    path.append(
      spanWith('dir', dirOf(to)),
      nameOf(from),
      spanWith('arrow', ' → '),
      nameOf(to),
    );
    return path;
  }

  const full = sortPath(file) || '(unknown)';
  path.append(spanWith('dir', dirOf(full)), nameOf(full));
  return path;
}

/**
 * How many hunks starting at `from` fit in one batch. Always at least one, so a
 * single hunk larger than the whole budget still makes progress rather than
 * leaving the button with nothing to add.
 */
function batchSize(hunks, from) {
  let lines = 0;
  let count = 0;

  while (from + count < hunks.length) {
    lines += hunks[from + count].lines.length;
    count++;
    if (lines >= BATCH_LINES) break;
  }

  return count;
}

function countLines(hunks) {
  return hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
}

/**
 * Counts in the batch footer land on one often enough to be worth spelling:
 * the last step of a long file is regularly a single hunk, and a hunk over the
 * whole line budget makes a batch of one.
 */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Builds the diff for one file, a batch of hunks at a time. Only ever called
 * from a click, or from render() rebuilding a row that was already open.
 *
 * `row` is the file row this body belongs under. It carries the pill saying how
 * much of the file is on screen, which is repainted from here as batches land.
 */
function renderBody(file, row) {
  const body = document.createElement('div');
  body.className = 'file-body';

  if (!file.hunks.length) {
    body.appendChild(renderFileNote(file));
    return body;
  }

  const scroll = document.createElement('div');
  scroll.className = 'diff-scroll';

  // One table filled repeatedly rather than a table per batch: table.diff is
  // `width: max-content`, so each table would size its columns against its own
  // rows and the line numbers would step at every batch boundary.
  const table = document.createElement('table');
  table.className = prefs.mode === 'split' ? 'diff split' : 'diff unified';
  scroll.appendChild(table);
  body.appendChild(scroll);

  const append = prefs.mode === 'split' ? appendSplitHunks : appendUnifiedHunks;
  const total = file.hunks.length;
  const totalLines = countLines(file.hunks);

  const bar = document.createElement('div');
  bar.className = 'file-more';
  let done = 0;
  let doneLines = 0;

  const advance = (all) => {
    const take = all ? total - done : batchSize(file.hunks, done);
    const batch = file.hunks.slice(done, done + take);
    append(table, batch);
    done += take;
    doneLines += countLines(batch);
    paintMore();
  };

  function paintMore() {
    bar.textContent = '';
    paintPartial(row, done, total);

    // The whole file is rendered, so the bar has nothing left to offer.
    if (done >= total) {
      bar.remove();
      return;
    }

    bar.append(
      spanWith('count', `${done} of ${plural(total, 'hunk')} · ${doneLines} of ${plural(totalLines, 'line')}`),
      spanWith('spacer', ''),
    );

    const next = batchSize(file.hunks, done);
    const remaining = total - done;

    // One more batch would finish the file, so two buttons would do the same
    // thing as each other.
    if (next >= remaining) {
      bar.appendChild(moreButton(`Show remaining ${plural(remaining, 'hunk')}`, () => advance(true)));
      return;
    }

    bar.append(
      moreButton(`Show next ${plural(next, 'hunk')}`, () => advance(false)),
      // The figure is the point: the escape hatch states its own cost rather
      // than leaving the reader to discover it by freezing the page.
      moreButton(`Show all (${plural(totalLines - doneLines, 'more line')})`, () => advance(true), true),
    );
  }

  body.appendChild(bar);
  advance(false);
  return body;
}

function moreButton(label, onClick, quiet) {
  const button = document.createElement('button');
  button.className = quiet ? 'more-btn' : 'more-btn is-primary';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

/**
 * The pill on the file row saying how much of the file is on screen, so a
 * partly opened file says so where the reader is looking rather than only at
 * the foot of a diff they have to scroll to reach.
 *
 * Hidden once everything is rendered: a pill reading "1028 / 1028" is noise,
 * and its absence is what "all of it" means.
 */
function paintPartial(row, done, total) {
  const pill = row.querySelector('.partial');
  if (!pill) return;

  if (done >= total) {
    pill.hidden = true;
    return;
  }

  pill.textContent = '';
  pill.append('partial ', spanWith('value', `${done} / ${total}`), ' hunks');
  // Read by .partial's gradient, which explains why it is a percentage.
  pill.style.setProperty('--progress', `${(done / total) * 100}%`);
  pill.hidden = false;
}

/**
 * Expands or collapses one row. Collapsing discards the diff rather than hiding
 * it, so opening many files in turn does not accumulate DOM.
 */
function toggleFile(row, file) {
  const key = sortPath(file);
  const body = row.nextElementSibling;

  if (expanded.has(key)) {
    expanded.delete(key);
    row.classList.remove('is-open');
    // The batches go with the body, so the pill has nothing left to report.
    const pill = row.querySelector('.partial');
    if (pill) pill.hidden = true;
    if (body && body.classList.contains('file-body')) body.remove();
    return;
  }

  expanded.add(key);
  row.classList.add('is-open');
  row.after(renderBody(file, row));
}

/**
 * Marks every row sharing the pointed-at row's directory, which the stylesheet
 * uses to thicken that group's rules and fade the rest. One delegated pair of
 * listeners rather than two per row, which matters at a few hundred files.
 */
function wireGroupHover(list) {
  const rows = () => list.querySelectorAll('.file-row');

  list.addEventListener('mouseover', (event) => {
    const target = event.target.closest('.file-row');
    if (!target) return;
    for (const row of rows()) {
      row.classList.toggle('in-group', row.dataset.group === target.dataset.group);
    }
  });

  list.addEventListener('mouseleave', () => {
    for (const row of rows()) row.classList.remove('in-group');
  });
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

/** Appends one batch of hunks to a unified table that already exists. */
function appendUnifiedHunks(table, hunks) {
  for (const hunk of hunks) {
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
}

/** Appends one batch of hunks to a side-by-side table that already exists. */
function appendSplitHunks(table, hunks) {
  for (const hunk of hunks) {
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

  // Paths from the previous patch mean nothing in this one, and leaving them
  // would silently expand whichever files happened to share a path.
  expanded.clear();
  document.getElementById('filter-input').value = '';

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
  expanded.clear();
  document.getElementById('intro').hidden = false;
  document.getElementById('reset-btn').hidden = true;
  document.getElementById('error').hidden = true;
  document.getElementById('paste-area').value = '';
  document.getElementById('filter-input').value = '';
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
  const totals = document.getElementById('summary-totals');

  if (!model) {
    box.hidden = true;
    totals.textContent = '';
    return;
  }

  const additions = model.reduce((sum, file) => sum + file.additions, 0);
  const deletions = model.reduce((sum, file) => sum + file.deletions, 0);

  // Only the totals span is rewritten. Clearing the bar itself would take the
  // controls that sit alongside them with it.
  totals.textContent = '';
  totals.append(
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
    if (typeof stored.focus === 'boolean') prefs.focus = stored.focus;
    if (stored.scale === 'linear' || stored.scale === 'log') prefs.scale = stored.scale;
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
/**
 * Fills in the build figures the toolbar shows and points the GitHub link at
 * whatever those figures name.
 *
 * The three __APP_*__ values are substituted by esbuild --define in the build
 * and dev scripts; they do not exist as identifiers at runtime. The version
 * comes from package.json, the hash from HEAD, and the flag records whether
 * HEAD carries the tag named after that version. None has a copy in the source
 * that could drift.
 *
 * A build standing anywhere other than on its own tag is not the release it
 * claims: the code has moved on, or was never tagged at all. The version says
 * so with a +dev suffix, which is why the suffix hangs off the version rather
 * than the hash — the hash is accurate either way, it is the "this is 1.2.1"
 * claim that is not.
 *
 * The suffix is build metadata (+) rather than a pre-release (-) because such a
 * build almost always sits after the tag, not before it: package.json is bumped
 * and tagged together, so the untagged commits are the ones that follow. A -dev
 * suffix would order this build below the release it has already passed.
 *
 * The link follows the same split, so what is shown and what is linked always
 * agree: a tagged build goes to the tag's page, any other build to the commit
 * it was actually cut from.
 *
 * Outside a git checkout — a source tarball, some CI images — the hash comes
 * back empty. It then stays hidden and the link keeps the repository root that
 * index.html ships with, which is the one destination always known to exist.
 */
function showBuildInfo() {
  const tagged = Boolean(__APP_TAGGED__);

  document.getElementById('app-version').textContent =
    tagged ? __APP_VERSION__ : `${__APP_VERSION__}+dev`;

  if (!__APP_COMMIT__) return;

  const hash = document.getElementById('app-commit');
  hash.textContent = __APP_COMMIT__;
  hash.hidden = false;

  const link = document.getElementById('repo-link');
  const repo = link.getAttribute('href');
  link.href = tagged
    ? `${repo}/releases/tag/v${__APP_VERSION__}`
    : `${repo}/commit/${__APP_COMMIT__}`;
}

function effectiveTheme() {
  if (prefs.theme) return prefs.theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  if (prefs.theme) document.documentElement.dataset.theme = prefs.theme;
  else delete document.documentElement.dataset.theme;

  const current = effectiveTheme();
  const button = document.getElementById('theme-toggle');

  // The half naming the current theme is split off into a .lbl-wide span, so a
  // narrow toolbar can drop it and leave "Theme" standing alone. The title says
  // what pressing the button does either way, which is what survives best.
  const state = document.createElement('span');
  state.className = 'lbl-wide';
  state.textContent = current === 'dark' ? ': Dark' : ': Light';

  button.textContent = 'Theme';
  button.append(state);
  button.title = `Switch to ${current === 'dark' ? 'light' : 'dark'} theme`;
}

function applyMode() {
  for (const button of document.querySelectorAll('#view-toggle button')) {
    button.classList.toggle('is-active', button.dataset.mode === prefs.mode);
  }
}

/**
 * Labels one display control and fills its tooltip. The label keeps the value
 * in bold after a fixed caption, so the two controls line up as a pair and the
 * current setting is readable without opening anything.
 */
function paintControl(id, caption, value, copy) {
  const button = document.getElementById(id);
  button.textContent = '';
  button.append(`${caption}: `, spanWith('value', value));

  const tip = button.parentElement.querySelector('.tip');
  tip.querySelector('.tip-now').textContent = copy.now;
  tip.querySelector('.tip-then').textContent = copy.then;
}

/**
 * Whether hovering a row fades the other directories back. The flag lives on
 * <body> rather than on the list, because render() replaces the list on every
 * view change and would drop the state with it. Being a class also means
 * toggling it repaints without rebuilding a few hundred rows.
 */
function applyFocus() {
  document.body.classList.toggle('group-focus', prefs.focus);

  const button = document.getElementById('focus-toggle');
  button.setAttribute('aria-pressed', String(prefs.focus));
  paintControl('focus-toggle', 'Focus', prefs.focus ? 'On' : 'Off', CONTROL_COPY.focus[prefs.focus ? 'on' : 'off']);
}

/**
 * Re-measures every bar in place rather than re-rendering. A few hundred width
 * changes are far cheaper than rebuilding the list, and any file the reader has
 * open keeps its diff.
 */
function applyScale() {
  paintControl(
    'scale-toggle',
    'Scale',
    prefs.scale === 'log' ? 'Log' : 'Linear',
    CONTROL_COPY.scale[prefs.scale],
  );

  for (const row of document.querySelectorAll('.file-row')) {
    row.querySelector('.fill').style.width = `${barWidth(Number(row.dataset.total))}%`;
  }
}

function init() {
  loadPrefs();
  showBuildInfo();
  applyTheme();
  applyMode();
  applyFocus();
  applyScale();

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

  document.getElementById('filter-input').addEventListener('input', applyFilter);

  document.getElementById('filter-clear').addEventListener('click', () => {
    const input = document.getElementById('filter-input');
    input.value = '';
    applyFilter();
    input.focus();
  });

  // Bound once here rather than inside renderFilterChips(), which runs on
  // every render() — a listener added there would stack a duplicate on every
  // mode switch. layoutFilterChips() reads filterChipEls fresh each call, so
  // a later render() swapping that set in takes effect without a new binding.
  window.addEventListener('resize', layoutFilterChips);

  document.getElementById('view-toggle').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    prefs.mode = button.dataset.mode;
    savePrefs();
    applyMode();
    render();
  });

  // No render() in either of these: the fade is pure CSS, and the scale only
  // rewrites widths on rows that already exist.
  document.getElementById('focus-toggle').addEventListener('click', () => {
    prefs.focus = !prefs.focus;
    savePrefs();
    applyFocus();
  });

  document.getElementById('scale-toggle').addEventListener('click', () => {
    prefs.scale = prefs.scale === 'log' ? 'linear' : 'log';
    savePrefs();
    applyScale();
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
