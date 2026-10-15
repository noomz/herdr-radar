'use strict';

// The plugin's own config file, and the glyph/behaviour choices read out of it.
//
// Herdr hands plugin commands HERDR_PLUGIN_CONFIG_DIR; config.toml inside it is
// optional and every key has a default, so a missing or malformed file degrades
// to upstream behaviour rather than failing.

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');

// A subset TOML reader: scalars and one level of `[table]`. The file this parses
// is a handful of keys the user writes by hand, so a dependency-free reader is
// worth more than full spec coverage — and Node ships no TOML parser.

// Everything before the first `#` that is not inside a quoted string. A
// quoted value may contain `#` — every hex colour does.
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

// A one-line array of quoted strings: `["a", 'b']`. Anything else between the
// brackets — a number, a bare word, a nested array — makes the whole value
// unreadable rather than half-read, and the setting falls back to its default.
function parseStringArray(inner) {
  const items = [];
  const item = /\s*(?:"([^"]*)"|'([^']*)')\s*(,|$)/y;
  while (item.lastIndex < inner.length) {
    const start = item.lastIndex;
    const m = item.exec(inner);
    if (!m) return inner.slice(start).trim() ? null : items;
    items.push(m[1] ?? m[2]);
    if (!m[3]) break;
  }
  return items;
}

function parseToml(text) {
  const root = {};
  let table = root;
  for (const raw of text.split('\n')) {
    const line = stripComment(raw).trim();
    if (!line) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim().replace(/^"|"$/g, '');
      if (typeof root[name] !== 'object' || root[name] === null) root[name] = {};
      table = root[name];
      continue;
    }

    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, '');
    const value = line.slice(eq + 1).trim();
    if (!key || !value) continue;

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      table[key] = value.slice(1, -1);
    } else if (value.startsWith('[') && value.endsWith(']')) {
      table[key] = parseStringArray(value.slice(1, -1));
    } else if (value === 'true' || value === 'false') {
      table[key] = value === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      table[key] = Number(value);
    } else {
      table[key] = value;
    }
  }
  return root;
}

// Herdr injects HERDR_PLUGIN_CONFIG_DIR into the commands it starts, so an
// action or a startup hook is told where its config lives. Nothing tells a
// process started by hand — `node bin/agent-state.js` from a checkout, which
// is how this plugin is developed and how the README's own recovery step is
// worded — and without a fallback such a daemon quietly ran on defaults:
// every setting the user had chosen, from the glyph variant to the freshness
// thresholds, silently ignored. lib/paths derives the same location the way
// Herdr lays it out.
function load() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? paths.pluginConfigDir(paths.pluginId());
  try {
    return parseToml(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'));
  } catch {
    return {};
  }
}

const raw = load();

// `row_label` when it names a mode. Without it, the older `show_tab = true`
// reads as `both` and anything else as `title`.
function rowLabelSetting() {
  if (['title', 'tab', 'both'].includes(raw.row_label)) return raw.row_label;
  if (raw.show_tab === true) return 'both';
  return 'title';
}
const glyphs = typeof raw.glyphs === 'object' && raw.glyphs !== null ? raw.glyphs : {};

function glyph(state, fallback) {
  const chosen = glyphs[state];
  if (typeof chosen === 'string' && chosen) return chosen;
  // `led_glyph` is upstream's single knob for the blocked/idle mark; honour it
  // so an existing config keeps working.
  if ((state === 'blocked' || state === 'idle') && typeof raw.led_glyph === 'string' && raw.led_glyph) {
    return raw.led_glyph;
  }
  return fallback;
}

// What the user actually wrote for a state, or undefined. `logos.js` needs the
// difference between "chose this mark" and "took the default": the default now
// depends on the variant, an explicit choice never does.
function userGlyph(state) {
  return glyph(state, undefined);
}

// Every state gets its own shape, not just its own colour. Upstream draws
// blocked, idle and unknown with one mark and its suggested row config gives
// idle and unknown the same colour too, so three different situations look
// identical — in a light theme, in a screenshot, or to anyone who does not
// separate those hues easily.
const STATIC_GLYPH = {
  done: glyph('done', '✓'),
  blocked: glyph('blocked', '?'), // it is asking you something
  // The three idle tiers share one mark and differ only in colour; see the
  // note on STATE_PUA in lib/logos.js. Same here, so a font-less terminal
  // shows the same design rather than a second, older one. `working` shares
  // it too — its motion lives on the logo now, not on a spinner here.
  working: glyph('working', '○'),
  idle: glyph('idle', '·'), // parked, nothing wrong
  unknown: glyph('unknown', '◌'), // could not tell
  idle_fresh: glyph('idle_fresh', '·'), // worked recently
  idle_stale: glyph('idle_stale', '·'), // untouched for hours
};

