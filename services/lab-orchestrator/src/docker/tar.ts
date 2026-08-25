/**
 * A deliberately small tar reader.
 *
 * `docker cp <container>:<path> -` answers with a tar stream, and this reads
 * exactly one regular file out of it. It is **not** an extractor: it never
 * writes to disk, never follows a link, never walks a directory, and refuses an
 * archive that carries more than one entry. That is what keeps
 * `copyFileFromContainer` a single-file read rather than a way to browse a
 * container's filesystem.
 *
 * Only the fields a single-file read needs are parsed — name, size, and type —
 * from the POSIX ustar header (512-byte blocks, size as octal ASCII at offset
 * 124, type flag at offset 156). Everything else in the header is ignored
 * rather than trusted.
 *
 * Reference: the ustar header layout, as documented by GNU tar and POSIX.
 */

/** Header fields we read, and nothing else. */
const BLOCK = 512;
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const TYPE_OFFSET = 156;

/** Type flags for a regular file. Historic tars wrote NUL; ustar writes '0'. */
const REGULAR_TYPES = new Set(['0', '\0']);

export class TarReadError extends Error {
  readonly code = 'TAR_READ_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'TarReadError';
  }
}

export interface TarEntry {
  name: string;
  size: number;
  content: Buffer;
  /** True when `content` stops short of `size` because of the caller's cap. */
  truncated: boolean;
}

function readString(buffer: Buffer, offset: number, length: number): string {
  const raw = buffer.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

/**
 * Parse the octal size field.
 *
 * A malformed or absent size is an error rather than a zero: silently reading
 * "nothing" out of a file we failed to understand would look like an empty
 * file, and a lab would then grade a parse failure as a wrong answer.
 */
function readOctalSize(buffer: Buffer): number {
  const text = readString(buffer, SIZE_OFFSET, SIZE_LENGTH).trim();
  if (!/^[0-7]+$/.test(text)) {
    throw new TarReadError('archive header has an unreadable size field');
  }
  const size = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TarReadError('archive header declares an implausible size');
  }
  return size;
}

/** True for the all-zero block that marks end of archive. */
function isEndBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

/**
 * Read the single regular file an archive contains.
 *
 * @param archive the raw tar bytes
 * @param maxBytes how much file content to keep; the rest is discarded and the
 *        entry is marked truncated
 *
 * Throws when the archive holds a directory, a link, or more than one entry —
 * all of which mean the caller asked for something other than one file.
 */
export function readSingleFile(archive: Buffer, maxBytes: number): TarEntry {
  if (archive.length === 0) throw new TarReadError('archive is empty');

  let offset = 0;
  let found: TarEntry | undefined;

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (isEndBlock(header)) break;

    const name = readString(header, NAME_OFFSET, NAME_LENGTH);
    const size = readOctalSize(header);
    const type = String.fromCharCode(header[TYPE_OFFSET] ?? 0);
    offset += BLOCK;

    if (!REGULAR_TYPES.has(type)) {
      // A directory ('5'), symlink ('2'), hardlink ('1') or device. The caller
      // asked for a file; anything else is refused rather than followed.
      throw new TarReadError(
        type === '5'
          ? 'the path names a directory, not a file'
          : 'the path does not name a regular file',
      );
    }
    if (found) throw new TarReadError('archive contains more than one file');

    const available = Math.min(size, Math.max(0, archive.length - offset));
    const kept = Math.min(available, maxBytes);
    found = {
      name,
      size,
      content: Buffer.from(archive.subarray(offset, offset + kept)),
      truncated: kept < size,
    };

    // Entries are padded to a block boundary.
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  if (!found) throw new TarReadError('archive contains no file');
  return found;
}
