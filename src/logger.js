import { config } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel.toLowerCase()] ?? LEVELS.info;

const stamp = () => new Date().toISOString().slice(11, 19);

function emit(level, tag, args, stderr) {
  if (LEVELS[level] < threshold) return;
  const line = `${stamp()} [${level.toUpperCase()}] [${tag}]`;
  const sink = stderr || level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(line, ...args);
}

/**
 * `stderr: true` đẩy MỌI mức ra stderr thay vì stdout. Dành cho script ghi kết quả
 * (JSON) ra stdout để pipe sang bước sau — log request/response lẫn vào đó là hỏng
 * dữ liệu của bên nhận, xem các script trong temp/.
 */
export function createLogger(tag, { stderr = false } = {}) {
  return {
    debug: (...args) => emit("debug", tag, args, stderr),
    info: (...args) => emit("info", tag, args, stderr),
    warn: (...args) => emit("warn", tag, args, stderr),
    error: (...args) => emit("error", tag, args, stderr),
  };
}
