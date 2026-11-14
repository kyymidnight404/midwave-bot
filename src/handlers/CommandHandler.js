import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commandStructure as defaultCommandStructure } from '../config/commandStructure.js';
import { DEFAULT_HANDLER_REGISTRY, resolveCommandExecutor } from '../config/commandRegistry.js';
import {
  assertValidCommandStructure,
  buildCommandBuilder,
  previewCommandSync,
} from '../services/commandManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_COMMANDS_DIR = path.resolve(__dirname, '../commands');

/**
 * Loads, validates, and indexes Discord application commands.
 * Uses centralized `commandStructure.js` by default, with fallback support
 * for directory-based loading when a directory path string is passed.
 */
export class CommandHandler {
  /**
   * @param {string | {
   *   commandStructure?: typeof defaultCommandStructure,
   *   handlerRegistry?: Record<string, Function>,
   *   validateHandlers?: boolean,
   *   commandsDir?: string,
   * }} [configOrDir]
   */
  constructor(configOrDir = {}) {
    if (typeof configOrDir === 'string') {
      this.commandsDir = configOrDir;
      this.useConfig = false;
      this.commandStructure = null;
      this.handlerRegistry = DEFAULT_HANDLER_REGISTRY;
      this.validateHandlers = true;
    } else {
      this.commandsDir = configOrDir.commandsDir ?? DEFAULT_COMMANDS_DIR;
      this.useConfig = true;
      this.commandStructure = configOrDir.commandStructure ?? defaultCommandStructure;
      this.handlerRegistry = configOrDir.handlerRegistry ?? DEFAULT_HANDLER_REGISTRY;
      this.validateHandlers = configOrDir.validateHandlers !== false;
    }

    /** @type {Map<string, { data: import('discord.js').SlashCommandBuilder | import('discord.js').ContextMenuCommandBuilder, execute: Function, config?: object }>} */
    this.commands = new Map();
  }

  /**
   * Discovers and builds all enabled commands from configuration (or legacy directory).
   * @returns {Promise<Map<string, object>>}
   */
  async loadCommands() {
    this.commands.clear();

    if (!this.useConfig) {
      const entries = await fs.readdir(this.commandsDir, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
        .map((entry) => entry.name)
        .sort();

      for (const file of files) {
        const fullPath = path.join(this.commandsDir, file);
        const moduleUrl = pathToFileURL(fullPath).href;
        const mod = await import(moduleUrl);
        const command = mod.default ?? mod;

        if (!command?.data?.name || typeof command.execute !== 'function') {
          throw new Error(`Invalid command module: ${file} must export { data, execute }`);
        }

        if (this.commands.has(command.data.name)) {
          throw new Error(`Duplicate command name detected: ${command.data.name}`);
        }

        this.commands.set(command.data.name, command);
      }

      return this.commands;
    }

    assertValidCommandStructure(this.commandStructure, {
      handlerRegistry: this.handlerRegistry,
      validateHandlers: this.validateHandlers,
    });

    for (const cmdConfig of this.commandStructure.commands) {
      if (cmdConfig.enabled === false) {
        continue;
      }

      const data = buildCommandBuilder(cmdConfig);
      const execute = resolveCommandExecutor(cmdConfig, this.handlerRegistry);
      this.commands.set(data.name, { data, execute, config: cmdConfig });
    }

    return this.commands;
  }

  /**
   * @param {string} name
   */
  get(name) {
    return this.commands.get(name);
  }

  /**
   * Returns the raw centralized configuration structure when running in config mode.
   */
  getStructure() {
    return this.commandStructure;
  }

  /**
   * Generates a validation and remote diff preview for the configured commands.
   * @param {object} [options]
   */
  async previewSync(options = {}) {
    if (!this.useConfig || !this.commandStructure) {
      throw new Error('previewSync requires CommandHandler in configuration mode.');
    }
    return previewCommandSync({
      structure: this.commandStructure,
      handlerRegistry: this.handlerRegistry,
      ...options,
    });
  }

  /**
   * Serializes all loaded commands to Discord REST JSON payloads.
   * @returns {object[]}
   */
  toJSON() {
    return Array.from(this.commands.values()).map((cmd) => cmd.data.toJSON());
  }
}
