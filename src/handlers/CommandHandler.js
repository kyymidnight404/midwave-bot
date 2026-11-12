import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_COMMANDS_DIR = path.resolve(__dirname, '../commands');

/**
 * Loads, validates, and indexes slash command modules.
 */
export class CommandHandler {
  /**
   * @param {string} [commandsDir]
   */
  constructor(commandsDir = DEFAULT_COMMANDS_DIR) {
    this.commandsDir = commandsDir;
    /** @type {Map<string, { data: import('discord.js').SlashCommandBuilder, execute: Function }>} */
    this.commands = new Map();
  }

  /**
   * Discovers and imports all `.js` command files in `commandsDir`.
   * @returns {Promise<Map<string, object>>}
   */
  async loadCommands() {
    this.commands.clear();
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

  /**
   * @param {string} name
   */
  get(name) {
    return this.commands.get(name);
  }

  /**
   * Serializes all loaded commands to Discord REST JSON payloads.
   * @returns {object[]}
   */
  toJSON() {
    return Array.from(this.commands.values()).map((cmd) => cmd.data.toJSON());
  }
}