// Spinner frames for `working`: eight-dot braille, the gap walking round a
// full cell. Two lighter designs were tried in front of these and both were
// put back — six-dot braille, which loses the lower row and reads thinner
// than the text beside it, and a twelve-spoke throbber baked into the icon
// font, which only a terminal with that font could show. A full braille cell
// is the heaviest mark of the three and the one that reads as motion from the
// other side of the panel, which is the entire job. The throbber's glyphs left
// the font with it — an unused mark is one more thing to keep building.
const DEFAULT_FRAMES = ['⣷', '⣯', '⣟', '⡿', '⢿', '⣻', '⣽', '⣾'];

// `spinner_frames` replaces them: an array of frames, or one string read as
// one frame per character (`"◐◓◑◒"`). Every frame has to be as long as the
// others, or the title after it shifts sideways each step; a list that breaks
// that, or holds an empty frame, falls back to the default whole. Length is
// counted in characters, not cells — a narrow and a wide glyph pass — since
// the plugin carries no width table and the frames a user picks are almost
// always one family.
function spinnerFrames(value) {
  const segments = (text) => [...new Intl.Segmenter().segment(text)].map((s) => s.segment);
  const frames = typeof value === 'string' ? segments(value) : value;
  if (!Array.isArray(frames) || frames.length === 0) return DEFAULT_FRAMES;
  if (!frames.every((f) => typeof f === 'string' && f.trim())) return DEFAULT_FRAMES;
  const length = segments(frames[0]).length;
  if (!frames.every((f) => segments(f).length === length)) return DEFAULT_FRAMES;
  return frames;
}

const FRAMES = spinnerFrames(raw.spinner_frames);

// What moves on a working row: the spinner in front of the title, a band of
// colour running along the title, or both. The gradient needs a Herdr that
// knows a cell's `gradient` key — one that does not refuses the whole config
// file over it — so it is never on unless asked for.
const WORKING_ANIMATIONS = ['spinner', 'gradient', 'both'];
const workingAnimation = WORKING_ANIMATIONS.includes(raw.working_animation) ? raw.working_animation : 'spinner';

// `gradient_colors` replaces the default band (each vendor's own colour with a
// lighter crest, lib/palette.js gradientRamp). Herdr takes 2 to 16 colours; a
// list outside that, or holding anything but `#rrggbb`, keeps the default.
// A colour for the spinner of its own, or one per frame. Either moves the
// spinner out of the title into a cell of its own (`$spinner`), since a cell
// is the unit Herdr colours — and a cell costs a separator, which is why the
// spinner stays in the title when neither is set. Per-frame colours are rules
// that match a frame by what it says, so the frames have to differ from each
// other, the list has to be as long as the frames, and Herdr reads at most 16
// rules; a list that breaks any of that is ignored whole.
const HEX = /^#[0-9a-fA-F]{6}$/;
function spinnerColor(value) {
  return typeof value === 'string' && HEX.test(value) ? value : null;
}
function spinnerColors(value, frames) {
  if (!Array.isArray(value) || value.length !== frames.length || value.length > 16) return null;
  if (new Set(frames).size !== frames.length) return null;
  return value.every((c) => typeof c === 'string' && HEX.test(c)) ? value : null;
}

const SPINNER_COLOR = spinnerColor(raw.spinner_color);
const SPINNER_COLORS = spinnerColors(raw.spinner_colors, FRAMES);

function gradientColors(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 16) return null;
  return value.every((c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) ? value : null;
}

const holdSetting = raw.done_hold ?? 'until_seen';
const colors = typeof raw.colors === 'object' && raw.colors !== null ? raw.colors : {};

