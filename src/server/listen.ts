import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** How many ports are tried, from the one asked for, before giving up. */
const PORT_ATTEMPTS = 51;

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Binds the server itself to the first free port from `start`. Probing a port and binding
 * it afterwards leaves a gap in which another program can take it, so the real bind is the test.
 * Returns the port bound (the one the system chose, for 0).
 */
export async function listenOnFirstFree(server: Server, start: number, host: string): Promise<number> {
  for (let port = start; port < start + PORT_ATTEMPTS && port <= 65535; port++) {
    try {
      await listen(server, port, host);
      return (server.address() as AddressInfo).port;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' && (e as NodeJS.ErrnoException).code !== 'EACCES') throw e;
    }
  }
  throw new Error(`No free port between ${start} and ${start + PORT_ATTEMPTS - 1}`);
}
