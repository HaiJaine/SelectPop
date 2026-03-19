import fs from 'node:fs';
import path from 'node:path';

function normalizeMeta(meta) {
  if (meta === undefined) {
    return '';
  }

  if (typeof meta === 'string') {
    return meta;
  }

  if (meta instanceof Error) {
    return JSON.stringify({
      name: meta.name,
      message: meta.message,
      stack: meta.stack
    });
  }

  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

function formatLine(level, scope, message, meta) {
  const parts = [
    new Date().toISOString(),
    level,
    scope ? `[${scope}]` : '',
    message
  ].filter(Boolean);
  const serializedMeta = normalizeMeta(meta);
  return serializedMeta ? `${parts.join(' ')} ${serializedMeta}` : parts.join(' ');
}

export class AppLogger {
  constructor({ logsDir, fileName = 'selectpop.log', enabled = false }) {
    this.logsDir = logsDir;
    this.filePath = path.join(logsDir, fileName);
    this.enabled = enabled;
  }

  setEnabled(enabled) {
    const nextEnabled = enabled === true;

    if (this.enabled === nextEnabled) {
      return;
    }

    if (nextEnabled) {
      this.enabled = true;
      this.info('logging', 'File logging enabled.', { filePath: this.filePath });
      return;
    }

    this.info('logging', 'File logging disabled.', { filePath: this.filePath });
    this.enabled = false;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      filePath: this.filePath
    };
  }

  child(scope) {
    return {
      info: (message, meta) => this.info(scope, message, meta),
      warn: (message, meta) => this.warn(scope, message, meta),
      error: (message, meta) => this.error(scope, message, meta)
    };
  }

  info(scope, message, meta) {
    this.#write('INFO', scope, message, meta);
  }

  warn(scope, message, meta) {
    this.#write('WARN', scope, message, meta);
  }

  error(scope, message, meta) {
    this.#write('ERROR', scope, message, meta);
  }

  #write(level, scope, message, meta) {
    const line = formatLine(level, scope, message, meta);
    const consoleMethod =
      level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.info;

    consoleMethod(line);

    if (!this.enabled) {
      return;
    }

    fs.mkdirSync(this.logsDir, { recursive: true });
    fs.appendFileSync(this.filePath, `${line}\n`, 'utf8');
  }
}
