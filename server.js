import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, normalize } from 'node:path';
import Busboy from 'busboy';
import { Pool } from 'pg';

const PORT = Number(process.env.METADATA_PORT || 8873);
const DATABASE_URL = process.env.METADATA_DATABASE_URL || '';
const PUBLIC_DIR = join(process.cwd(), 'public');
const ONE_GIB = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = parsePositiveInt(process.env.METADATA_MAX_FILE_BYTES, ONE_GIB);
const SAMPLE_BYTES = Math.min(parsePositiveInt(process.env.METADATA_SAMPLE_BYTES, 8 * 1024 * 1024), MAX_FILE_BYTES);
const MULTIPART_OVERHEAD_BYTES = 2 * 1024 * 1024;
const MAX_FILENAME_CHARS = 160;
const LIMIT_MESSAGE = 'El archivo supera el limite maximo permitido de 1 GB. Selecciona un archivo mas pequeno para extraer sus metadatos.';

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, max: 6, idleTimeoutMillis: 20_000 })
  : null;

const staticMime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

class RequestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function initDb() {
  if (!pool) return;
  await pool.query(`
    create table if not exists file_metadata_analyses (
      id bigserial primary key,
      original_name text not null,
      extension text,
      mime_type text,
      file_size_bytes bigint not null check (file_size_bytes >= 0 and file_size_bytes <= 1073741824),
      metadata jsonb not null,
      created_at timestamptz not null default now()
    );

    create index if not exists file_metadata_analyses_created_at_idx
      on file_metadata_analyses (created_at desc);

    create index if not exists file_metadata_analyses_mime_type_idx
      on file_metadata_analyses (mime_type);
  `);
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}

function sanitizeFilename(filename) {
  const cleaned = basename(String(filename || 'unnamed-file'))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'unnamed-file').slice(0, MAX_FILENAME_CHARS);
}

function sanitizeMime(mimeType) {
  return String(mimeType || 'application/octet-stream')
    .toLowerCase()
    .replace(/[^a-z0-9.+/-]/g, '')
    .slice(0, 120) || 'application/octet-stream';
}

function getFileExtension(filename) {
  const extension = extname(filename || '').toLowerCase();
  return extension && extension.length <= 24 ? extension : '';
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function getContentLength(req) {
  const raw = req.headers['content-length'];
  const parsed = Number.parseInt(Array.isArray(raw) ? raw[0] : raw || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function parseFileUpload(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('multipart/form-data')) {
    throw new RequestError(415, 'La solicitud debe enviar un archivo usando multipart/form-data.');
  }

  const contentLength = getContentLength(req);
  if (contentLength && contentLength > MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES) {
    throw new RequestError(413, LIMIT_MESSAGE);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let fileSeen = false;
    let originalName = 'unnamed-file';
    let declaredMimeType = 'application/octet-stream';
    let encoding = '';
    let sizeBytes = 0;
    let sampleBytes = 0;
    const sampleChunks = [];

    function fail(error) {
      if (settled) return;
      settled = true;
      req.unpipe(busboy);
      req.resume();
      reject(error);
    }

    const busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fields: 0,
        parts: 2,
        fileSize: MAX_FILE_BYTES
      }
    });

    busboy.on('file', (_fieldname, file, info) => {
      if (fileSeen) {
        file.resume();
        fail(new RequestError(400, 'Solo se permite un archivo por analisis.'));
        return;
      }

      fileSeen = true;
      originalName = sanitizeFilename(info.filename);
      declaredMimeType = sanitizeMime(info.mimeType);
      encoding = String(info.encoding || '').slice(0, 40);

      file.on('data', (chunk) => {
        sizeBytes += chunk.length;
        if (sampleBytes < SAMPLE_BYTES) {
          const next = chunk.subarray(0, Math.min(chunk.length, SAMPLE_BYTES - sampleBytes));
          sampleChunks.push(next);
          sampleBytes += next.length;
        }
      });

      file.on('limit', () => {
        fail(new RequestError(413, LIMIT_MESSAGE));
      });

      file.on('error', (error) => {
        fail(error);
      });
    });

    busboy.on('filesLimit', () => {
      fail(new RequestError(400, 'Solo se permite un archivo por analisis.'));
    });

    busboy.on('fieldsLimit', () => {
      fail(new RequestError(400, 'El formulario solo debe contener el archivo a analizar.'));
    });

    busboy.on('partsLimit', () => {
      fail(new RequestError(400, 'El formulario solo debe contener un archivo.'));
    });

    busboy.on('error', (error) => {
      fail(error);
    });

    busboy.on('close', () => {
      if (settled) return;
      if (!fileSeen) {
        fail(new RequestError(400, 'Selecciona un archivo para extraer sus metadatos.'));
        return;
      }
      settled = true;
      resolve({
        originalName,
        extension: getFileExtension(originalName),
        declaredMimeType,
        encoding,
        sizeBytes,
        sample: Buffer.concat(sampleChunks, sampleBytes)
      });
    });

    req.on('aborted', () => {
      fail(new RequestError(400, 'La carga del archivo fue interrumpida.'));
    });

    req.pipe(busboy);
  });
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function readAscii(buffer, start, length) {
  return buffer.subarray(start, start + length).toString('ascii');
}

