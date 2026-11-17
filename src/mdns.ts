// Advertises the remote as couchui.local over mDNS (Bonjour) so the phone can use a URL that
// survives IP changes. The IP URL and QR code keep working as the fallback.

export const MDNS_HOST = "couchui.local";
export const MDNS_NAME = "Couch UI";

export interface MdnsHandle {
  stop(): Promise<void>;
}

export interface MdnsFactory {
  publish(o: { host: string; name: string; port: number; ip: string | null }, onError: (err: Error) => void): MdnsHandle;
}

export interface MdnsState {
  running: boolean;
  host: string;
  ip: string | null;
  port: number | null;
  error: string | null;
}

export interface MdnsAdvertiser {
  /** Starts (or restarts) advertising on the given LAN address. With ip=null it just remembers the port. */
  start(port: number, ip: string | null): void;
  /** The LAN address changed: re-publish on the new one, or stop if the network is gone. */
  update(ip: string | null): void;
  stop(): Promise<void>;
  state(): MdnsState;
}

export function createMdnsAdvertiser(deps: { factory: MdnsFactory; log?: (msg: string) => void; host?: string; name?: string }): MdnsAdvertiser {
  const host = deps.host ?? MDNS_HOST;
  const name = deps.name ?? MDNS_NAME;
  const log = deps.log ?? (() => {});
  let handle: MdnsHandle | null = null;
  let port: number | null = null;
  let ip: string | null = null;
  let error: string | null = null;
  let generation = 0; // ignores late errors from a handle that has since been replaced

  async function halt(): Promise<void> {
    const h = handle;
    handle = null;
    generation++;
    if (h) {
      try { await h.stop(); } catch (err) { log(`mdns stop failed: ${String(err)}`); }
    }
  }

  function publish(): void {
    if (port === null || ip === null) return;
    const mine = ++generation;
    try {
      handle = deps.factory.publish({ host, name, port, ip }, (err) => {
        if (mine !== generation) return;
        error = err.message;
        log(`mdns error: ${err.message}`);
      });
      error = null;
      log(`mdns: advertising ${host} -> ${ip}:${port}`);
    } catch (err) {
      handle = null;
      error = (err as Error).message;
      log(`mdns could not start: ${error}`);
    }
  }

  return {
    start(p, newIp) {
      port = p;
      ip = newIp;
      const prev = handle;
      handle = null;
      generation++;
      void prev?.stop().catch(() => {});
      publish();
    },
    update(newIp) {
      if (newIp === ip && (handle !== null || newIp === null)) return;
      ip = newIp;
      const prev = handle;
      handle = null;
      generation++;
      void prev?.stop().catch(() => {});
      if (newIp === null) {
        log("mdns: network gone, advertising stopped");
        return;
      }
      publish();
    },
    stop: halt,
    state: () => ({ running: handle !== null, host, ip, port, error }),
  };
}

/** Real Bonjour (bonjour-service) factory. */
export function createBonjourFactory(): MdnsFactory {
  return {
    publish({ host, name, port, ip }, onError) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Bonjour } = require("bonjour-service") as typeof import("bonjour-service");
      // bonjour-service's DEFAULT error callback throws, which would crash the app: always pass one.
      const bonjour = new Bonjour(ip ? ({ interface: ip } as never) : undefined, onError);
      bonjour.publish({ name, type: "http", port, host, disableIPv6: true, txt: { path: "/" } });
      return {
        stop: () => new Promise<void>((resolve) => {
          // Sends the "goodbye" packets so phones drop the name immediately, then closes the socket.
          const done = () => { try { bonjour.destroy(); } catch { /* ignore */ } resolve(); };
          const t = setTimeout(done, 1000);
          try { bonjour.unpublishAll(() => { clearTimeout(t); done(); }); } catch { clearTimeout(t); done(); }
        }),
      };
    },
  };
}
