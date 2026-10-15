'use strict';

// `working_animation = "gradient"`: a band of colour runs along a working
// title. Herdr colours character i with stop (i + phase) mod n; the animator
// writes the phase as `anim_phase`, and the managed config names it on the
// working title's cell.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// lib/config reads the file once, at require time, so each setting gets a
// fresh module graph pointed at its own config directory.
function load(toml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-gradient-'));
  fs.writeFileSync(path.join(dir, 'config.toml'), toml);
  const saved = process.env.HERDR_PLUGIN_CONFIG_DIR;
  process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}lib${path.sep}`)) delete require.cache[key];
  }
  try {
    return {
      config: require('../lib/config'),
      state: require('../lib/state'),
      managed: require('../lib/managed-config'),
      palette: require('../lib/palette'),
    };
  } finally {
    if (saved === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = saved;
  }
}

const entry = { name: 'claude' };

test('by default the spinner runs and no gradient is asked of Herdr', () => {
  const { state, managed } = load('');
  const line = state.composeLine(entry, 'working', '', '', 0);
  assert.equal(line.phase, null);
  assert.ok(line.titlePrefix.trim().length > 0, 'spinner frame in front of the title');
  assert.equal(state.stateTokens('working', line, 'fix').anim_phase, null);
  assert.ok(!managed.sidebarBlock('dark').includes('gradient'));
});

test('gradient alone drops the spinner and counts the phase down', () => {
  const { state } = load('working_animation = "gradient"\n');
  const first = state.composeLine(entry, 'working', '', '', 0);
  const next = state.composeLine(entry, 'working', '', '', 1);
  assert.equal(first.titlePrefix, '');
  // Each step is one stop further to the right: (i + phase) mod n with the
  // phase one lower means the colour at i is now the one at i - 1.
  for (const n of [2, 3, 12, 16]) {
    assert.equal((((Number(first.phase) - Number(next.phase)) % n) + n) % n, 1);
  }
  assert.equal(state.stateTokens('working', next, 'fix').anim_phase, next.phase);
});

test('a row that is not working carries no phase', () => {
  const { state } = load('working_animation = "gradient"\n');
  const line = state.composeLine(entry, 'done', '', '', 4);
  assert.equal(line.phase, null);
  assert.equal(state.stateTokens('done', line, 'fix').anim_phase, null);
});

test('both keeps the spinner and adds the phase', () => {
  const { state } = load('working_animation = "both"\n');
  const line = state.composeLine(entry, 'working', '', '', 2);
  assert.ok(line.titlePrefix.trim().length > 0);
  assert.notEqual(line.phase, null);
});

test('the working title cell names the band and the phase token', () => {
  const { managed, palette } = load('working_animation = "gradient"\n');
  const block = managed.sidebarBlock('dark');
  const ramp = palette.gradientRamp(palette.brand.claude, 'dark');
  assert.ok(block.includes(`gradient = [${ramp.map((c) => `"${c}"`).join(', ')}], gradient_phase = "$anim_phase"`));
  // Only the working title moves.
  assert.ok(!/token = "\$title_done"[^}]*gradient/.test(block));
});

test('gradient_colors replaces the band; a bad list keeps the default', () => {
  const { managed } = load('working_animation = "gradient"\ngradient_colors = ["#112233", "#445566"]\n');
  assert.ok(managed.sidebarBlock('light').includes('gradient = ["#112233", "#445566"]'));
  const { config } = load('gradient_colors = ["#112233"]\n');
  assert.equal(config.gradientColors, null);
  assert.equal(load('gradient_colors = ["#112233", "red"]\n').config.gradientColors, null);
});

test('the default band keeps the vendor colour and crests away from the panel', () => {
  const { palette } = load('');
  const dark = palette.gradientRamp('#d97757', 'dark');
  const light = palette.gradientRamp('#d97757', 'light');
  assert.ok(dark.length >= 2 && dark.length <= 16);
  assert.equal(dark[0], '#d97757');
  const sum = (hex) => [1, 3, 5].reduce((acc, i) => acc + parseInt(hex.slice(i, i + 2), 16), 0);
  assert.ok(Math.max(...dark.map(sum)) > sum('#d97757'), 'lighter crest on dark');
  assert.ok(Math.min(...light.map(sum)) < sum('#d97757'), 'darker crest on light');
});

test('without spinner colours the spinner stays in the title', () => {
  const { state, managed } = load('working_animation = "both"\n');
  const line = state.composeLine(entry, 'working', '', '', 0);
  assert.equal(line.spinner, '');
  assert.equal(state.stateTokens('working', line, 'fix').spinner, null);
  assert.ok(!managed.sidebarBlock('dark').includes('$spinner'));
});

test('spinner_color moves the spinner into a cell of its own', () => {
  const { state, managed, config } = load('working_animation = "both"\nspinner_color = "#7aa2f7"\n');
  const line = state.composeLine(entry, 'working', '', '', 0);
  assert.equal(line.spinner, config.FRAMES[0]);
  assert.equal(line.titlePrefix, '');
  assert.equal(state.stateTokens('working', line, 'fix').spinner, config.FRAMES[0]);
  const block = managed.sidebarBlock('dark');
  assert.ok(block.includes('{ token = "$spinner", fg = "#7aa2f7", bold = true, dim = false }'));
  // Before the title, so it reads first.
  assert.ok(block.indexOf('"$spinner"') < block.indexOf('"$title_working"'));
});

test('a row with no logo hangs its indent on the spinner', () => {
  const { state } = load('spinner_color = "#7aa2f7"\n');
  const line = state.composeLine({ name: 'no-such-agent' }, 'working', '', '  ', 0);
  if (line.logo) return; // the vendor has a mark after all; nothing to check
  assert.ok(line.spinner.startsWith('  '));
  assert.ok(!line.titlePrefix.startsWith('  '));
});

test('spinner_colors gives every frame its own colour', () => {
  const { managed } = load(
    'spinner_frames = ["◐", "◓", "◑", "◒"]\nspinner_colors = ["#111111", "#222222", "#333333", "#444444"]\n',
  );
  const block = managed.sidebarBlock('dark');
  assert.ok(
    block.includes(
      'rules = [{ contains = "◐", fg = "#111111" }, { contains = "◓", fg = "#222222" }, { contains = "◑", fg = "#333333" }, { contains = "◒", fg = "#444444" }]',
    ),
  );
});

test('spinner_colors that do not fit the frames are ignored', () => {
  const frames = 'spinner_frames = ["◐", "◓"]\n';
  assert.equal(load(`${frames}spinner_colors = ["#111111"]\n`).config.spinnerColors, null);
  assert.equal(load(`${frames}spinner_colors = ["#111111", "red"]\n`).config.spinnerColors, null);
  assert.equal(
    load('spinner_frames = ["◐", "◐"]\nspinner_colors = ["#111111", "#222222"]\n').config.spinnerColors,
    null,
  );
  assert.deepEqual(load(`${frames}spinner_colors = ["#111111", "#222222"]\n`).config.spinnerColors, [
    '#111111',
    '#222222',
  ]);
});

test('gradient alone has no spinner cell even with spinner colours', () => {
  const { state, managed } = load('working_animation = "gradient"\nspinner_color = "#7aa2f7"\n');
  assert.equal(state.composeLine(entry, 'working', '', '', 0).spinner, '');
  assert.ok(!managed.sidebarBlock('dark').includes('$spinner'));
});