function hasMagic(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function parsePngMetadata(buffer) {
  if (buffer.length < 33 || !hasMagic(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  return {
    format: 'PNG',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    compression: buffer[26],
    interlace: buffer[28] === 1 ? 'Adam7' : 'none'
  };
}

function parseGifMetadata(buffer) {
  if (buffer.length < 10) return null;
  const signature = readAscii(buffer, 0, 6);
  if (!['GIF87a', 'GIF89a'].includes(signature)) return null;
  return {
    format: 'GIF',
    version: signature.slice(3),
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8)
  };
}

function parseExifOrientation(segment) {
  if (segment.length < 14 || readAscii(segment, 0, 6) !== 'Exif\u0000\u0000') return null;
  const tiffStart = 6;
  const endian = readAscii(segment, tiffStart, 2);
  const littleEndian = endian === 'II';
  if (!littleEndian && endian !== 'MM') return null;

  const read16 = (offset) => littleEndian ? segment.readUInt16LE(offset) : segment.readUInt16BE(offset);
  const read32 = (offset) => littleEndian ? segment.readUInt32LE(offset) : segment.readUInt32BE(offset);
  if (read16(tiffStart + 2) !== 42) return null;

  const ifdOffset = tiffStart + read32(tiffStart + 4);
  if (ifdOffset + 2 > segment.length) return null;
  const entryCount = read16(ifdOffset);

  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (entryOffset + 12 > segment.length) break;
    const tag = read16(entryOffset);
    const type = read16(entryOffset + 2);
    const count = read32(entryOffset + 4);
    if (tag === 0x0112 && type === 3 && count === 1) {
      return littleEndian ? segment.readUInt16LE(entryOffset + 8) : segment.readUInt16BE(entryOffset + 8);
    }
  }
  return null;
}

function parseJpegMetadata(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const result = { format: 'JPEG' };
  let offset = 2;

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;

    const segmentStart = offset + 2;
    const segmentEnd = offset + segmentLength;
    const isStartOfFrame = [
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
    ].includes(marker);

    if (isStartOfFrame && segmentStart + 5 < segmentEnd) {
      result.precision = buffer[segmentStart];
      result.height = buffer.readUInt16BE(segmentStart + 1);
      result.width = buffer.readUInt16BE(segmentStart + 3);
      result.encoding = marker === 0xc2 ? 'progressive' : 'baseline';
    }

    if (marker === 0xe1 && !result.orientation) {
      const orientation = parseExifOrientation(buffer.subarray(segmentStart, segmentEnd));
      if (orientation) result.orientation = orientation;
    }

    offset = segmentEnd;
  }

  return result;
}

function parseWebpMetadata(buffer) {
  if (buffer.length < 16 || readAscii(buffer, 0, 4) !== 'RIFF' || readAscii(buffer, 8, 4) !== 'WEBP') return null;
  const chunkType = readAscii(buffer, 12, 4);
  const result = { format: 'WebP', chunkType };

  if (chunkType === 'VP8X' && buffer.length >= 30) {
    result.width = readUInt24LE(buffer, 24) + 1;
    result.height = readUInt24LE(buffer, 27) + 1;
    result.alpha = Boolean(buffer[20] & 0x10);
    result.animation = Boolean(buffer[20] & 0x02);
  } else if (chunkType === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    result.width = (bits & 0x3fff) + 1;
    result.height = ((bits >> 14) & 0x3fff) + 1;
  } else if (chunkType === 'VP8 ' && buffer.length >= 30) {
    result.width = buffer.readUInt16LE(26) & 0x3fff;
    result.height = buffer.readUInt16LE(28) & 0x3fff;
  }

  return result;
}

function parsePdfMetadata(buffer) {
  if (buffer.length < 8 || readAscii(buffer, 0, 5) !== '%PDF-') return null;
  const sampleText = buffer.toString('latin1');
  const pageMarkers = sampleText.match(/\/Type\s*\/Page\b/g) || [];
  return {
    format: 'PDF',
    version: sampleText.slice(5, 8),
    pageMarkersInSample: pageMarkers.length,
    sampledBytes: buffer.length
  };
}

