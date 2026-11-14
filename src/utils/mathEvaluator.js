export const MATH_MAX_LENGTH = 250;
const MAX_TOKENS = 128;
const MAX_PAREN_DEPTH = 16;
const MAX_OPERATIONS = 100;
const MAX_FACTORIAL = 170;

const CONSTANTS = Object.freeze({
  pi: Math.PI,
  e: Math.E,
});

const FUNCTIONS = Object.freeze({
  sqrt: {
    category: 'Math Function',
    fn: (x) => {
      if (x < 0) {
        throw new Error('Akar kuadrat (`sqrt`) hanya mendukung bilangan non-negatif.');
      }
      return Math.sqrt(x);
    },
  },
  abs: { category: 'Math Function', fn: (x) => Math.abs(x) },
  round: { category: 'Math Function', fn: (x) => Math.round(x) },
  floor: { category: 'Math Function', fn: (x) => Math.floor(x) },
  ceil: { category: 'Math Function', fn: (x) => Math.ceil(x) },
  sin: { category: 'Trigonometry', fn: (x) => Math.sin(x) },
  cos: { category: 'Trigonometry', fn: (x) => Math.cos(x) },
  tan: {
    category: 'Trigonometry',
    fn: (x) => {
      if (Math.abs(Math.cos(x)) < 1e-15) {
        throw new Error('Hasil `tan` tidak terdefinisi untuk sudut ini.');
      }
      return Math.tan(x);
    },
  },
  asin: {
    category: 'Trigonometry',
    fn: (x) => {
      if (x < -1 || x > 1) {
        throw new Error('Input `asin` harus berada di antara -1 dan 1.');
      }
      return Math.asin(x);
    },
  },
  acos: {
    category: 'Trigonometry',
    fn: (x) => {
      if (x < -1 || x > 1) {
        throw new Error('Input `acos` harus berada di antara -1 dan 1.');
      }
      return Math.acos(x);
    },
  },
  atan: { category: 'Trigonometry', fn: (x) => Math.atan(x) },
  sind: { category: 'Trigonometry (Degrees)', fn: (x) => Math.sin((x * Math.PI) / 180) },
  cosd: { category: 'Trigonometry (Degrees)', fn: (x) => Math.cos((x * Math.PI) / 180) },
  tand: {
    category: 'Trigonometry (Degrees)',
    fn: (x) => {
      const rad = (x * Math.PI) / 180;
      if (Math.abs(Math.cos(rad)) < 1e-15) {
        throw new Error('Hasil `tand` tidak terdefinisi untuk sudut ini.');
      }
      return Math.tan(rad);
    },
  },
  asind: {
    category: 'Trigonometry (Degrees)',
    fn: (x) => {
      if (x < -1 || x > 1) {
        throw new Error('Input `asind` harus berada di antara -1 dan 1.');
      }
      return (Math.asin(x) * 180) / Math.PI;
    },
  },
  acosd: {
    category: 'Trigonometry (Degrees)',
    fn: (x) => {
      if (x < -1 || x > 1) {
        throw new Error('Input `acosd` harus berada di antara -1 dan 1.');
      }
      return (Math.acos(x) * 180) / Math.PI;
    },
  },
  atand: { category: 'Trigonometry (Degrees)', fn: (x) => (Math.atan(x) * 180) / Math.PI },
  deg: { category: 'Conversion', fn: (x) => (x * 180) / Math.PI },
  rad: { category: 'Conversion', fn: (x) => (x * Math.PI) / 180 },
  log: {
    category: 'Logarithmic',
    fn: (x) => {
      if (x <= 0) {
        throw new Error('Logaritma (`log`) hanya mendukung bilangan positif (> 0).');
      }
      return Math.log10(x);
    },
  },
  ln: {
    category: 'Logarithmic',
    fn: (x) => {
      if (x <= 0) {
        throw new Error('Logaritma natural (`ln`) hanya mendukung bilangan positif (> 0).');
      }
      return Math.log(x);
    },
  },
  exp: { category: 'Exponential', fn: (x) => Math.exp(x) },
});

/**
 * Computes factorial for non-negative integers up to 170.
 * @param {number} n
 * @returns {number}
 */
function computeFactorial(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_FACTORIAL) {
    throw new Error(`Faktorial hanya mendukung bilangan bulat 0 sampai ${MAX_FACTORIAL}.`);
  }
  let acc = 1;
  for (let i = 2; i <= n; i++) {
    acc *= i;
  }
  return acc;
}

/**
 * Tokenizes a math expression into validated lexical tokens without using eval.
 * @param {string} input
 * @returns {Array<{ type: string, value: string | number }>}
 */
