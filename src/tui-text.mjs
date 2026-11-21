// Text for the screen: strip what a terminal would obey, and measure and cut by the columns a string takes.
// Used by: src/tui.mjs (the frame, the loop) and src/tui-queue.mjs (rows, logs, folders and commands read from outside).
// Exports: clean (no escape sequences or control characters), cols (display width), clip (the first n columns).

// Sequences first (OSC to its end, CSI with its final byte, any other ESC pair), then the controls left over.
const SEQUENCES = /\x1b\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?|\x1b[\s\S]?/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
// A tab is the one control that is a gap; the rest are gone.
export const clean = (text) => String(text).replace(SEQUENCES, "").replace(/\t/g, " ").replace(CONTROLS, "");

// East Asian wide and fullwidth blocks and the emoji planes: two columns each.
const WIDE = [[0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd]];
// Combining marks, joiners and variation selectors: no column of their own.
const NONE = [[0x300, 0x36f], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f]];
const within = (ranges, code) => ranges.some(([low, high]) => code >= low && code <= high);
const cell = (char) => {
  const code = char.codePointAt(0);
  if (code < 0x20 || (code >= 0x7f && code < 0xa0) || within(NONE, code)) return 0;
  return within(WIDE, code) ? 2 : 1;
};

export const cols = (text) => {
  let sum = 0;
  for (const char of text) sum += cell(char);
  return sum;
};

// The start of the text that fits in `size` columns (a wide character that would cross the edge is left out).
export const clip = (text, size) => {
  let used = 0;
  let out = "";
  for (const char of text) {
    const width = cell(char);
    if (used + width > size) break;
    used += width;
    out += char;
  }
  return out;
};
