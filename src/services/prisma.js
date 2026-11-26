import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeError } from '../utils/errorSanitizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '../..');
const PRISMA_CLI_TIMEOUT_MS = 60_000;

process.env.DATABASE_URL ??= 'file:./dev.db';

function isTestProcess() {
  return (
    Boolean(process.env.NODE_TEST_CONTEXT) ||
    process.execArgv.includes('--test') ||
    process.env.SKIP_PRISMA_AUTO_SETUP === '1'
  );
}

function readTextIfExists(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, 'utf8');
}

/**
 * Ensures `@prisma/client` is generated for the current `prisma/schema.prisma` and pending
 * migrations are applied before `PrismaClient` is instantiated.
 *
 * @param {{
 *   rootDir?: string,
 *   runCli?: (args: string[]) => void,
 *   logger?: Console,
 * }} [options]
 * @returns {{ generated: boolean, migrated: boolean, skipped?: string }}
 */
export function preparePrisma(options = {}) {
  const rootDir = options.rootDir ?? DEFAULT_ROOT_DIR;
  const logger = options.logger ?? console;
  const prismaCliPath = path.join(rootDir, 'node_modules', 'prisma', 'build', 'index.js');
  const schemaPath = path.join(rootDir, 'prisma', 'schema.prisma');
  const generatedSchemaPath = path.join(rootDir, 'node_modules', '.prisma', 'client', 'schema.prisma');
  const migrationsDir = path.join(rootDir, 'prisma', 'migrations');

  if (!options.runCli && !existsSync(prismaCliPath)) {
    logger?.warn?.('[Prisma] Local prisma CLI not found; skipping auto-generate/migrate.');
    return { generated: false, migrated: false, skipped: 'missing-cli' };
  }

  const runCli =
    options.runCli ??
    ((args) => {
      execFileSync(process.execPath, [prismaCliPath, ...args], {
        cwd: rootDir,
        env: process.env,
        stdio: 'pipe',
        timeout: PRISMA_CLI_TIMEOUT_MS,
      });
    });

  let generated = false;
  let migrated = false;

  const sourceSchema = readTextIfExists(schemaPath);
  const generatedSchema = readTextIfExists(generatedSchemaPath);
  if (sourceSchema !== null && sourceSchema !== generatedSchema) {
    logger?.log?.('[Prisma] Schema changed or client missing — running prisma generate...');
    runCli(['generate']);
    generated = true;
  }

  if (existsSync(migrationsDir)) {
    runCli(['migrate', 'deploy']);
    migrated = true;
  }

  return { generated, migrated };
}

if (!isTestProcess()) {
  try {
    preparePrisma();
  } catch (error) {
    console.error('[Prisma] Auto-setup failed:', sanitizeError(error));
  }
}

const prismaPkg = await import('@prisma/client');
const { PrismaClient } = prismaPkg.default ?? prismaPkg;

export const prisma = new PrismaClient();
