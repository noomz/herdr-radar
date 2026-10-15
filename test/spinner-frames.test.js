'use strict';

// `spinner_frames` replaces the braille spinner in front of a working title
// (lib/config.js). A list the title would jitter on, or one the reader could
// only half read, keeps the default instead.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseToml, spinnerFrames, DEFAULT_FRAMES } = require('../lib/config');

test('an array of frames is read as given', () => {
  const raw = parseToml('spinner_frames = ["◐", "◓", \'◑\', "◒"]  # quarters\n');
  assert.deepEqual(spinnerFrames(raw.spinner_frames), ['◐', '◓', '◑', '◒']);
});

test('frames of several characters each', () => {
  const raw = parseToml('spinner_frames = ["▰▱▱", "▱▰▱", "▱▱▰"]\n');
  assert.deepEqual(spinnerFrames(raw.spinner_frames), ['▰▱▱', '▱▰▱', '▱▱▰']);
});

test('a string is one frame per character', () => {
  assert.deepEqual(spinnerFrames('░▒▓█'), ['░', '▒', '▓', '█']);
});

test('a hash inside a frame is not a comment', () => {
  const raw = parseToml('spinner_frames = ["#", "+"] # comment\n');
  assert.deepEqual(raw.spinner_frames, ['#', '+']);
});

test('unset keeps the braille default', () => {
  assert.equal(spinnerFrames(undefined), DEFAULT_FRAMES);
});

test('frames of different lengths keep the default', () => {
  assert.equal(spinnerFrames(['▰', '▰▱']), DEFAULT_FRAMES);
});

test('an empty list, an empty frame or a non-string keeps the default', () => {
  assert.equal(spinnerFrames([]), DEFAULT_FRAMES);
  assert.equal(spinnerFrames(['◐', ' ']), DEFAULT_FRAMES);
  assert.equal(spinnerFrames(''), DEFAULT_FRAMES);
  assert.equal(spinnerFrames(7), DEFAULT_FRAMES);
});

test('an array holding anything but strings is unreadable', () => {
  assert.equal(parseToml('spinner_frames = ["◐", 3]\n').spinner_frames, null);
  assert.equal(spinnerFrames(null), DEFAULT_FRAMES);
});
