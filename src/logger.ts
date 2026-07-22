import { AsyncLocalStorage } from 'node:async_hooks';
import { MiddlewareHandler } from 'hono';

export interface LogStore {
  logs: string[];
  isError: boolean;
}

export const logStorage = new AsyncLocalStorage<LogStore>();

function formatLogArgs(...args: any[]): string {
  return args
    .map(arg => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
    .join(' ');
}

export function log(...args: any[]) {
  const msg = formatLogArgs(...args);
  console.log(msg);
  logStorage.getStore()?.logs.push(msg);
}

export function logError(...args: any[]) {
  const msg = formatLogArgs(...args);
  console.error(msg);
  const store = logStorage.getStore();
  if (store) {
    store.logs.push(`[ERROR] ${msg}`);
    store.isError = true;
  }
}

export function logWarn(...args: any[]) {
  const msg = formatLogArgs(...args);
  console.warn(msg);
  logStorage.getStore()?.logs.push(`[WARN] ${msg}`);
}

async function sendLogsToDiscord(url: string, ua: string, logs: string[], isError: boolean) {
  const webhookUrl = isError
    ? process.env.DISCORD_ERROR_WEBHOOK_URL
    : process.env.DISCORD_SUCCESS_WEBHOOK_URL;

  if (!webhookUrl) {
    return;
  }

  if (logs.length === 0) return;

  const title = isError ? '🔴 FxLeboncoin - Request Error' : '🟢 FxLeboncoin - Request Success';
  const color = isError ? 0xff0000 : 0x00ff00;
  
  const formattedLogs = logs.join('\n');

  let codeBlock = `\`\`\`\n${formattedLogs.slice(-1900)}\n\`\`\``;
  if (formatLogArgs.length > 1900) {
    codeBlock = "[Truncated]\n" + codeBlock
  }

  const payload = {
    embeds: [
      {
        title,
        color,
        fields: [
          { name: 'Request URL', value: url, inline: true },
          { name: 'User Agent', value: ua.slice(0, 100), inline: true },
        ],
        description: `**Logs:**\n${codeBlock}`,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[fxlbc] Discord webhook returned status ${res.status}`);
    }
  } catch (err) {
    console.error('[fxlbc] Failed to send logs to Discord webhook:', err);
  }
}

export const logMiddleware = (): MiddlewareHandler => {
  return async (c, next) => {
    const store: LogStore = {
      logs: [],
      isError: false,
    };

    await logStorage.run(store, async () => {
      try {
        await next();
      } catch (err) {
        logError(`Unhandled request error: ${err}`);
        throw err;
      } finally {
        const url = c.req.url;
        const ua = c.req.header('user-agent') ?? 'unknown';
        await sendLogsToDiscord(url, ua, store.logs, store.isError);
      }
    });
  };
};
