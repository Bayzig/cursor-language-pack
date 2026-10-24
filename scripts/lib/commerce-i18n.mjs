/** Pure, deliberately narrow resource injection for Cursor's commerce bundle. */
const NAME = 'applyCursorCommerceCopy';
const MARKER = '/* cursor-commerce-i18n */';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const OPERATORS = /^(?:===|!==|>>>|\*\*=|&&=|\|\|=|\?\?=|=>|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\?\.|\*\*|<<|>>|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\.\.\.)/;
const REGEXP_PREFIX = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await', 'else', 'do']);

function fail(message) {
  throw new Error(`commerce-i18n: ${message}`);
}

// Strings, comments, regular expressions and entire templates are opaque. This
// keeps an SDK string or a CSS template from masquerading as executable code.
function tokensOf(source) {
  const tokens = [];
  let offset = 0;
  function quoted(quote) {
    offset++;
    while (offset < source.length) {
      const character = source[offset++];
      if (character === '\\') offset++;
      else if (character === quote) return;
      else if (character === '\n' || character === '\r') fail('unrecognized multiline string');
    }
    fail('unterminated string');
  }
  function template() {
    offset++;
    while (offset < source.length) {
      const character = source[offset++];
      if (character === '\\') offset++;
      else if (character === '`') return;
      else if (character === '$' && source[offset] === '{') {
        offset++;
        scan(true, false);
      }
    }
    fail('unterminated template');
  }
  function regexp() {
    offset++;
    let inClass = false;
    while (offset < source.length) {
      const character = source[offset++];
      if (character === '\\') offset++;
      else if (character === '[') inClass = true;
      else if (character === ']') inClass = false;
      else if (character === '/' && !inClass) {
        while (/[A-Za-z]/.test(source[offset] ?? '')) offset++;
        return;
      } else if (character === '\n' || character === '\r') fail('unrecognized regular expression');
    }
    fail('unterminated regular expression');
  }
  function scan(inTemplate = false, emit = true) {
    let braces = 0;
    let previous;
    while (offset < source.length) {
      const character = source[offset];
      if (/\s/.test(character)) { offset++; continue; }
      if (source.startsWith('//', offset)) {
        const end = source.indexOf('\n', offset + 2);
        offset = end < 0 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith('/*', offset)) {
        const end = source.indexOf('*/', offset + 2);
        if (end < 0) fail('unterminated comment');
        offset = end + 2;
        continue;
      }
      if (inTemplate && character === '}' && braces === 0) { offset++; return; }
      const start = offset;
      let kind = 'punctuation';
      let value;
      if (character === '"' || character === "'") {
        quoted(character);
        kind = 'string';
        value = source.slice(start + 1, offset - 1);
      } else if (character === '`') {
        template();
        kind = 'template';
      } else if (/[A-Za-z_$]/.test(character) || character === '\\' && source[offset + 1] === 'u') {
        const identifier = /^(?:[\w$]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\}))+/u.exec(source.slice(offset));
        if (!identifier) fail(`unrecognized identifier at offset ${offset}`);
        offset += identifier[0].length;
        kind = 'identifier';
      } else if (/[0-9]/.test(character)) {
        const number = /^(?:0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|[\d_]+(?:\.[\d_]*)?(?:[eE][+-]?[\d_]+)?n?)/.exec(source.slice(offset));
        offset += number[0].length;
        kind = 'number';
      } else if (character === '/' && (!previous || REGEXP_PREFIX.has(previous.value) ||
        previous.kind === 'punctuation' && ![')', ']', '}', '++', '--', '.', '?.'].includes(previous.value))) {
        regexp();
        kind = 'regexp';
      } else {
        const operator = OPERATORS.exec(source.slice(offset));
        if (operator) offset += operator[0].length;
        else if ('{}()[];,:.?~!+-*/%&|^<=>#'.includes(character)) offset++;
        else fail(`unrecognized token at offset ${offset}`);
        if (character === '{') braces++;
        if (character === '}') braces--;
      }
      const token = { kind, value: value ?? source.slice(start, offset), start, end: offset };
      if (emit) tokens.push(token);
      previous = token;
    }
    if (inTemplate) fail('unterminated template expression');
  }
  scan();
  return tokens;
}

const SHAPE = tokensOf(`async function __fn(__locale,__copy){
  const {instance:__instance,ready:__ready}=__get(__locale);
  if(await __ready,!__instance.isInitialized)return;
  const __map={};
  for(const[__key,__value]of Object.entries(__copy))
    __allowed(__key)&&typeof __value=="string"&&__value.length>0&&(__map[__key]=__value);
  if(Object.keys(__map).length===0)return;
  const __language=__instance.resolvedLanguage??__instance.language;
  __instance.addResourceBundle(__language,__namespace,__map,!0,!0),__instance.services.i18nFormat?.clearCache?.()
}`);
const INSERT_TOKEN = SHAPE.findIndex((token, index) => token.value === 'if' && SHAPE[index + 2]?.value === 'Object');

