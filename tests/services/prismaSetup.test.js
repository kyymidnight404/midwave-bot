import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePrisma } from '../../src/services/prisma.js';

function createTempProject({ schema = 'model A { id Int @id }', generatedSchema = null, hasMigrations = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'midwave-prisma-setup-'));
  mkdirSync(path.join(dir, 'prisma'), { recursive: true });
  writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), schema, 'utf8');

  if (hasMigrations) {
    mkdirSync(path.join(dir, 'prisma', 'migrations'), { recursive: true });
  }

  if (generatedSchema !== null) {
    mkdirSync(path.join(dir, 'node_modules', '.prisma', 'client'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', '.prisma', 'client', 'schema.prisma'), generatedSchema, 'utf8');
  }

  return dir;
}

test('preparePrisma skips cleanly when local prisma CLI is missing', () => {
  const dir = createTempProject();
  const warnings = [];
  try {
    const result = preparePrisma({
      rootDir: dir,
      logger: { warn: (msg) => warnings.push(msg), log: () => {} },
    });
    assert.deepEqual(result, { generated: false, migrated: false, skipped: 'missing-cli' });
    assert.equal(warnings.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preparePrisma runs generate and migrate deploy when generated schema differs', () => {
  const dir = createTempProject({ schema: 'model AfkStatus {}', generatedSchema: 'model Old {}' });
  const calls = [];
  try {
    const result = preparePrisma({
      rootDir: dir,
      runCli: (args) => calls.push(args),
      logger: { warn: () => {}, log: () => {} },
    });
    assert.deepEqual(result, { generated: true, migrated: true });
    assert.deepEqual(calls, [['generate'], ['migrate', 'deploy']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preparePrisma skips generate when generated schema matches and still runs migrate deploy', () => {
  const schema = 'model AfkStatus { userId String @id }';
  const dir = createTempProject({ schema, generatedSchema: schema });
  const calls = [];
  try {
    const result = preparePrisma({
      rootDir: dir,
      runCli: (args) => calls.push(args),
      logger: { warn: () => {}, log: () => {} },
    });
    assert.deepEqual(result, { generated: false, migrated: true });
    assert.deepEqual(calls, [['migrate', 'deploy']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
