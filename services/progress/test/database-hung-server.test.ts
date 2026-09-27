/**
 * A database that stops answering must not hold the pool forever.
 *
 * `statement_timeout` is enforced by the server, so it cannot help when the
 * server is the thing that went silent: a frozen host, a partition, a failover
 * that never sent a RST. Without a client-side bound, every query in flight at
 * that moment waits until the kernel gives up on the socket (about fifteen
 * minutes on Linux), holding its pool slot — and once all slots are held, the
 * api is down for students well after the database is back.
 *
 * The server here speaks just enough of the protocol to finish the startup
 * handshake, then reads every query and never replies.
 */
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../src/postgres/database.js';
import { loadDatabaseConfig, type DatabaseConfig } from '../src/postgres/config.js';

function message(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'latin1');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

/** Accepts a connection, says "ready", then never answers anything again. */
async function silentServer(): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let greeted = false;
    socket.on('data', () => {
      if (greeted) return;
      greeted = true;
      const authOk = Buffer.alloc(4);
      socket.write(message('R', authOk));
      socket.write(message('Z', Buffer.from('I', 'latin1')));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function config(port: number, overrides: Partial<DatabaseConfig> = {}): DatabaseConfig {
  return {
    host: '127.0.0.1',
    port,
    database: 'labs',
    user: 'labs',
    password: 'not-a-secret',
    ssl: false,
    maxConnections: 2,
    connectionTimeoutMs: 1_000,
    idleTimeoutMs: 30_000,
    statementTimeoutMs: 100,
    queryTimeoutMs: 300,
    applicationName: 'hung-server-test',
    ...overrides,
  };
}

describe('a database that stops answering', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()!();
  });

  async function open(overrides: Partial<DatabaseConfig> = {}) {
    const server = await silentServer();
    const database = PostgresDatabase.fromConfig(config(server.port, overrides));
    cleanup.push(server.close, () => database.close().catch(() => undefined));
    return { server, database };
  }

  it('fails a query in bounded time instead of waiting on the socket', async () => {
    const { database } = await open();
    const started = Date.now();
    await expect(database.ping()).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('gives the slot back: a pool of two survives more hung queries than it has connections', async () => {
    const { database } = await open();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(database.query('SELECT $1::int', [attempt])).rejects.toThrow(/timeout/i);
    }
    expect(database.poolStats().waiting).toBe(0);
  });

  it('does not return a wedged connection to the pool from a failed transaction', async () => {
    const { server, database } = await open();
    await expect(database.transaction((tx) => tx.query('SELECT 1'))).rejects.toThrow(/timeout/i);
    // The connection whose query and ROLLBACK both went unanswered is
    // destroyed; had it been released, the next caller would inherit it.
    await expect.poll(() => database.poolStats().total).toBe(0);
    await expect.poll(() => server.connections()).toBe(0);
  });
});

describe('DATABASE_QUERY_TIMEOUT_MS', () => {
  const BASE = { DATABASE_URL: 'postgresql://labs@db:5432/labs' };

  it('defaults to five seconds past the statement timeout, so the server cancels first', () => {
    expect(loadDatabaseConfig(BASE)?.queryTimeoutMs).toBe(15_000);
    expect(
      loadDatabaseConfig({ ...BASE, DATABASE_STATEMENT_TIMEOUT_MS: '2000' })?.queryTimeoutMs,
    ).toBe(7_000);
    expect(loadDatabaseConfig({ ...BASE, DATABASE_QUERY_TIMEOUT_MS: '20000' })?.queryTimeoutMs).toBe(20_000);
  });

  it('refuses a client bound that would fire before the server-side one', () => {
    expect(() =>
      loadDatabaseConfig({
        ...BASE,
        DATABASE_STATEMENT_TIMEOUT_MS: '10000',
        DATABASE_QUERY_TIMEOUT_MS: '10000',
      }),
    ).toThrow(/DATABASE_QUERY_TIMEOUT_MS \(10000\) must be greater than DATABASE_STATEMENT_TIMEOUT_MS \(10000\)/);
  });
});