function parseZipMetadata(buffer, extension) {
  if (buffer.length < 4 || !hasMagic(buffer, [0x50, 0x4b, 0x03, 0x04])) return null;
  const officeExtensions = new Set(['.docx', '.xlsx', '.pptx']);
  return {
    format: officeExtensions.has(extension) ? 'OpenXML package' : 'ZIP archive',
    container: 'zip'
  };
}

function parseMp4Metadata(buffer) {
  if (buffer.length < 12 || readAscii(buffer, 4, 4) !== 'ftyp') return null;
  return {
    format: 'ISO base media',
    majorBrand: readAscii(buffer, 8, 4).trim(),
    compatibleBrands: buffer.length > 16
      ? readAscii(buffer, 16, Math.min(buffer.length - 16, 32)).match(/.{1,4}/g)?.map((brand) => brand.trim()).filter(Boolean) || []
      : []
  };
}

function detectMagicMetadata(buffer, extension) {
  return (
    parsePngMetadata(buffer) ||
    parseJpegMetadata(buffer) ||
    parseGifMetadata(buffer) ||
    parseWebpMetadata(buffer) ||
    parsePdfMetadata(buffer) ||
    parseZipMetadata(buffer, extension) ||
    parseMp4Metadata(buffer)
  );
}

function detectMimeFromMagic(buffer, fallbackMime, extension) {
  if (parsePngMetadata(buffer)) return 'image/png';
  if (parseJpegMetadata(buffer)) return 'image/jpeg';
  if (parseGifMetadata(buffer)) return 'image/gif';
  if (parseWebpMetadata(buffer)) return 'image/webp';
  if (parsePdfMetadata(buffer)) return 'application/pdf';
  if (parseZipMetadata(buffer, extension)) {
    if (extension === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (extension === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (extension === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    return 'application/zip';
  }
  if (parseMp4Metadata(buffer)) return 'video/mp4';
  return fallbackMime;
}

function classifyFile(upload) {
  const magic = detectMagicMetadata(upload.sample, upload.extension);
  const inferredMime = detectMimeFromMagic(upload.sample, upload.declaredMimeType, upload.extension);
  const category = inferredMime.includes('/') ? inferredMime.split('/')[0] : 'unknown';

  return {
    detectedType: magic?.format || 'generic file',
    category,
    declaredMimeType: upload.declaredMimeType,
    inferredMimeType: inferredMime,
    parserSampleBytes: upload.sample.length,
    typeMetadata: magic || {}
  };
}

async function saveAnalysis(result) {
  if (!pool) return result;
  const { rows } = await pool.query(
    `insert into file_metadata_analyses
       (original_name, extension, mime_type, file_size_bytes, metadata, created_at)
     values ($1, $2, $3, $4, $5, $6)
     returning id, created_at`,
    [
      result.originalName,
      result.extension || null,
      result.mimeType,
      result.sizeBytes,
      result.metadata,
      result.analyzedAt
    ]
  );
  return {
    ...result,
    id: rows[0].id,
    analyzedAt: rows[0].created_at
  };
}

async function analyzeFile(req) {
  const upload = await parseFileUpload(req);
  const detected = classifyFile(upload);
  const analyzedAt = new Date().toISOString();
  const result = {
    originalName: upload.originalName,
    extension: upload.extension,
    mimeType: detected.inferredMimeType,
    declaredMimeType: upload.declaredMimeType,
    sizeBytes: upload.sizeBytes,
    sizeHuman: formatBytes(upload.sizeBytes),
    analyzedAt,
    metadata: {
      file: {
        name: upload.originalName,
        extension: upload.extension || 'none',
        sizeBytes: upload.sizeBytes,
        sizeHuman: formatBytes(upload.sizeBytes),
        encoding: upload.encoding || 'not provided'
      },
      detection: detected,
      safety: {
        maxFileSizeBytes: MAX_FILE_BYTES,
        maxFileSizeHuman: formatBytes(MAX_FILE_BYTES),
        fileStored: false,
        publicLinkCreated: false,
        retainedContent: false,
        note: 'Only technical metadata is stored; uploaded file bytes are streamed and discarded.'
      }
    }
  };

  return saveAnalysis(result);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rawPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = normalize(rawPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': staticMime[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': rawPath === '/index.html' ? 'no-store' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { ok: false, error: 'Not found' });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/health') {
      let database = 'disabled';
      if (pool) {
        await pool.query('select 1');
        database = 'postgresql';
      }
      sendJson(res, 200, {
        ok: true,
        service: 'metadata',
        mode: 'file-metadata',
        database,
        maxFileBytes: MAX_FILE_BYTES,
        time: new Date().toISOString()
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      const result = await analyzeFile(req);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    const status = error.statusCode || 400;
    sendJson(res, status, { ok: false, error: error.message || 'Request failed' });
  }
});

await initDb();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Metadata file analyzer listening on ${PORT}`);
});
