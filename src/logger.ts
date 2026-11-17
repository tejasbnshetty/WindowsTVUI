// Rotating file log in app data: couch-ui.log plus the 4 previous files (5 in total), each capped at 1 MB.
// Logging must never take the app down, so every file operation is wrapped.
import * as fs from "fs";
import * as path from "path";
import * as util from "util";

export type LogLevel = "info" | "warn" | "error";

export interface LoggerOptions {
  dir: string;
  baseName?: string;
  /** Rotate when the current file would exceed this. Default 1 MB. */
  maxBytes?: number;
  /** Total files kept, including the current one. Default 5. */
  maxFiles?: number;
  now?: () => Date;
}

export interface Logger {
  log(level: LogLevel, message: string): void;
  /** Path of the current log file. */
  file(): string;
  /** Mirrors console.log/info/warn/error into the log (the original output still happens). */
  installConsole(): void;
}

const MAX_LINE = 4000;

export function createLogger(opts: LoggerOptions): Logger {
  const base = opts.baseName ?? "couch-ui";
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const maxFiles = Math.max(1, opts.maxFiles ?? 5);
  const now = opts.now ?? (() => new Date());

  const current = path.join(opts.dir, `${base}.log`);
  const rotated = (n: number) => path.join(opts.dir, `${base}.${n}.log`);

  let size = 0;
  try {
    fs.mkdirSync(opts.dir, { recursive: true });
    size = fs.existsSync(current) ? fs.statSync(current).size : 0;
  } catch { /* logging stays best-effort */ }

  function rotate(): void {
    try {
      // Drop the oldest, shift the rest up by one, then move the current file to .1
      const oldest = maxFiles - 1;
      if (oldest >= 1 && fs.existsSync(rotated(oldest))) fs.unlinkSync(rotated(oldest));
      for (let n = oldest - 1; n >= 1; n--) {
        if (fs.existsSync(rotated(n))) fs.renameSync(rotated(n), rotated(n + 1));
      }
      if (oldest >= 1) fs.renameSync(current, rotated(1));
      else fs.unlinkSync(current);
    } catch { /* ignore */ }
    size = 0;
  }

  function log(level: LogLevel, message: string): void {
    try {
      let text = message.replace(/\r?\n/g, "\n    ");
      if (text.length > MAX_LINE) text = text.slice(0, MAX_LINE) + "…[truncated]";
      const line = `${now().toISOString()} [${level}] ${text}\n`;
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) rotate();
      fs.appendFileSync(current, line, "utf8");
      size += bytes;
    } catch { /* never throw from the logger */ }
  }

  return {
    log,
    file: () => current,
    installConsole() {
      const wrap = (name: "log" | "info" | "warn" | "error", level: LogLevel) => {
        const original = console[name].bind(console);
        console[name] = (...args: unknown[]) => {
          original(...args);
          log(level, util.format(...args));
        };
      };
      wrap("log", "info");
      wrap("info", "info");
      wrap("warn", "warn");
      wrap("error", "error");
    },
  };
}
