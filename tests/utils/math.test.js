import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { evaluateMathExpression, MATH_MAX_LENGTH } from '../../src/utils/mathEvaluator.js';
import mathCommand, { buildMathEmbed, execute as executeMath } from '../../src/commands/math.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';

function createMockInteraction(expression) {
  const replies = [];
  return {
    commandName: 'math',
    user: { id: 'u-math' },
    options: {
      getString: (name) => (name === 'expression' ? expression : null),
    },
    async reply(payload) {
      replies.push(payload);
      return payload;
    },
    getReplies: () => replies,
  };
}

describe('Math Evaluator & /math / !math command', () => {
  it('evaluates basic arithmetic operations accurately', () => {
    assert.equal(evaluateMathExpression('2 + 2').formattedResult, '4');
    assert.equal(evaluateMathExpression('10 - 3').formattedResult, '7');
    assert.equal(evaluateMathExpression('25 * 4').formattedResult, '100');
    assert.equal(evaluateMathExpression('45 / 9').formattedResult, '5');
    assert.equal(evaluateMathExpression('17 % 5').formattedResult, '2');
    assert.equal(evaluateMathExpression('2^10').formattedResult, '1,024');
    assert.equal(evaluateMathExpression('2**10').formattedResult, '1,024');
  });

  it('respects operator precedence and parentheses', () => {
    assert.equal(evaluateMathExpression('2 + 3 * 4').value, 14);
    assert.equal(evaluateMathExpression('(10 + 5) / 3').value, 5);
    assert.equal(evaluateMathExpression('(25 + 15) * 2').value, 80);
    assert.equal(evaluateMathExpression('2^3^2').value, 512);
    assert.equal(evaluateMathExpression('-2^2').value, -4);
    assert.equal(evaluateMathExpression('(-2)^2').value, 4);
    assert.equal(evaluateMathExpression('2^-2').value, 0.25);
    assert.equal(evaluateMathExpression('((2 + 3) * (4 - 1)) / 5').value, 3);
  });

  it('supports decimals and negative numbers cleanly without floating-point noise', () => {
    assert.equal(evaluateMathExpression('0.1 + 0.2').formattedResult, '0.3');
    assert.equal(evaluateMathExpression('.5 + .25').formattedResult, '0.75');
    assert.equal(evaluateMathExpression('-5.5 * 2').formattedResult, '-11');
    assert.equal(evaluateMathExpression('-10 + -5').formattedResult, '-15');
  });

  it('evaluates math functions, constants, and factorial', () => {
    assert.equal(evaluateMathExpression('sqrt(144)').value, 12);
    assert.equal(evaluateMathExpression('abs(-42.5)').value, 42.5);
    assert.equal(evaluateMathExpression('round(3.6)').value, 4);
    assert.equal(evaluateMathExpression('floor(3.9)').value, 3);
    assert.equal(evaluateMathExpression('ceil(3.1)').value, 4);
    assert.equal(evaluateMathExpression('log(100)').value, 2);
    assert.ok(Math.abs(evaluateMathExpression('ln(e)').value - 1) < 1e-12);
    assert.ok(Math.abs(evaluateMathExpression('exp(1) - e').value) < 1e-12);
    assert.ok(Math.abs(evaluateMathExpression('pi').value - Math.PI) < 1e-12);
    assert.equal(evaluateMathExpression('5!').value, 120);
    assert.equal(evaluateMathExpression('0!').value, 1);
  });

  it('evaluates trigonometry in radians, degrees, and degree/radian conversions', () => {
    assert.equal(evaluateMathExpression('sin(pi / 2)').formattedResult, '1');
    assert.equal(evaluateMathExpression('cos(0)').formattedResult, '1');
    assert.equal(evaluateMathExpression('tan(0)').formattedResult, '0');
    assert.equal(evaluateMathExpression('sind(30)').formattedResult, '0.5');
    assert.equal(evaluateMathExpression('cosd(60)').formattedResult, '0.5');
    assert.equal(evaluateMathExpression('tand(45)').formattedResult, '1');
    assert.equal(evaluateMathExpression('sin(30deg)').formattedResult, '0.5');
    assert.equal(evaluateMathExpression('sin(30°)').formattedResult, '0.5');
    assert.equal(evaluateMathExpression('asind(0.5)').formattedResult, '30');
    assert.equal(evaluateMathExpression('acosd(0.5)').formattedResult, '60');
    assert.equal(evaluateMathExpression('atand(1)').formattedResult, '45');
    assert.equal(evaluateMathExpression('deg(pi)').formattedResult, '180');
    assert.ok(Math.abs(evaluateMathExpression('rad(180) - pi').value) < 1e-12);
  });

  it('evaluates percentages and distinguishes percentage from modulo', () => {
    assert.equal(evaluateMathExpression('15% of 200').value, 30);
    assert.equal(evaluateMathExpression('50%').value, 0.5);
    assert.equal(evaluateMathExpression('200 * 25%').value, 50);
    assert.equal(evaluateMathExpression('(10 + 5)% of 200').value, 30);
    assert.equal(evaluateMathExpression('10 % 3').value, 1);
  });

  it('rejects empty, invalid, division-by-zero, overflow, and dangerous inputs', () => {
    assert.throws(() => evaluateMathExpression(''), /kosong/i);
    assert.throws(() => evaluateMathExpression('   '), /kosong/i);
    assert.throws(() => evaluateMathExpression(null), /wajib diisi/i);

    assert.throws(() => evaluateMathExpression('10 / 0'), /nol/i);
    assert.throws(() => evaluateMathExpression('10 % 0'), /nol/i);
    assert.throws(() => evaluateMathExpression('(2 + 3'), /kurung/i);
    assert.throws(() => evaluateMathExpression('2 + 3)'), /kurung/i);
    assert.throws(() => evaluateMathExpression('()'), /kurung/i);
    assert.throws(() => evaluateMathExpression('2 + * 3'), /tidak valid/i);
    assert.throws(() => evaluateMathExpression('unknown(5)'), /tidak dikenal/i);
    assert.throws(() => evaluateMathExpression('sqrt(-1)'), /non-negatif/i);
    assert.throws(() => evaluateMathExpression('log(0)'), /positif/i);
    assert.throws(() => evaluateMathExpression('10^400'), /NaN\/Infinity/i);
    assert.throws(() => evaluateMathExpression('171!'), /Faktorial/i);

    // Length & nesting limits
    assert.throws(() => evaluateMathExpression('1+'.repeat(130) + '1'), /maksimal/i);
    assert.throws(
      () => evaluateMathExpression('('.repeat(20) + '1' + ')'.repeat(20)),
      /Kedalaman tanda kurung/i,
    );

    // Dangerous JS payloads must be rejected cleanly
    const payloads = [
      'process.exit(1)',
      'require("fs")',
      'eval("1+1")',
      '__proto__',
      'constructor',
      'globalThis',
      '(() => 1)()',
    ];
    for (const payload of payloads) {
      assert.throws(() => evaluateMathExpression(payload));
    }
  });

  it('builds minimalist Input/Output/Footer embed and executes /math and !math', async () => {
    assert.equal(mathCommand.data.name, 'math');
    assert.equal(mathCommand.data.options[0].max_length, MATH_MAX_LENGTH);

    const parsed = parsePrefixInvocation('!math 9 + 11');
    assert.deepEqual(parsed, {
      commandName: 'math',
      subcommand: null,
      options: { expression: '9 + 11' },
    });
    assert.ok(parsePrefixInvocation('!math')?.error);

    const okInteraction = createMockInteraction('9 + 11');
    await executeMath(okInteraction);
    const okReply = okInteraction.getReplies()[0];
    const embedJson = okReply.embeds[0].toJSON();
    assert.equal(embedJson.title, undefined);
    assert.equal(embedJson.description, undefined);
    assert.equal(embedJson.footer, undefined);
    assert.equal(embedJson.fields.length, 2);
    assert.equal(embedJson.fields[0].name, 'Input');
    assert.equal(embedJson.fields[0].value, '`9 + 11`');
    assert.equal(embedJson.fields[1].name, 'Output');
    assert.equal(embedJson.fields[1].value, '`20`');

    const errInteraction = createMockInteraction('10 / 0');
    await executeMath(errInteraction);
    const errReply = errInteraction.getReplies()[0];
    assert.equal(errReply.flags, MessageFlags.Ephemeral);
    assert.match(errReply.embeds[0].toJSON().description, /nol/i);

    // Direct buildMathEmbed check
    const built = buildMathEmbed(evaluateMathExpression('sqrt(144)')).toJSON();
    assert.equal(built.title, undefined);
    assert.equal(built.description, undefined);
    assert.equal(built.fields.length, 2);
    assert.equal(built.fields[0].name, 'Input');
    assert.equal(built.fields[0].value, '`sqrt(144)`');
    assert.equal(built.fields[1].name, 'Output');
    assert.equal(built.fields[1].value, '`12`');
    assert.equal(built.footer, undefined);
  });
});