function locate(source) {
  const tokens = tokensOf(source);
  const pairs = new Map();
  const stack = [];
  const topLevel = new Set();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (stack.length === 0) topLevel.add(index);
    if (token.kind !== 'punctuation') continue;
    if (['{', '(', '['].includes(token.value)) stack.push(index);
    if (['}', ')', ']'].includes(token.value)) {
      const start = stack.pop();
      if (start === undefined || tokens[start].value !== ({ '}': '{', ')': '(', ']': '[' })[token.value]) {
        fail(`unrecognized delimiter structure at offset ${token.start}`);
      }
      pairs.set(start, index);
    }
  }
  if (stack.length) fail('unclosed delimiter structure');

  const aliases = [];
  for (const index of topLevel) {
    if (tokens[index].value !== 'export' || tokens[index + 1]?.value !== '{') continue;
    const end = pairs.get(index + 1);
    for (let cursor = index + 2; cursor < end;) {
      const local = tokens[cursor++];
      if (local.kind !== 'identifier') fail('unrecognized named export');
      let exported = local.value;
      if (tokens[cursor]?.value === 'as') {
        exported = tokens[cursor + 1]?.value;
        cursor += 2;
      }
      if (exported === NAME) {
        if (tokens[end + 1]?.value === 'from') fail(`${NAME} is re-exported, not locally defined`);
        aliases.push(local.value);
      }
      if (cursor < end && tokens[cursor++]?.value !== ',') fail('unrecognized named export list');
    }
  }
  if (aliases.length !== 1) fail(`expected one exported ${NAME} alias; found ${aliases.length}`);

  const candidates = [...topLevel].filter(index => tokens[index].value === 'async' &&
    tokens[index + 1]?.value === 'function' && tokens[index + 2]?.value === aliases[0]);
  if (candidates.length !== 1) fail(`expected one async function for ${aliases[0]}; found ${candidates.length}`);
  const start = candidates[0];
  const parametersEnd = pairs.get(start + 3);
  const end = parametersEnd === undefined ? undefined : pairs.get(parametersEnd + 1);
  if (end === undefined) fail(`unrecognized ${NAME} function boundaries`);
  if (source.slice(tokens[start].start, tokens[end].end).includes(MARKER)) fail(`${NAME} is already rewritten`);
  const body = tokens.slice(start, end + 1);
  if (body.length !== SHAPE.length) fail(`unrecognized ${NAME} structure`);
  const bindings = new Map([['__fn', aliases[0]]]);
  for (let index = 0; index < SHAPE.length; index++) {
    const expected = SHAPE[index];
    const actual = body[index];
    if (expected.kind === 'identifier' && expected.value.startsWith('__')) {
      if (actual.kind !== 'identifier' || !IDENTIFIER.test(actual.value)) fail(`unrecognized ${NAME} binding`);
      if (!bindings.has(expected.value)) bindings.set(expected.value, actual.value);
      if (bindings.get(expected.value) !== actual.value) fail(`inconsistent ${NAME} binding ${expected.value}`);
    } else if (actual.kind !== expected.kind || actual.value !== expected.value) {
      fail(`unrecognized ${NAME} structure near offset ${actual.start}`);
    }
  }
  const locals = ['__locale', '__copy', '__instance', '__ready', '__map', '__key', '__value', '__language'];
  if (new Set(locals.map(role => bindings.get(role))).size !== locals.length) fail(`ambiguous ${NAME} bindings`);
  return { offset: body[INSERT_TOKEN].start, map: bindings.get('__map') };
}

/**
 * Inject flat English -> translated resources after host-copy filtering. count
 * and hits count inserted resource entries, never replaced English literals.
 * Empty dictionaries are a no-op. Unknown or ambiguous bundle shapes throw.
 */
export function rewriteCommerce(source, dict) {
  if (typeof source !== 'string') fail('source must be a string');
  if (dict === null || typeof dict !== 'object' || Array.isArray(dict) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(dict))) fail('dictionary must be a flat object');
  const entries = Object.entries(dict).filter(([key]) => key !== '$comment');
  for (const [key, value] of entries) {
    if (!key || key === '__proto__' || typeof value !== 'string' || !value.trim()) {
      fail(`invalid translation for ${JSON.stringify(key)}`);
    }
  }
  const hits = new Map(entries.map(([key]) => [key, 1]));
  if (!entries.length) return { text: source, count: 0, hits };
  const { offset, map } = locate(source);
  const resources = JSON.stringify(Object.fromEntries(entries)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const insertion = `${MARKER}Object.assign(${map},${resources});`;
  return { text: source.slice(0, offset) + insertion + source.slice(offset), count: entries.length, hits };
}
