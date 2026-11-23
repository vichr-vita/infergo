// The editor's only door to the server. The Store is the one caller; regions
// never touch the Api. Two implementations satisfy the interface: serverApi
// below talks to `infergen edit`, and mock.ts replays the fixtures in memory
// for the dev page and the unit tests. The shipped bundle contains only this one.
import {
  eventNames, paths, refusalStatus, tokenParam,
  type ApplyReply, type ErrorReply, type EventPayloads, type Model, type Op, type PreviewReply, type Refusal,
} from './protocol';

/**
 * The outcome of one request. A refusal is a normal answer, not an exception,
 * and so is a failure (network down, server error), so callers must look at
 * `kind` and cannot forget either case.
 */
export type Result<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'failed'; error: string };

/** State of the event stream. `lost` means the stream dropped and a reconnect is pending. */
export type Connection = 'connecting' | 'open' | 'lost';

/** Callbacks for the event stream, one per server-sent event plus the connection state. */
export type EventHandlers = { [K in keyof EventPayloads]: (data: EventPayloads[K]) => void } & {
  connection: (state: Connection) => void;
};

export interface Api {
  /** `server` for the real backend, `mock` for the in-memory one. The status line names the mock. */
  readonly kind: 'server' | 'mock';
  model(): Promise<Result<Model>>;
  /** Computes the changes an operation would make. Writes nothing. */
  preview(op: Op): Promise<Result<PreviewReply>>;
  apply(op: Op): Promise<Result<ApplyReply>>;
  undo(): Promise<Result<ApplyReply>>;
  redo(): Promise<Result<ApplyReply>>;
  /** Turns scenario runs on or off for the session. */
  setValues(enabled: boolean): Promise<Result<void>>;
  /** Opens the event stream. Reconnects by itself until the returned function is called. */
  subscribe(handlers: EventHandlers): () => void;
}

/** Retry delays for a closed event stream, in milliseconds. The last one repeats. */
const reconnectDelays = [250, 1000, 3000];

/**
 * The real Api. The token comes from the page URL (`?token=`), as printed by
 * `infergen edit`, and goes on every request as the protocol header asks.
 */
export function serverApi(pageUrl: string = location.href): Api {
  const page = new URL(pageUrl);
  const token = page.searchParams.get(tokenParam) ?? '';
  const url = (path: string) => {
    const target = new URL(path, page);
    target.searchParams.set(tokenParam, token);
    return target.toString();
  };

  async function request<T>(path: string, body?: unknown): Promise<Result<T>> {
    let response: Response;
    try {
      response = await fetch(url(path), body === undefined && path === paths.model
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    } catch (error) {
      return { kind: 'failed', error: `Server unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      return { kind: 'failed', error: `Server sent a reply that is not JSON (status ${response.status})` };
    }
    if (response.status === refusalStatus) return { kind: 'refused', refusal: data as Refusal };
    if (!response.ok) {
      const message = (data as ErrorReply | undefined)?.error;
      return { kind: 'failed', error: message ?? `Server error ${response.status}` };
    }
    return { kind: 'ok', value: data as T };
  }

  return {
    kind: 'server',
    model: () => request<Model>(paths.model),
    preview: op => request<PreviewReply>(paths.preview, { op }),
    apply: op => request<ApplyReply>(paths.apply, { op }),
    undo: () => request<ApplyReply>(paths.undo, {}),
    redo: () => request<ApplyReply>(paths.redo, {}),
    setValues: async enabled => {
      const result = await request<unknown>(paths.values, { enabled });
      return result.kind === 'ok' ? { kind: 'ok', value: undefined } : result;
    },
    subscribe(handlers) {
      let source: EventSource | undefined;
      let attempt = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const connect = () => {
        handlers.connection(attempt ? 'lost' : 'connecting');
        source = new EventSource(url(paths.events));
        source.addEventListener('open', () => { attempt = 0; handlers.connection('open'); });
        for (const name of Object.values(eventNames)) {
          source.addEventListener(name, event => {
            let data: unknown;
            try {
              data = JSON.parse((event as MessageEvent<string>).data);
            } catch {
              console.error(`Ignored a ${name} event that is not JSON`);
              return;
            }
            (handlers[name] as (payload: unknown) => void)(data);
          });
        }
        // EventSource retries a dropped connection itself while readyState is
        // CONNECTING. It gives up (CLOSED) on an HTTP error, so retry by hand then.
        source.addEventListener('error', () => {
          if (stopped) return;
          handlers.connection('lost');
          if (source?.readyState !== EventSource.CLOSED) return;
          const delay = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)];
          attempt++;
          timer = setTimeout(connect, delay);
        });
      };
      connect();
      return () => {
        stopped = true;
        clearTimeout(timer);
        source?.close();
      };
    },
  };
}
