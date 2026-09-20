const FILLER = new Set([
  'a',
  'an',
  'the',
  'with',
  'and',
  'of',
  'for',
  'that',
  'this',
  'very',
  'really',
  'some',
  'just',
  'like',
  'featuring',
  'features',
  'style',
  'look',
  'piece',
  'clothing',
  'item',
  'wear',
  'worn',
  'mens',
  'womens',
  'menswear',
  'womenswear',
  'trendy',
  'cute',
  'nice',
  'cool',
  'aesthetic',
  'in',
  'on',
  'to',
  'from',
  'its',
  'plus',
  'including',
  'showing',
]);

const COLOR_ALIASES = {
  'navy blue': 'navy',
  'dark grey': 'dark-gray',
  'dark gray': 'dark-gray',
  'light blue': 'light-blue',
  'off white': 'off-white',
  'olive green': 'olive',
  grey: 'gray',
  greyish: 'gray',
  navyblue: 'navy',
  offwhite: 'off-white',
  'off-white': 'off-white',
  maroon: 'burgundy',
  wine: 'burgundy',
  olivegreen: 'olive',
  darkblue: 'navy',
  lightblue: 'light-blue',
};

export function canonicalizeQuery(query) {
  let text = String(query || '').toLowerCase();
  if (!text.trim()) return '';
  text = text.replaceAll('&', ' and ');
  text = text.replace(/[^\w\s-]/g, ' ');
  text = text.replace(/-{2,}/g, '-');
  text = text.replace(/\s+/g, ' ').trim();

  const tokens = text
    .split(' ')
    .map((tok) => tok.replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  const out = [];
  for (let i = 0; i < tokens.length; ) {
    const tok = tokens[i];
    const pair = i + 1 < tokens.length ? `${tok} ${tokens[i + 1]}` : '';
    let alias = null;
    let consumed = 1;
    if (pair) {
      const pairKey = pair.replace(/[\s-]/g, '');
      alias = COLOR_ALIASES[pair] || COLOR_ALIASES[pairKey] || null;
      if (alias) consumed = 2;
    }
    if (!alias) {
      const key = tok.replaceAll('-', '');
      if (FILLER.has(tok) || FILLER.has(key)) {
        i += 1;
        continue;
      }
      alias = COLOR_ALIASES[tok] || COLOR_ALIASES[key] || tok;
    }
    if (!out.includes(alias)) out.push(alias);
    i += consumed;
  }
  return out.join(' ');
}
