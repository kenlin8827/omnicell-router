import { afterAll, describe, expect, it } from 'bun:test';
import net from 'node:net';
import { dbEngineFor, probeDatabase } from '../src/harness/db-probe.js';

/**
 * Real connection tests for the DSN builder (ADR-0015 §D11).
 *
 * These cases drive the actual drivers against scripted wire servers, so the verdict mapping is
 * exercised end to end: the PostgreSQL server answers an `ErrorResponse`, the MySQL server answers
 * a protocol-40 `ERR` packet, and both must surface as `auth_failed` / `database_missing` — never as
 * a healthy connection, and never as a generic error that hides which parameter is wrong.
 */

function packet(sequence: number, body: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = body.length & 0xff;
  header[1] = (body.length >> 8) & 0xff;
  header[2] = (body.length >> 16) & 0xff;
  header[3] = sequence;
  return Buffer.concat([header, body]);
}

/** PostgreSQL `ErrorResponse` ('E') with the fields a real server sends before closing. */
function pgError(code: string, message: string): Buffer {
  const fields = Buffer.concat([
    Buffer.from('SFATAL\0', 'latin1'),
    Buffer.from('VFATAL\0', 'latin1'),
    Buffer.from(`C${code}\0`, 'latin1'),
    Buffer.from(`M${message}\0`, 'latin1'),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(5);
  header.write('E', 0, 'latin1');
  header.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([header, fields]);
}

/** MySQL initial handshake (protocol 10) advertising `mysql_native_password`, no TLS. */
function mysqlHandshake(): Buffer {
  const capabilities = 0x00088200; // PROTOCOL_41 | SECURE_CONNECTION | PLUGIN_AUTH
  const lower = Buffer.alloc(2);
  lower.writeUInt16LE(capabilities & 0xffff);
  const upper = Buffer.alloc(2);
  upper.writeUInt16LE((capabilities >>> 16) & 0xffff);
  const connectionId = Buffer.alloc(4);
  connectionId.writeUInt32LE(1);
  return packet(
    0,
    Buffer.concat([
      Buffer.from([0x0a]),
      Buffer.from('8.0.0-fake\0', 'latin1'),
      connectionId,
      Buffer.from('12345678', 'latin1'),
      Buffer.from([0]),
      lower,
      Buffer.from([33]),
      Buffer.from([0x02, 0x00]),
      upper,
      Buffer.from([21]),
      Buffer.alloc(10),
      Buffer.from('abcdefghijkl\0', 'latin1'),
      Buffer.from('mysql_native_password\0', 'latin1'),
    ])
  );
}

/** MySQL `ERR` packet: 0xff, error code, `#` + SQLSTATE, message. */
function mysqlError(errno: number, sqlState: string, message: string): Buffer {
  const body = Buffer.concat([
    Buffer.from([0xff]),
    Buffer.from([errno & 0xff, (errno >> 8) & 0xff]),
    Buffer.from('#', 'latin1'),
    Buffer.from(sqlState, 'latin1'),
    Buffer.from(message, 'utf8'),
  ]);
  return packet(2, body);
}

const servers: net.Server[] = [];

async function listen(handler: (socket: net.Socket) => void): Promise<number> {
  const server = net.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

/** A PostgreSQL endpoint that answers every startup with one ErrorResponse and closes. */
function pgRejecting(code: string, message: string, acceptSsl = false): Promise<number> {
  return listen((socket) => {
    let startup = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      const requestCode = chunk.length >= 8 ? chunk.readInt32BE(4) : 0;
      if (requestCode === 80877103) {
        socket.write(acceptSsl ? 'S' : 'N');
        return;
      }
      if (startup) return;
      startup = true;
      socket.end(pgError(code, message));
    });
  });
}

/** A MySQL endpoint that completes the handshake shape then answers with one ERR packet. */
function mysqlRejecting(errno: number, sqlState: string, message: string): Promise<number> {
  return listen((socket) => {
    socket.on('error', () => {});
    socket.write(mysqlHandshake());
    socket.once('data', () => socket.end(mysqlError(errno, sqlState, message)));
  });
}

const int32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
};
const int16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
};
const cstr = (value: string): Buffer => Buffer.from(`${value}\0`, 'latin1');

/** One PostgreSQL backend message: type byte + length + body. */
function pgMessage(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'latin1');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

/** A PostgreSQL endpoint that authenticates anyone and answers `select 1`. */
function pgAccepting(): Promise<number> {
  return listen((socket) => {
    socket.on('error', () => {});
    let startup = false;
    socket.on('data', (chunk) => {
      if (chunk.length >= 8 && chunk.readInt32BE(4) === 80877103) {
        socket.write('N');
        return;
      }
      if (!startup) {
        startup = true;
        socket.write(
          Buffer.concat([
            pgMessage('R', int32(0)),
            pgMessage('S', Buffer.concat([cstr('server_version'), cstr('16.0')])),
            pgMessage('K', Buffer.concat([int32(1234), int32(5678)])),
            pgMessage('Z', Buffer.from('I', 'latin1')),
          ])
        );
        return;
      }
      if (chunk[0] === 0x51) {
        // Query: one text column "?column?" holding "1", then CommandComplete + ReadyForQuery.
        const field = Buffer.concat([
          cstr('?column?'),
          int32(0),
          int16(0),
          int32(23),
          int16(4),
          int32(-1),
          int16(0),
        ]);
        socket.write(
          Buffer.concat([
            pgMessage('T', Buffer.concat([int16(1), field])),
            pgMessage('D', Buffer.concat([int16(1), int32(1), Buffer.from('1', 'latin1')])),
            pgMessage('C', cstr('SELECT 1')),
            pgMessage('Z', Buffer.from('I', 'latin1')),
          ])
        );
        return;
      }
      if (chunk[0] === 0x58) socket.end();
    });
  });
}

