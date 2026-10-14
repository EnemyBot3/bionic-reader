import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { createZip } from './zip';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

async function read(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, view: new DataView(bytes.buffer) };
}

describe('createZip', () => {
  it('writes a readable archive with every entry listed', async () => {
    const zip = createZip([
      { path: 'mimetype', data: 'application/epub+zip' },
      { path: 'OEBPS/one.xhtml', data: '<p>one</p>' },
      { path: 'OEBPS/two.xhtml', data: '<p>two</p>' },
    ]);
    const { view, bytes } = await read(zip);

    expect(view.getUint32(0, true)).toBe(LOCAL_HEADER);

    const end = bytes.length - 22;
    expect(view.getUint32(end, true)).toBe(END_OF_CENTRAL);
    expect(view.getUint16(end + 8, true)).toBe(3);
    expect(view.getUint16(end + 10, true)).toBe(3);

    const centralOffset = view.getUint32(end + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(CENTRAL_HEADER);
  });

  it('puts mimetype first and stores it uncompressed, as EPUB requires', async () => {
    const zip = createZip([
      { path: 'mimetype', data: 'application/epub+zip' },
      { path: 'other', data: 'x' },
    ]);
    const { view, bytes } = await read(zip);

    expect(view.getUint16(8, true)).toBe(0); // method 0 is stored
    const nameLength = view.getUint16(26, true);
    const name = new TextDecoder().decode(bytes.slice(30, 30 + nameLength));
    expect(name).toBe('mimetype');

    const body = new TextDecoder().decode(
      bytes.slice(30 + nameLength, 30 + nameLength + 20),
    );
    expect(body).toBe('application/epub+zip');
  });

  it('writes a checksum a zip reader will accept', async () => {
    const payload = 'The lighthouse keeper watched the light fade.';
    const { view } = await read(createZip([{ path: 'a.txt', data: payload }]));

    expect(view.getUint32(14, true)).toBe(crc32(Buffer.from(payload)));
  });

  it('records the real size of each entry', async () => {
    const payload = 'x'.repeat(5_000);
    const { view } = await read(
      createZip([{ path: 'big.txt', data: payload }]),
    );

    expect(view.getUint32(18, true)).toBe(5_000); // compressed
    expect(view.getUint32(22, true)).toBe(5_000); // uncompressed
  });

  it('handles text outside ASCII without corrupting the length', async () => {
    const payload = 'Café — naïve — 日本語';
    const encoded = new TextEncoder().encode(payload);
    const { view } = await read(createZip([{ path: 'u.txt', data: payload }]));

    expect(view.getUint32(22, true)).toBe(encoded.length);
    expect(view.getUint32(14, true)).toBe(crc32(Buffer.from(payload, 'utf8')));
  });
});
