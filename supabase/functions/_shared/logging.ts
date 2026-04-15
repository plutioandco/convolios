type LogLevel = "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  function_name: string;
  request_id: string;
  message: string;
  detail?: unknown;
}

let _functionName = "unknown";
let _requestId = "none";

export function initLogger(functionName: string, requestId?: string) {
  _functionName = functionName;
  _requestId = requestId ?? crypto.randomUUID().slice(0, 8);
}

function emit(level: LogLevel, message: string, detail?: unknown) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    function_name: _functionName,
    request_id: _requestId,
    message,
  };
  if (detail !== undefined) entry.detail = detail;

  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, detail?: unknown) => emit("info", msg, detail),
  warn: (msg: string, detail?: unknown) => emit("warn", msg, detail),
  error: (msg: string, detail?: unknown) => emit("error", msg, detail),
};