function tokenizeMath(input) {
  const tokens = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (tokens.length >= MAX_TOKENS) {
      throw new Error('Ekspresi terlalu kompleks.');
    }

    // Number literal (integer or decimal, e.g. 42, 3.14, .5)
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      const match = input.slice(i).match(/^(?:\d+\.?\d*|\.\d+)/);
      if (!match) {
        throw new Error(`Angka tidak valid di dekat "${input.slice(i, i + 8)}".`);
      }
      const num = Number(match[0]);
      if (!Number.isFinite(num)) {
        throw new Error('Angka melampaui batas yang dapat dihitung.');
      }
      tokens.push({ type: 'number', value: num });
      i += match[0].length;
      continue;
    }

    // Identifier (function, constant, 'of', 'deg')
    if (/[a-zA-Z_]/.test(ch)) {
      const match = input.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
      const ident = match[0].toLowerCase();
      tokens.push({ type: 'ident', value: ident });
      i += match[0].length;
      continue;
    }

    // Double-star exponentiation (**)
    if (ch === '*' && input[i + 1] === '*') {
      tokens.push({ type: 'op', value: '^' });
      i += 2;
      continue;
    }

    if ('+-*/%^!()°'.includes(ch)) {
      if (ch === '(') {
        tokens.push({ type: 'lparen', value: '(' });
      } else if (ch === ')') {
        tokens.push({ type: 'rparen', value: ')' });
      } else {
        tokens.push({ type: 'op', value: ch });
      }
      i++;
      continue;
    }

    throw new Error(`Karakter tidak dikenali dalam ekspresi: "${ch}".`);
  }

  return tokens;
}

/**
 * Formats a finite numeric result into a clean, readable string.
 * @param {number} value
 * @returns {string}
 */
export function formatMathResult(value) {
  if (!Number.isFinite(value)) {
    throw new Error('Hasil perhitungan tidak valid (NaN/Infinity).');
  }

  const cleaned = Object.is(value, -0) ? 0 : Number(value.toPrecision(12));
  const abs = Math.abs(cleaned);

  if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) {
    return cleaned.toExponential(6).replace(/\.?0+e/, 'e');
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 10,
  }).format(cleaned);
}

/**
 * Safely parses and evaluates a mathematical expression string.
 * @param {string} rawExpression
 * @returns {{ input: string, value: number, formattedResult: string, operation: string }}
 */