module.exports = {
  raw,
  parseToml,
  spinnerFrames,
  DEFAULT_FRAMES,
  gradientColors,
  STATIC_GLYPH,
  userGlyph,
  FRAMES,

  // Whether the plugin polls the desktop's light/dark appearance and drives
  // Herdr's `[theme] name` from it. Off, Herdr's own `[theme]` settings decide
  // and the plugin's colours follow whichever theme name is configured.
  followAppearance: raw.follow_appearance !== false,

  // `[colors]` overrides for the one Herdr chrome token the theme block sets.
  // A string (hex, named, rgb(...)) replaces the default for that appearance;
  // an empty string means "do not override — let the theme's own value show".
  // Absent means the default.
  activeRowBg: {
    light: typeof colors.active_row_bg_light === 'string' ? colors.active_row_bg_light : undefined,
    dark: typeof colors.active_row_bg_dark === 'string' ? colors.active_row_bg_dark : undefined,
  },

  // spinner | gradient | both
  workingAnimation,
  spinnerOn: workingAnimation !== 'gradient',
  gradientOn: workingAnimation !== 'spinner',
  gradientColors: gradientColors(raw.gradient_colors),
  spinnerColor: SPINNER_COLOR,
  spinnerColors: SPINNER_COLORS,
  spinnerCell: workingAnimation !== 'gradient' && Boolean(SPINNER_COLOR || SPINNER_COLORS),

  // auto | font | text | none
  variant: typeof raw.variant === 'string' ? raw.variant : 'auto',

  // How long the green check survives after a turn ends. Herdr collapses `done`
  // into `idle` almost immediately, so the badge is this plugin's own
  // invention; six seconds is easy to miss when several agents finish while you
  // are looking elsewhere.
  doneHoldUntilSeen: holdSetting === 'until_seen',
  doneHoldSeconds: typeof holdSetting === 'number' ? holdSetting : 6,

  // How long an idle/done report has to persist before it counts as a turn
  // end. Herdr's detection can flap to idle for a beat mid-turn (macOS); the
  // grace absorbs it. Zero disables.
  idleGraceMs: (typeof raw.idle_grace_seconds === 'number' ? raw.idle_grace_seconds : 2.5) * 1000,

  // Whether a question mark survives until the agent goes back to work.
  // Herdr recognises `blocked` from the shape of the question on screen, so
  // focusing the pane can redraw it out of recognition — the question is still
  // waiting, but the mark is gone. Seeing a question is not answering it:
  // glancing at a pane and coming back to it later is the normal case.
  blockedHoldUntilAnswered: raw.blocked_hold !== false,

  // How long an idle pane keeps reading as recently active, and when it starts
  // reading as abandoned. Herdr has no notion of either — `idle` is `idle`
  // whether the agent stopped a minute ago or on Tuesday — so these two
  // thresholds are what turn one state into three.
  activityFreshMs: (typeof raw.activity_fresh_minutes === 'number' ? raw.activity_fresh_minutes : 15) * 60000,
  activityStaleMs: (typeof raw.activity_stale_minutes === 'number' ? raw.activity_stale_minutes : 120) * 60000,

  // What names an agent row: `title`, `tab` or `both`.
  rowLabel: rowLabelSetting(),
  // A template for the whole row text, e.g. "[{pane} · ]{title}". Set, it
  // replaces `row_label` (lib/state.js formatRow); unset, `row_label` decides.
  rowFormat: typeof raw.row_format === 'string' && raw.row_format.trim() ? raw.row_format : null,

  trimGroupPrefix: raw.trim_group_prefix !== false,
  groupGap: raw.group_gap !== false,
  // Off by default (#17): a split is two peers sharing one tab, and the
  // corner read as a parent/child and cost the row width.
  splitCorner: raw.split_corner === true,
  groupIndentWidth: typeof raw.group_indent === 'number' ? raw.group_indent : 2,

  // Keep Herdr's actual workspace indices aligned with Radar's activity order
  // so prefix+shift+1..9 follows the same order as the Agents panel. This is
  // opt-in because it changes the global Spaces order, not just this plugin's view.
  reorderWorkspaces: raw.reorder_workspaces === true,

  // The mark on a worktree's group header, between the branch corner and the
  // branch name. Deliberately NOT one of our own PUA glyphs: a Nerd Font as
  // the terminal's PRIMARY family already carries the git marks, and primary
  // beats fallback. Owning it would mean a font rebuild, a reinstall on every
  // machine and a wider `font-codepoint-map` range — for a decorative glyph.
  //
  // U+F418 is Octicons' git-branch, chosen over the Powerline symbol (U+E0A0),
  // Devicons' git-branch (U+E725) and Font Awesome's code-fork (U+F126) after
  // looking at all four on a real sidebar; every one of them rendered, so this
  // was taste, not coverage. Written as an escape on purpose — a PUA character
  // pasted in literally is invisible in the source and in every diff of it.
  // The bet is on the primary font being a Nerd Font; where it is not, set
  // `worktree_mark` to another codepoint (or "" to drop the mark) — no code
  // change needed.
  worktreeMark: typeof raw.worktree_mark === 'string' ? raw.worktree_mark : '\uf418',

  // Path of an optional module that may rewrite what is displayed before it
  // is published (lib/hook.js). Absent by default; the plugin ships none.
  renderHook: typeof raw.render_hook === 'string' && raw.render_hook ? raw.render_hook : null,
};
