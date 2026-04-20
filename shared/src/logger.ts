export type LogLevel = "debug" | "info" | "warn" | "error";

const order: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(service: string, level: LogLevel = "info") {
  const min = order[level] ?? order.info;

  function write(lvl: LogLevel, message: string, extra?: Record<string, unknown>) {
    if (order[lvl] < min) return;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      service,
      level: lvl,
      message,
      ...extra,
    });
    if (lvl === "error") console.error(line);
    else console.log(line);
  }

  return {
    debug: (message: string, extra?: Record<string, unknown>) => write("debug", message, extra),
    info: (message: string, extra?: Record<string, unknown>) => write("info", message, extra),
    warn: (message: string, extra?: Record<string, unknown>) => write("warn", message, extra),
    error: (message: string, extra?: Record<string, unknown>) => write("error", message, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;