export function evaluateMathExpression(rawExpression) {
  if (typeof rawExpression !== 'string') {
    throw new Error('Ekspresi matematika wajib diisi.');
  }

  const trimmed = rawExpression.trim();
  if (!trimmed) {
    throw new Error('Ekspresi matematika tidak boleh kosong.');
  }

  if (trimmed.length > MATH_MAX_LENGTH) {
    throw new Error(`Ekspresi maksimal ${MATH_MAX_LENGTH} karakter.`);
  }

  const tokens = tokenizeMath(trimmed);
  if (tokens.length === 0) {
    throw new Error('Ekspresi matematika tidak boleh kosong.');
  }

  let pos = 0;
  let parenDepth = 0;
  let opCount = 0;
  const categories = new Set();

  const peek = () => tokens[pos] ?? null;
  const consume = () => tokens[pos++] ?? null;

  const trackOp = (category) => {
    opCount++;
    if (opCount > MAX_OPERATIONS) {
      throw new Error('Perhitungan terlalu kompleks.');
    }
    if (category) {
      categories.add(category);
    }
  };

  const ensureFinite = (num) => {
    if (!Number.isFinite(num)) {
      throw new Error('Hasil perhitungan tidak valid atau melampaui batas (NaN/Infinity).');
    }
    return num;
  };

  const startsPrimary = (token) => {
    if (!token) return false;
    if (token.type === 'number' || token.type === 'lparen') return true;
    if (token.type === 'op' && (token.value === '+' || token.value === '-')) return true;
    if (token.type === 'ident' && token.value !== 'of' && token.value !== 'deg') return true;
    return false;
  };

  function parseExpression() {
    let left = parseTerm();

    while (true) {
      const token = peek();
      if (token?.type === 'op' && (token.value === '+' || token.value === '-')) {
        consume();
        const right = parseTerm();
        trackOp('Arithmetic');
        left = ensureFinite(token.value === '+' ? left + right : left - right);
      } else {
        break;
      }
    }

    return left;
  }

  function parseTerm() {
    let left = parseUnary();

    while (true) {
      const token = peek();
      if (token?.type === 'op' && (token.value === '*' || token.value === '/')) {
        consume();
        const right = parseUnary();
        trackOp('Arithmetic');
        if (token.value === '/') {
          if (right === 0) {
            throw new Error('Pembagian dengan nol tidak diperbolehkan.');
          }
          left = ensureFinite(left / right);
        } else {
          left = ensureFinite(left * right);
        }
      } else if (token?.type === 'op' && token.value === '%') {
        // Modulo when followed by a primary operand; otherwise handled as postfix percentage.
        if (!startsPrimary(tokens[pos + 1])) {
          break;
        }
        consume();
        const right = parseUnary();
        trackOp('Arithmetic');
        if (right === 0) {
          throw new Error('Modulo dengan nol tidak diperbolehkan.');
        }
        left = ensureFinite(left % right);
      } else if (token?.type === 'ident' && token.value === 'of') {
        consume();
        const right = parseUnary();
        trackOp('Percentage');
        left = ensureFinite(left * right);
      } else {
        break;
      }
    }

    return left;
  }

  function parseUnary() {
    const token = peek();
    if (token?.type === 'op' && (token.value === '+' || token.value === '-')) {
      consume();
      const val = parseUnary();
      trackOp('Arithmetic');
      return ensureFinite(token.value === '-' ? -val : val);
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePostfix();
    const token = peek();
    if (token?.type === 'op' && token.value === '^') {
      consume();
      const exponent = parseUnary();
      trackOp('Exponentiation');
      return ensureFinite(base ** exponent);
    }
    return base;
  }

  function parsePostfix() {
    let value = parsePrimary();

    while (true) {
      const token = peek();
      if (token?.type === 'op' && token.value === '!') {
        consume();
        trackOp('Factorial');
        value = ensureFinite(computeFactorial(value));
      } else if (token?.type === 'op' && token.value === '%' && !startsPrimary(tokens[pos + 1])) {
        consume();
        trackOp('Percentage');
        value = ensureFinite(value / 100);
      } else if (
        (token?.type === 'op' && token.value === '°') ||
        (token?.type === 'ident' && token.value === 'deg')
      ) {
        consume();
        trackOp('Conversion');
        value = ensureFinite((value * Math.PI) / 180);
      } else {
        break;
      }
    }

    return value;
  }

  function parsePrimary() {
    const token = peek();
    if (!token) {
      throw new Error('Ekspresi matematika tidak lengkap.');
    }

    if (token.type === 'number') {
      consume();
      return token.value;
    }

    if (token.type === 'lparen') {
      consume();
      parenDepth++;
      if (parenDepth > MAX_PAREN_DEPTH) {
        throw new Error(`Kedalaman tanda kurung maksimal ${MAX_PAREN_DEPTH} tingkat.`);
      }
      if (peek()?.type === 'rparen') {
        throw new Error('Tanda kurung tidak boleh kosong.');
      }
      const val = parseExpression();
      const closing = consume();
      if (!closing || closing.type !== 'rparen') {
        throw new Error('Tanda kurung tidak berpasangan.');
      }
      parenDepth--;
      return val;
    }

    if (token.type === 'ident') {
      const name = token.value;
      consume();

      if (Object.hasOwn(CONSTANTS, name)) {
        return CONSTANTS[name];
      }

      if (Object.hasOwn(FUNCTIONS, name)) {
        const next = consume();
        if (!next || next.type !== 'lparen') {
          throw new Error(`Fungsi \`${name}\` harus diikuti tanda kurung, contoh: \`${name}(10)\`.`);
        }
        parenDepth++;
        if (parenDepth > MAX_PAREN_DEPTH) {
          throw new Error(`Kedalaman tanda kurung maksimal ${MAX_PAREN_DEPTH} tingkat.`);
        }
        if (peek()?.type === 'rparen') {
          throw new Error(`Fungsi \`${name}\` membutuhkan argumen.`);
        }
        const arg = parseExpression();
        const closing = consume();
        if (!closing || closing.type !== 'rparen') {
          throw new Error('Tanda kurung tidak berpasangan.');
        }
        parenDepth--;

        const fnSpec = FUNCTIONS[name];
        trackOp(fnSpec.category);
        return ensureFinite(fnSpec.fn(arg));
      }

      throw new Error(`Fungsi atau konstanta tidak dikenal: \`${name}\`.`);
    }

    throw new Error('Ekspresi matematika tidak valid.');
  }

  const value = parseExpression();
  if (pos < tokens.length) {
    const leftover = tokens[pos];
    if (leftover.type === 'rparen') {
      throw new Error('Tanda kurung tidak berpasangan.');
    }
    throw new Error('Ekspresi matematika tidak valid.');
  }

  const operation = categories.size === 0
    ? 'Arithmetic'
    : categories.size === 1
      ? [...categories][0]
      : [...categories].join(' & ');

  return {
    input: trimmed,
    value,
    formattedResult: formatMathResult(value),
    operation,
  };
}
