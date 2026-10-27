import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CV_PALETTES, PALETTE_COLOR_KEYS, selectedPaletteId, applyCvPalette } from '../lib/cv-palettes.mjs';

const luminance = hex => {
  const rgb = hex.slice(1).match(/../g).map(part => Number.parseInt(part, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
const contrast = (foreground, background) => {
  const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

test('twelve coordinated palettes carry unique names and complete existing theme tokens', () => {
  assert.equal(CV_PALETTES.length, 12);
  assert.equal(new Set(CV_PALETTES.map(palette => palette.id)).size, 12);
  assert.equal(new Set(CV_PALETTES.map(palette => palette.name)).size, 12);
  assert.equal(new Set(CV_PALETTES.map(palette => palette.colors.accent_color)).size, 12);
  for (const palette of CV_PALETTES) {
    assert.match(palette.id, /^[a-z][a-z-]*$/);
    assert.ok(palette.description.trim());
    assert.deepEqual(Object.keys(palette.colors).sort(), [...PALETTE_COLOR_KEYS].sort());
    for (const color of Object.values(palette.colors)) assert.match(color, /^#[0-9a-f]{6}$/i);
  }
});

test('palette foregrounds meet WCAG normal-text contrast on paper and tag backgrounds', () => {
  for (const palette of CV_PALETTES) {
    for (const key of ['accent_color', 'secondary_color', 'tag_color']) {
      assert.ok(contrast(palette.colors[key], '#ffffff') >= 4.5, `${palette.name} ${key} on paper`);
    }
    assert.ok(contrast(palette.colors.tag_color, palette.colors.tag_bg) >= 4.5, `${palette.name} tag text`);
  }
});

test('palette selection recognizes exact color sets and preserves custom styling', () => {
  assert.equal(selectedPaletteId(), 'template');
  assert.equal(selectedPaletteId({ accent_color: '', secondary_color: ' ' }), 'template');
  assert.equal(selectedPaletteId({ accent_color: '#123456' }), 'custom');
  assert.equal(selectedPaletteId({ ...CV_PALETTES[0].colors, tag_border: '#123456' }), 'custom');
  const uppercase = Object.fromEntries(Object.entries(CV_PALETTES[0].colors).map(([key, value]) => [key, ` ${value.toUpperCase()} `]));
  assert.equal(selectedPaletteId(uppercase), CV_PALETTES[0].id);
});

test('applying or resetting palettes keeps font, size and unrelated settings', () => {
  const original = { accent_color: 'hsl(220 50% 30%)', font_family: 'Georgia, serif', font_size: '10px', margin: '0.5in' };
  const before = structuredClone(original);
  for (const palette of CV_PALETTES) {
    const next = applyCvPalette(original, palette.id);
    assert.equal(selectedPaletteId(next), palette.id);
    assert.equal(next.font_family, original.font_family);
    assert.equal(next.font_size, original.font_size);
    assert.equal(next.margin, original.margin);
    const reset = applyCvPalette(next, 'template');
    assert.equal(selectedPaletteId(reset), 'template');
    assert.ok(PALETTE_COLOR_KEYS.every(key => reset[key] === ''));
    assert.equal(reset.font_family, original.font_family);
  }
  assert.deepEqual(original, before);
  assert.throws(() => applyCvPalette(original, 'missing'), /palette/i);
  assert.throws(() => applyCvPalette(original, 'custom'), /palette/i);
});

test('browser palette registry stays byte-identical to the core', () => {
  assert.equal(readFileSync(new URL('../lib/cv-palettes.mjs', import.meta.url), 'utf8'), readFileSync(new URL('../web/src/lib/cv-palettes.mjs', import.meta.url), 'utf8'));
});