/** A MySQL endpoint that accepts the handshake and answers COM_PING. */
function mysqlAccepting(): Promise<number> {
  return listen((socket) => {
    socket.on('error', () => {});
    socket.write(mysqlHandshake());
    let authenticated = false;
    socket.on('data', (chunk) => {
      const command = chunk[4];
      if (!authenticated) {
        authenticated = true;
        socket.write(packet(2, Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00])));
        return;
      }
      if (command === 0x0e) {
        socket.write(packet(1, Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00])));
        return;
      }
      if (command === 0x01) socket.end();
    });
  });
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

const POSTGRES = { engine: 'postgres', user: 'ocr', password: 'ocr-secret', database: 'ocrdb' } as const;
const MYSQL = { engine: 'mysql', user: 'ocr', password: 'ocr-secret', database: 'ocrdb' } as const;

describe('dbEngineFor', () => {
  it('claims exactly the two engines it can test', () => {
    expect(dbEngineFor('postgres')).toBe('postgres');
    expect(dbEngineFor('PostgreSQL')).toBe('postgres');
    expect(dbEngineFor('mysql')).toBe('mysql');
    expect(dbEngineFor('mariadb')).toBe('mysql');
    expect(dbEngineFor('mongodb')).toBeNull();
    expect(dbEngineFor('')).toBeNull();
  });
});

describe('probeDatabase — verdicts', () => {
  it('reports a PostgreSQL password rejection as auth_failed', async () => {
    const port = await pgRejecting('28P01', 'password authentication failed for user "ocr"');
    const result = await probeDatabase({ ...POSTGRES, host: '127.0.0.1', port, params: { sslmode: 'disable' } });
    expect(result.code).toBe('auth_failed');
    expect(result.reachable).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.message).toContain('password authentication failed');
  });

  it('falls back to plaintext when the server refuses TLS, and still names the failure', async () => {
    const port = await pgRejecting('28P01', 'password authentication failed for user "ocr"');
    const result = await probeDatabase({ ...POSTGRES, host: '127.0.0.1', port, params: {} });
    expect(result.code).toBe('auth_failed');
    expect(result.verified).toBe(false);
  });

  it('reports a PostgreSQL missing database as database_missing', async () => {
    const port = await pgRejecting('3D000', 'database "ocrdb" does not exist');
    const result = await probeDatabase({ ...POSTGRES, host: '127.0.0.1', port, params: { sslmode: 'disable' } });
    expect(result.code).toBe('database_missing');
    expect(result.verified).toBe(false);
  });

  it('reports a MySQL access denial as auth_failed', async () => {
    const port = await mysqlRejecting(1045, '28000', "Access denied for user 'ocr'@'localhost' (using password: YES)");
    const result = await probeDatabase({ ...MYSQL, host: '127.0.0.1', port, params: { sslmode: 'disable' } });
    expect(result.code).toBe('auth_failed');
    expect(result.reachable).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.message).toContain('Access denied');
  });

  it('reports a MySQL unknown database as database_missing', async () => {
    const port = await mysqlRejecting(1049, '42000', "Unknown database 'ocrdb'");
    const result = await probeDatabase({ ...MYSQL, host: '127.0.0.1', port, params: { sslmode: 'disable' } });
    expect(result.code).toBe('database_missing');
    expect(result.verified).toBe(false);
  });

  it('verifies a PostgreSQL login and select 1', async () => {
    const port = await pgAccepting();
    const result = await probeDatabase({ ...POSTGRES, host: '127.0.0.1', port, params: { sslmode: 'disable' } });
    expect(result).toMatchObject({ code: 'ok', reachable: true, verified: true });
  });

  it('verifies a MySQL login and ping', async () => {
    const port = await mysqlAccepting();
    const result = await probeDatabase({ ...MYSQL, host: '127.0.0.1', port, params: { sslmode: 'disable' } });
    expect(result).toMatchObject({ code: 'ok', reachable: true, verified: true });
  });

  it('reports a closed port as refused for both engines', async () => {
    const port = await closedPort();
    const pg = await probeDatabase({ ...POSTGRES, host: '127.0.0.1', port, params: { sslmode: 'disable' } });
    const my = await probeDatabase({ ...MYSQL, host: '127.0.0.1', port, params: { sslmode: 'disable' } });
    expect(pg).toMatchObject({ code: 'refused', reachable: false, verified: false });
    expect(my).toMatchObject({ code: 'refused', reachable: false, verified: false });
  });
});
