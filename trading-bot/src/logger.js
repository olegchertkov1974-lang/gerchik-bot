'use strict';

/**
 * Logger — writes to file + console.
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.resolve(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'trading-bot.log');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function timestamp() {
  return new Date().toISOString();
}

function write(level, message, meta) {
  const line = `[${timestamp()}] [${level}] ${message}${meta ? ' ' + JSON.stringify(meta) : ''}`;

  // Console
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);

  // File
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {
    // ignore write errors
  }
}

module.exports = {
  info: (msg, meta) => write('INFO', msg, meta),
  warn: (msg, meta) => write('WARN', msg, meta),
  error: (msg, meta) => write('ERROR', msg, meta),
  debug: (msg, meta) => {
    if (process.env.LOG_LEVEL === 'debug') write('DEBUG', msg, meta);
  },
};
