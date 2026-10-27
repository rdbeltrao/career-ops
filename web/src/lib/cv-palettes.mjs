/** Coordinated CV colors. The browser mirror is checked byte-for-byte in tests. */
export const PALETTE_COLOR_KEYS = Object.freeze([
  'accent_color', 'secondary_color', 'tag_color', 'tag_bg', 'tag_border',
]);

// JUDGMENT: restrained dark inks and pale supporting fills keep the document
// professional on white paper while giving each palette a distinct character.
// EVIDENCE: foregrounds are tested at >=4.5:1 using WCAG relative luminance:
// https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
/** @type {Array<[string, string, string, string[]]>} */
const palettes = [
  ['midnight', 'Midnight', 'Deep navy ink with cool blue highlights.', ['#23395b', '#172439', '#23395b', '#eef2f8', '#c7d2e3']],
  ['slate', 'Slate', 'Quiet blue-gray tones with crisp neutral details.', ['#475569', '#1e293b', '#334155', '#f1f5f9', '#cbd5e1']],
  ['ocean', 'Ocean', 'Rich ocean blue with a light coastal tint.', ['#075985', '#16354a', '#075985', '#edf7fc', '#beddeb']],
  ['teal', 'Teal', 'Dark teal ink and soft mineral green accents.', ['#115e59', '#183b3a', '#115e59', '#edf7f5', '#bddcd7']],
  ['forest', 'Forest', 'Evergreen headings and fresh, pale green highlights.', ['#24543b', '#1e3529', '#24543b', '#eff7f1', '#c6decd']],
  ['moss', 'Moss', 'Muted olive tones with a warm botanical feel.', ['#4d5b2a', '#2d3622', '#435025', '#f3f6eb', '#d4debd']],
  ['bordeaux', 'Bordeaux', 'Burgundy ink balanced with delicate rose details.', ['#7b3346', '#3f2530', '#7b3346', '#fbf0f3', '#e8c6d0']],
  ['plum', 'Plum', 'Dusky purple headings with a soft lilac tint.', ['#67406d', '#35263b', '#67406d', '#f7f0f8', '#dec9e1']],
  ['indigo', 'Indigo', 'Classic indigo ink and subtle periwinkle details.', ['#3f468c', '#242847', '#3f468c', '#f0f1fa', '#cbcfea']],
  ['terracotta', 'Terracotta', 'Earthy red-brown ink with warm clay highlights.', ['#8a442f', '#462c25', '#8a442f', '#fcf2ec', '#eacabb']],
  ['bronze', 'Bronze', 'Warm bronze headings with understated sand tones.', ['#755329', '#3e3023', '#755329', '#faf5ea', '#e4d3ae']],
  ['graphite', 'Graphite', 'Charcoal ink and clean, monochrome supporting tones.', ['#3b4149', '#202429', '#3b4149', '#f2f3f4', '#d1d5db']],
];

export const CV_PALETTES = Object.freeze(palettes.map(([id, name, description, values]) => Object.freeze({
  id, name, description,
  colors: Object.freeze(Object.fromEntries(PALETTE_COLOR_KEYS.map((key, index) => [key, values[index]]))),
})));

const colorValue = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

/** Existing custom colors remain custom until the user explicitly changes them. */
export function selectedPaletteId(style = {}) {
  if (PALETTE_COLOR_KEYS.every(key => !colorValue(style?.[key]))) return 'template';
  return CV_PALETTES.find(palette => PALETTE_COLOR_KEYS.every(key => colorValue(style?.[key]) === palette.colors[key]))?.id ?? 'custom';
}

/** Apply only the coordinated color tokens; typography and other settings survive. */
export function applyCvPalette(style, id) {
  const colors = id === 'template'
    ? Object.fromEntries(PALETTE_COLOR_KEYS.map(key => [key, '']))
    : CV_PALETTES.find(palette => palette.id === id)?.colors;
  if (!colors) throw new Error(`Unknown CV palette: ${id}.`);
  return { ...style, ...colors };
}
