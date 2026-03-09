// Normalizes tmux capture-pane -e output (per-cell SGR) into combined SGR sequences
// that xterm.dart renders correctly. Simulates the full SGR state machine and emits
// one ESC[...m per text run instead of one per cell.

function defaultState() {
  return {
    bold: false, faint: false, italic: false, underline: false,
    blink: false, inverse: false, invisible: false, strikethrough: false,
    fg: null, bg: null,
  };
}

function applySGR(state, params) {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    switch (p) {
      case 0: Object.assign(state, defaultState()); break;
      case 1: state.bold = true; break;
      case 2: state.faint = true; break;
      case 3: state.italic = true; break;
      case 4: state.underline = true; break;
      case 5: state.blink = true; break;
      case 7: state.inverse = true; break;
      case 8: state.invisible = true; break;
      case 9: state.strikethrough = true; break;
      case 21: state.bold = false; break;
      case 22: state.faint = false; break;
      case 23: state.italic = false; break;
      case 24: state.underline = false; break;
      case 25: state.blink = false; break;
      case 27: state.inverse = false; break;
      case 28: state.invisible = false; break;
      case 29: state.strikethrough = false; break;
      case 30: case 31: case 32: case 33: case 34: case 35: case 36: case 37:
        state.fg = { type: '16', code: p }; break;
      case 38:
        if (params[i + 1] === 2 && i + 4 < params.length) {
          state.fg = { type: 'rgb', r: params[i+2], g: params[i+3], b: params[i+4] }; i += 4;
        } else if (params[i + 1] === 5 && i + 2 < params.length) {
          state.fg = { type: '256', n: params[i+2] }; i += 2;
        }
        break;
      case 39: state.fg = null; break;
      case 40: case 41: case 42: case 43: case 44: case 45: case 46: case 47:
        state.bg = { type: '16', code: p }; break;
      case 48:
        if (params[i + 1] === 2 && i + 4 < params.length) {
          state.bg = { type: 'rgb', r: params[i+2], g: params[i+3], b: params[i+4] }; i += 4;
        } else if (params[i + 1] === 5 && i + 2 < params.length) {
          state.bg = { type: '256', n: params[i+2] }; i += 2;
        }
        break;
      case 49: state.bg = null; break;
      case 90: case 91: case 92: case 93: case 94: case 95: case 96: case 97:
        state.fg = { type: '16', code: p }; break;
      case 100: case 101: case 102: case 103: case 104: case 105: case 106: case 107:
        state.bg = { type: '16', code: p }; break;
    }
  }
}

function stateToSGR(state) {
  const isDefault = !state.bold && !state.faint && !state.italic && !state.underline &&
    !state.blink && !state.inverse && !state.invisible && !state.strikethrough &&
    !state.fg && !state.bg;
  if (isDefault) return '\x1b[0m';

  const parts = ['0'];
  if (state.bold) parts.push('1');
  if (state.faint) parts.push('2');
  if (state.italic) parts.push('3');
  if (state.underline) parts.push('4');
  if (state.blink) parts.push('5');
  if (state.inverse) parts.push('7');
  if (state.invisible) parts.push('8');
  if (state.strikethrough) parts.push('9');
  if (state.fg) {
    if (state.fg.type === '16') parts.push(String(state.fg.code));
    else if (state.fg.type === 'rgb') parts.push('38', '2', String(state.fg.r), String(state.fg.g), String(state.fg.b));
    else if (state.fg.type === '256') parts.push('38', '5', String(state.fg.n));
  }
  if (state.bg) {
    if (state.bg.type === '16') parts.push(String(state.bg.code));
    else if (state.bg.type === 'rgb') parts.push('48', '2', String(state.bg.r), String(state.bg.g), String(state.bg.b));
    else if (state.bg.type === '256') parts.push('48', '5', String(state.bg.n));
  }
  return '\x1b[' + parts.join(';') + 'm';
}

function normalizeTmuxSGR(input) {
  const SGR_RE = /\x1b\[([0-9;]*)m/g;
  const tokens = [];
  let lastIndex = 0;
  let match;

  while ((match = SGR_RE.exec(input)) !== null) {
    if (match.index > lastIndex) tokens.push({ text: input.slice(lastIndex, match.index) });
    const paramStr = match[1];
    tokens.push({ params: paramStr === '' ? [0] : paramStr.split(';').map(Number) });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < input.length) tokens.push({ text: input.slice(lastIndex) });

  const state = defaultState();
  const defaultKey = JSON.stringify(defaultState());
  let lastEmittedKey = defaultKey;
  let output = '';

  for (const token of tokens) {
    if (token.params) {
      applySGR(state, token.params);
    } else if (token.text) {
      const currentKey = JSON.stringify(state);
      if (currentKey !== lastEmittedKey) {
        output += stateToSGR(state);
        lastEmittedKey = currentKey;
      }
      output += token.text;
    }
  }
  if (lastEmittedKey !== defaultKey) output += '\x1b[0m';
  return output;
}

module.exports = { normalizeTmuxSGR };
