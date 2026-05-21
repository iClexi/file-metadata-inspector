import { createHmac, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import { Pool } from 'pg';

const PORT = Number(process.env.METADATA_PORT || 8873);
const DATABASE_URL = process.env.METADATA_DATABASE_URL || '';
const APP_SECRET = process.env.METADATA_APP_SECRET || '';
const PUBLIC_DIR = join(process.cwd(), 'public');
const ONE_GIB = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = parsePositiveInt(process.env.METADATA_MAX_FILE_BYTES, ONE_GIB);
const SAMPLE_BYTES = Math.min(parsePositiveInt(process.env.METADATA_SAMPLE_BYTES, 8 * 1024 * 1024), MAX_FILE_BYTES);
const MULTIPART_OVERHEAD_BYTES = 2 * 1024 * 1024;
const MAX_FILENAME_CHARS = 160;
const MAX_JSON_BYTES = 64 * 1024;
const AUTH_COOKIE = 'metadata_session';
const SESSION_TTL_SECONDS = Math.max(3600, parsePositiveInt(process.env.METADATA_SESSION_TTL_SECONDS, 30 * 24 * 60 * 60));
const PASSWORD_ITERATIONS = Math.max(120_000, parsePositiveInt(process.env.METADATA_PASSWORD_ITERATIONS, 210_000));
const ADMIN_EMAIL = normalizeEmail(process.env.METADATA_ADMIN_EMAIL || '');
const ADMIN_USERNAME = cleanUsername(process.env.METADATA_ADMIN_USERNAME || 'iClexi');
const ADMIN_PASSWORD = String(process.env.METADATA_ADMIN_PASSWORD || '');
const EXIFTOOL_BIN = process.env.METADATA_EXIFTOOL_BIN || 'exiftool';
const LIMIT_MESSAGE = 'El archivo supera el limite maximo permitido de 1 GB. Selecciona un archivo mas pequeno para trabajar sus metadatos.';
const EDITABLE_METADATA_FIELDS = {
  title: { tag: 'Title', label: 'Titulo', maxLength: 180 },
  description: { tag: 'Description', label: 'Descripcion', maxLength: 1000 },
  author: { tag: 'Author', label: 'Autor', maxLength: 180 },
  copyright: { tag: 'Copyright', label: 'Copyright', maxLength: 240 },
  keywords: { tag: 'Keywords', label: 'Palabras clave', maxLength: 500 },
  comment: { tag: 'Comment', label: 'Comentario', maxLength: 500 }
};

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, max: 6, idleTimeoutMillis: 20_000 })
  : null;

if (pool && APP_SECRET.length < 24) {
  console.error('METADATA_APP_SECRET is required and must be at least 24 characters.');
  process.exit(1);
}

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
    create table if not exists users (
      id uuid primary key,
      username text not null,
      email text not null,
      email_normalized text not null unique,
      password_hash text not null,
      password_salt text not null,
      password_iterations integer not null default 210000,
      role text not null default 'user',
      created_ip text not null default '',
      created_user_agent text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create unique index if not exists users_username_lower_idx on users (lower(username));
    create index if not exists users_created_at_idx on users (created_at desc);

    alter table users
      add column if not exists role text not null default 'user';

    create table if not exists user_sessions (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      token_hash text not null unique,
      device_label text not null default '',
      ip text not null default '',
      user_agent text not null default '',
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      expires_at timestamptz not null,
      revoked_at timestamptz
    );

    create index if not exists user_sessions_user_id_idx on user_sessions (user_id, created_at desc);
    create index if not exists user_sessions_token_hash_idx on user_sessions (token_hash);

    create table if not exists user_events (
      id bigserial primary key,
      user_id uuid references users(id) on delete set null,
      event_type text not null,
      entity_type text not null default '',
      entity_id text not null default '',
      ip text not null default '',
      user_agent text not null default '',
      details jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create index if not exists user_events_user_id_idx on user_events (user_id, created_at desc);
    create index if not exists user_events_created_at_idx on user_events (created_at desc);

    create table if not exists request_telemetry (
      id bigserial primary key,
      user_id uuid references users(id) on delete set null,
      session_id uuid,
      method text not null,
      path text not null,
      ip text not null default '',
      user_agent text not null default '',
      device_label text not null default '',
      browser text not null default '',
      os text not null default '',
      device_type text not null default '',
      referer text not null default '',
      accept_language text not null default '',
      cf_country text not null default '',
      details jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create index if not exists request_telemetry_created_at_idx
      on request_telemetry (created_at desc);
    create index if not exists request_telemetry_ip_idx
      on request_telemetry (ip, created_at desc);
    create index if not exists request_telemetry_user_id_idx
      on request_telemetry (user_id, created_at desc);

    create table if not exists admin_blocks (
      id uuid primary key,
      block_type text not null check (block_type in ('ip', 'user')),
      value text not null,
      reason text not null default '',
      created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default now(),
      expires_at timestamptz,
      revoked_at timestamptz
    );

    create unique index if not exists admin_blocks_active_idx
      on admin_blocks (block_type, lower(value))
      where revoked_at is null;

    create table if not exists file_metadata_analyses (
      id bigserial primary key,
      user_id uuid references users(id) on delete set null,
      original_name text not null,
      extension text,
      mime_type text,
      file_size_bytes bigint not null check (file_size_bytes >= 0 and file_size_bytes <= 1073741824),
      metadata jsonb not null,
      created_at timestamptz not null default now()
    );

    alter table file_metadata_analyses
      add column if not exists user_id uuid references users(id) on delete set null;

    create index if not exists file_metadata_analyses_created_at_idx
      on file_metadata_analyses (created_at desc);

    create index if not exists file_metadata_analyses_mime_type_idx
      on file_metadata_analyses (mime_type);

    create index if not exists file_metadata_analyses_user_id_idx
      on file_metadata_analyses (user_id, created_at desc);
  `);
  await ensureAdminUser();
}

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
};

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders,
    ...headers
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

function editedDownloadName(filename) {
  const safeName = sanitizeFilename(filename);
  const extension = extname(safeName);
  const stem = extension ? safeName.slice(0, -extension.length) : safeName;
  return `${stem || 'archivo'}.metadata${extension || ''}`;
}

function contentDisposition(filename) {
  const asciiName = sanitizeFilename(filename)
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function cleanMetadataValue(value, field) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (text.length > field.maxLength) {
    throw new RequestError(400, `${field.label} supera el limite de ${field.maxLength} caracteres.`);
  }
  return text;
}

function sanitizeMetadataEdits(rawValue) {
  let payload;
  try {
    payload = JSON.parse(String(rawValue || '{}'));
  } catch {
    throw new RequestError(400, 'La metadata enviada no es JSON valido.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError(400, 'La metadata debe enviarse como objeto JSON.');
  }

  const allowedKeys = new Set(Object.keys(EDITABLE_METADATA_FIELDS));
  const unknownKeys = Object.keys(payload).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    throw new RequestError(400, 'El formulario incluye campos de metadata no permitidos.');
  }

  const edits = {};
  for (const [key, field] of Object.entries(EDITABLE_METADATA_FIELDS)) {
    const value = cleanMetadataValue(payload[key], field);
    if (value) edits[key] = value;
  }
  if (!Object.keys(edits).length) {
    throw new RequestError(400, 'Completa al menos un campo de metadata para crear el archivo actualizado.');
  }
  return edits;
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

function hmac(value) {
  return createHmac('sha256', APP_SECRET).update(value).digest('hex');
}

function sessionTokenHash(token) {
  return hmac(`session:${token}`);
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0]?.trim() || '';
  return (xff || req.socket.remoteAddress || '').slice(0, 80);
}

function isSecureRequest(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0]?.trim().toLowerCase() || '';
  return forwardedProto === 'https' || Boolean(req.headers['cf-ray']);
}

function setCookie(req, res, name, value, maxAge) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('set-cookie', `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`);
}

function clearCookie(res, name) {
  res.setHeader('set-cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 160);
}

function cleanUsername(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 8) throw new RequestError(400, 'La contrasena debe tener al menos 8 caracteres.');
  if (password.length > 200) throw new RequestError(400, 'La contrasena es demasiado larga.');
  return password;
}

function passwordDigest(password, salt, iterations = PASSWORD_ITERATIONS) {
  return pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
}

function hashPassword(password) {
  const salt = randomBytes(18).toString('base64url');
  return {
    salt,
    iterations: PASSWORD_ITERATIONS,
    hash: passwordDigest(password, salt, PASSWORD_ITERATIONS)
  };
}

function timingSafeStringEqual(a, b) {
  const first = Buffer.from(String(a || ''), 'utf8');
  const second = Buffer.from(String(b || ''), 'utf8');
  if (first.length !== second.length) return false;
  return timingSafeEqual(first, second);
}

function verifyPassword(password, user) {
  const digest = passwordDigest(password, user.password_salt, Number(user.password_iterations || PASSWORD_ITERATIONS));
  return timingSafeStringEqual(digest, user.password_hash);
}

async function ensureAdminUser() {
  if (!pool || !ADMIN_EMAIL || !ADMIN_USERNAME || !ADMIN_PASSWORD) return;
  const password = validatePassword(ADMIN_PASSWORD);
  const digest = hashPassword(password);
  const existing = await pool.query('select id from users where email_normalized = $1 limit 1', [ADMIN_EMAIL]);
  if (existing.rows[0]) {
    await pool.query(
      `update users
       set username = $2,
           email = $3,
           role = 'admin',
           password_hash = $4,
           password_salt = $5,
           password_iterations = $6,
           updated_at = now()
       where id = $1`,
      [existing.rows[0].id, ADMIN_USERNAME, ADMIN_EMAIL, digest.hash, digest.salt, digest.iterations]
    );
    return;
  }
  try {
    await pool.query(
      `insert into users
         (id, username, email, email_normalized, password_hash, password_salt, password_iterations, role)
       values ($1, $2, $3, $4, $5, $6, $7, 'admin')`,
      [randomUUID(), ADMIN_USERNAME, ADMIN_EMAIL, ADMIN_EMAIL, digest.hash, digest.salt, digest.iterations]
    );
  } catch (error) {
    if (error?.code !== '23505') throw error;
    await pool.query(
      `update users
       set email = $2,
           email_normalized = $2,
           role = 'admin',
           password_hash = $3,
           password_salt = $4,
           password_iterations = $5,
           updated_at = now()
       where lower(username) = lower($1)`,
      [ADMIN_USERNAME, ADMIN_EMAIL, digest.hash, digest.salt, digest.iterations]
    );
  }
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role || 'user',
    created_at: row.created_at
  };
}

function parseUserAgent(userAgent = '') {
  const ua = String(userAgent);
  const lower = ua.toLowerCase();
  const device = /ipad|tablet/.test(lower) ? 'tablet' : /mobi|android|iphone/.test(lower) ? 'mobile' : 'desktop';
  const browser = /edg\//i.test(ua) ? 'Edge'
    : /chrome|chromium|crios/i.test(ua) ? 'Chrome'
      : /firefox|fxios/i.test(ua) ? 'Firefox'
        : /safari/i.test(ua) ? 'Safari'
          : 'Browser';
  const os = /windows/i.test(ua) ? 'Windows'
    : /android/i.test(ua) ? 'Android'
      : /iphone|ipad|ios/i.test(ua) ? 'iOS'
        : /mac os|macintosh/i.test(ua) ? 'macOS'
          : /linux/i.test(ua) ? 'Linux'
            : 'Sistema';
  return {
    browser,
    os,
    device,
    label: `${browser} · ${os} · ${device}`
  };
}

function describeUserAgent(userAgent = '') {
  return parseUserAgent(userAgent).label;
}

function shortHeader(value, maxLength = 240) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLength);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_JSON_BYTES) throw new RequestError(400, 'Solicitud demasiado grande.');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'JSON invalido.');
  }
}

function requireAuthReady() {
  if (!pool) throw new RequestError(503, 'La base de datos no esta disponible.');
  if (APP_SECRET.length < 24) throw new RequestError(503, 'La sesion no esta configurada.');
}

async function createSession(req, res, user) {
  requireAuthReady();
  const token = randomBytes(32).toString('base64url');
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 700);
  const sessionId = randomUUID();
  await pool.query(
    `insert into user_sessions (id, user_id, token_hash, device_label, ip, user_agent, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + ($7::int * interval '1 second'))`,
    [sessionId, user.id, sessionTokenHash(token), describeUserAgent(userAgent), clientIp(req), userAgent, SESSION_TTL_SECONDS]
  );
  setCookie(req, res, AUTH_COOKIE, token, SESSION_TTL_SECONDS);
  return sessionId;
}

async function currentAuth(req) {
  if (!pool || APP_SECRET.length < 24) return null;
  const token = parseCookies(req.headers.cookie || '')[AUTH_COOKIE] || '';
  if (!token) return null;
  const { rows } = await pool.query(
    `select s.id as session_id, s.created_at as session_created_at, s.last_seen_at, s.expires_at,
            u.id, u.username, u.email, u.role, u.created_at
     from user_sessions s
     join users u on u.id = s.user_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
     limit 1`,
    [sessionTokenHash(token)]
  );
  const row = rows[0];
  if (!row) return null;
  await pool.query(
    'update user_sessions set last_seen_at = now(), ip = $2, user_agent = $3, device_label = $4 where id = $1',
    [
      row.session_id,
      clientIp(req),
      String(req.headers['user-agent'] || '').slice(0, 700),
      describeUserAgent(req.headers['user-agent'] || '')
    ]
  ).catch(() => {});
  return { session_id: row.session_id, user: publicUser(row) };
}

async function logUserEvent(auth, req, eventType, entityType = '', entityId = '', details = {}) {
  if (!pool || !auth?.user?.id) return;
  await pool.query(
    `insert into user_events (user_id, event_type, entity_type, entity_id, ip, user_agent, details)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      auth.user.id,
      eventType,
      entityType,
      entityId,
      clientIp(req),
      String(req.headers['user-agent'] || '').slice(0, 700),
      JSON.stringify(details)
    ]
  ).catch(() => {});
}

function shouldLogTelemetry(method, pathname) {
  if (!pool) return false;
  if (pathname === '/api/health') return false;
  if (/\.(?:css|js|svg|ico|png|jpg|jpeg|webp|map)$/i.test(pathname)) return false;
  if (pathname.startsWith('/api/')) return true;
  return ['/', '/admin', '/terminos', '/condiciones', '/privacidad', '/cookies', '/terms', '/privacy'].includes(pathname);
}

function telemetryDetails(req) {
  return {
    host: shortHeader(req.headers.host, 160),
    cfRay: shortHeader(req.headers['cf-ray'], 120),
    secChUa: shortHeader(req.headers['sec-ch-ua'], 260),
    secChUaPlatform: shortHeader(req.headers['sec-ch-ua-platform'], 80),
    secChUaMobile: shortHeader(req.headers['sec-ch-ua-mobile'], 20)
  };
}

async function logRequestTelemetry(auth, req, url) {
  if (!shouldLogTelemetry(req.method || 'GET', url.pathname)) return;
  const userAgent = shortHeader(req.headers['user-agent'], 700);
  const parsed = parseUserAgent(userAgent);
  await pool.query(
    `insert into request_telemetry
       (user_id, session_id, method, path, ip, user_agent, device_label, browser, os, device_type,
        referer, accept_language, cf_country, details)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      auth?.user?.id || null,
      auth?.session_id || null,
      shortHeader(req.method || 'GET', 12),
      shortHeader(url.pathname, 220),
      clientIp(req),
      userAgent,
      parsed.label,
      parsed.browser,
      parsed.os,
      parsed.device,
      shortHeader(req.headers.referer, 500),
      shortHeader(req.headers['accept-language'], 260),
      shortHeader(req.headers['cf-ipcountry'], 20),
      JSON.stringify(telemetryDetails(req))
    ]
  ).catch(() => {});
}

function userBlockValues(auth) {
  if (!auth?.user) return [];
  return [
    auth.user.id,
    normalizeEmail(auth.user.email),
    cleanUsername(auth.user.username).toLowerCase()
  ].filter(Boolean);
}

async function enforceRequestBlocks(req, auth, url) {
  if (!pool || auth?.user?.role === 'admin') return;
  if (!url.pathname.startsWith('/api/') || url.pathname === '/api/health' || url.pathname === '/api/auth/me') return;
  const values = userBlockValues(auth);
  const { rows } = await pool.query(
    `select block_type, value, reason
     from admin_blocks
     where revoked_at is null
       and (expires_at is null or expires_at > now())
       and (
         (block_type = 'ip' and lower(value) = lower($1))
         or (block_type = 'user' and lower(value) = any($2::text[]))
       )
     limit 1`,
    [clientIp(req), values.map((value) => value.toLowerCase())]
  );
  if (rows[0]) {
    throw new RequestError(403, 'Acceso bloqueado por politica administrativa.');
  }
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

async function parseFileEditUpload(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('multipart/form-data')) {
    throw new RequestError(415, 'La solicitud debe enviar un archivo usando multipart/form-data.');
  }

  const contentLength = getContentLength(req);
  if (contentLength && contentLength > MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES) {
    throw new RequestError(413, LIMIT_MESSAGE);
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'metadata-edit-'));
  const inputPath = join(tempDir, 'upload.bin');

  try {
    const parsed = await new Promise((resolve, reject) => {
      let settled = false;
      let fileSeen = false;
      let metadataSeen = false;
      let originalName = 'unnamed-file';
      let declaredMimeType = 'application/octet-stream';
      let sizeBytes = 0;
      let metadataRaw = '';
      let writeDone = Promise.resolve();
      let writeStream = null;

      function fail(error) {
        if (settled) return;
        settled = true;
        writeDone.catch(() => {});
        writeStream?.destroy();
        req.unpipe(busboy);
        req.resume();
        reject(error);
      }

      const busboy = Busboy({
        headers: req.headers,
        limits: {
          files: 1,
          fields: 1,
          parts: 3,
          fileSize: MAX_FILE_BYTES,
          fieldSize: MAX_JSON_BYTES
        }
      });

      busboy.on('file', (_fieldname, file, info) => {
        if (fileSeen) {
          file.resume();
          fail(new RequestError(400, 'Solo se permite un archivo por edicion.'));
          return;
        }

        fileSeen = true;
        originalName = sanitizeFilename(info.filename);
        declaredMimeType = sanitizeMime(info.mimeType);
        writeStream = createWriteStream(inputPath, { flags: 'wx' });
        writeDone = new Promise((resolveWrite, rejectWrite) => {
          writeStream.on('finish', resolveWrite);
          writeStream.on('error', rejectWrite);
        });

        file.on('data', (chunk) => {
          sizeBytes += chunk.length;
          if (sizeBytes > MAX_FILE_BYTES) {
            fail(new RequestError(413, LIMIT_MESSAGE));
          }
        });

        file.on('limit', () => {
          fail(new RequestError(413, LIMIT_MESSAGE));
        });

        file.on('error', (error) => {
          fail(error);
        });

        file.pipe(writeStream);
      });

      busboy.on('field', (fieldname, value, info = {}) => {
        if (fieldname !== 'metadata') {
          fail(new RequestError(400, 'El formulario solo permite el archivo y los campos de metadata.'));
          return;
        }
        if (metadataSeen) {
          fail(new RequestError(400, 'La metadata solo debe enviarse una vez.'));
          return;
        }
        if (info.valueTruncated) {
          fail(new RequestError(400, 'La metadata enviada es demasiado grande.'));
          return;
        }
        metadataSeen = true;
        metadataRaw = String(value || '');
      });

      busboy.on('filesLimit', () => {
        fail(new RequestError(400, 'Solo se permite un archivo por edicion.'));
      });

      busboy.on('fieldsLimit', () => {
        fail(new RequestError(400, 'El formulario solo permite un bloque de metadata.'));
      });

      busboy.on('partsLimit', () => {
        fail(new RequestError(400, 'El formulario contiene demasiadas partes.'));
      });

      busboy.on('error', (error) => {
        fail(error);
      });

      busboy.on('close', () => {
        if (settled) return;
        if (!fileSeen) {
          fail(new RequestError(400, 'Selecciona un archivo para editar su metadata.'));
          return;
        }
        settled = true;
        resolve({
          originalName,
          extension: getFileExtension(originalName),
          declaredMimeType,
          sizeBytes,
          metadataRaw,
          writeDone
        });
      });

      req.on('aborted', () => {
        fail(new RequestError(400, 'La carga del archivo fue interrumpida.'));
      });

      req.pipe(busboy);
    });

    await parsed.writeDone;
    const edits = sanitizeMetadataEdits(parsed.metadataRaw);
    return {
      tempDir,
      inputPath,
      originalName: parsed.originalName,
      extension: parsed.extension,
      declaredMimeType: parsed.declaredMimeType,
      sizeBytes: parsed.sizeBytes,
      edits
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
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

async function saveAnalysis(result, auth) {
  if (!pool) return result;
  const { rows } = await pool.query(
    `insert into file_metadata_analyses
       (user_id, original_name, extension, mime_type, file_size_bytes, metadata, created_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, created_at`,
    [
      auth?.user?.id || null,
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
    analyzedAt: rows[0].created_at,
    owned: Boolean(auth?.user?.id)
  };
}

async function analyzeFile(req, auth) {
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

  const saved = await saveAnalysis(result, auth);
  await logUserEvent(auth, req, 'file_analyzed', 'file_metadata_analysis', String(saved.id || ''), {
    extension: saved.extension || '',
    mimeType: saved.mimeType || '',
    sizeBytes: saved.sizeBytes
  });
  return saved;
}

function runExifTool(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(EXIFTOOL_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 8192) stdout += chunk.toString('utf8').slice(0, 8192 - stdout.length);
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length);
    });

    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new RequestError(503, 'El editor de metadata no esta disponible en este servidor.'));
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new RequestError(422, 'No se pudo escribir metadata en este tipo de archivo. Prueba con una imagen, PDF u otro formato compatible.'));
    });
  });
}

async function handleEditMetadata(req, res, auth) {
  const upload = await parseFileEditUpload(req);
  try {
    const args = ['-overwrite_original', '-P', '-codedcharacterset=utf8'];
    for (const [key, value] of Object.entries(upload.edits)) {
      args.push(`-${EDITABLE_METADATA_FIELDS[key].tag}=${value}`);
    }
    args.push(upload.inputPath);

    await runExifTool(args);
    const outputStats = await stat(upload.inputPath);
    const downloadName = editedDownloadName(upload.originalName);

    await logUserEvent(auth, req, 'file_metadata_edited', 'file_metadata_edit', '', {
      extension: upload.extension || '',
      mimeType: upload.declaredMimeType || '',
      sizeBytes: upload.sizeBytes,
      outputSizeBytes: outputStats.size,
      fields: Object.keys(upload.edits)
    });

    res.writeHead(200, {
      'Content-Type': upload.declaredMimeType || 'application/octet-stream',
      'Content-Length': String(outputStats.size),
      'Content-Disposition': contentDisposition(downloadName),
      'Cache-Control': 'no-store',
      ...securityHeaders
    });
    await pipeline(createReadStream(upload.inputPath), res);
  } finally {
    await rm(upload.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleRegister(req, res) {
  requireAuthReady();
  const payload = await readJson(req);
  const username = cleanUsername(payload.username);
  const email = String(payload.email || '').trim().slice(0, 160);
  const emailNormalized = normalizeEmail(email);
  const password = validatePassword(payload.password);

  if (username.length < 2) throw new RequestError(400, 'El usuario debe tener al menos 2 caracteres.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalized)) throw new RequestError(400, 'Email invalido.');

  const digest = hashPassword(password);
  const { rows } = await pool.query(
    `insert into users (id, username, email, email_normalized, password_hash, password_salt, password_iterations, created_ip, created_user_agent)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id, username, email, role, created_at`,
    [
      randomUUID(),
      username,
      email,
      emailNormalized,
      digest.hash,
      digest.salt,
      digest.iterations,
      clientIp(req),
      String(req.headers['user-agent'] || '').slice(0, 700)
    ]
  );
  const user = publicUser(rows[0]);
  await createSession(req, res, user);
  await logUserEvent({ user }, req, 'register');
  sendJson(res, 201, { ok: true, user });
}

async function handleLogin(req, res) {
  requireAuthReady();
  const payload = await readJson(req);
  const emailNormalized = normalizeEmail(payload.email);
  const password = String(payload.password || '');
  const { rows } = await pool.query('select * from users where email_normalized = $1 limit 1', [emailNormalized]);
  const userRow = rows[0];
  if (!userRow || !verifyPassword(password, userRow)) {
    throw new RequestError(401, 'Email o contrasena incorrectos.');
  }
  if (userRow.role !== 'admin') {
    const values = [userRow.id, normalizeEmail(userRow.email), cleanUsername(userRow.username).toLowerCase()].filter(Boolean);
    const block = await pool.query(
      `select id from admin_blocks
       where block_type = 'user'
         and revoked_at is null
         and (expires_at is null or expires_at > now())
         and lower(value) = any($1::text[])
       limit 1`,
      [values.map((value) => value.toLowerCase())]
    );
    if (block.rows[0]) throw new RequestError(403, 'Esta cuenta esta bloqueada por politica administrativa.');
  }
  const user = publicUser(userRow);
  await createSession(req, res, user);
  await logUserEvent({ user }, req, 'login');
  sendJson(res, 200, { ok: true, user });
}

async function handleLogout(req, res, auth) {
  if (pool && auth?.session_id) {
    await pool.query('update user_sessions set revoked_at = now() where id = $1', [auth.session_id]);
    await logUserEvent(auth, req, 'logout');
  }
  clearCookie(res, AUTH_COOKIE);
  sendJson(res, 200, { ok: true }, { 'Clear-Site-Data': '"cookies"' });
}

function requireUser(auth) {
  if (!auth?.user?.id) throw new RequestError(401, 'Inicia sesion.');
}

function requireAdmin(auth) {
  requireUser(auth);
  if (auth.user.role !== 'admin') throw new RequestError(403, 'Necesitas permisos de administrador.');
}

async function accountHistory(req, res, auth) {
  requireUser(auth);
  const { rows } = await pool.query(
    `select id, original_name, extension, mime_type, file_size_bytes, created_at,
            metadata #>> '{detection,detectedType}' as detected_type,
            metadata #>> '{detection,category}' as category
     from file_metadata_analyses
     where user_id = $1
     order by created_at desc
     limit 80`,
    [auth.user.id]
  );
  sendJson(res, 200, {
    ok: true,
    analyses: rows.map((row) => ({
      id: row.id,
      originalName: row.original_name,
      extension: row.extension || '',
      mimeType: row.mime_type || '',
      sizeBytes: Number(row.file_size_bytes || 0),
      sizeHuman: formatBytes(Number(row.file_size_bytes || 0)),
      detectedType: row.detected_type || 'generic file',
      category: row.category || 'unknown',
      createdAt: row.created_at
    }))
  });
}

async function accountSessions(req, res, auth) {
  requireUser(auth);
  const { rows } = await pool.query(
    `select id, device_label, ip, user_agent, created_at, last_seen_at, expires_at,
            revoked_at, (id = $2) as current
     from user_sessions
     where user_id = $1 and revoked_at is null and expires_at > now()
     order by last_seen_at desc`,
    [auth.user.id, auth.session_id]
  );
  sendJson(res, 200, { ok: true, current_session_id: auth.session_id, sessions: rows });
}

async function revokeSession(req, res, auth, sessionId) {
  requireUser(auth);
  await pool.query(
    'update user_sessions set revoked_at = now() where id = $1 and user_id = $2 and id <> $3',
    [sessionId, auth.user.id, auth.session_id]
  );
  sendJson(res, 200, { ok: true });
}

async function logoutOtherSessions(req, res, auth) {
  requireUser(auth);
  await pool.query(
    'update user_sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null',
    [auth.user.id, auth.session_id]
  );
  sendJson(res, 200, { ok: true });
}

async function adminOverview(req, res, auth) {
  requireAdmin(auth);
  const [
    stats,
    users,
    telemetry,
    events,
    blocks
  ] = await Promise.all([
    pool.query(`
      select
        (select count(*)::int from users) as users,
        (select count(*)::int from file_metadata_analyses) as analyses,
        (select count(*)::int from request_telemetry where created_at > now() - interval '24 hours') as visits_today,
        (select count(*)::int from user_sessions where revoked_at is null and expires_at > now()) as active_sessions,
        (select count(*)::int from admin_blocks where revoked_at is null and (expires_at is null or expires_at > now())) as active_blocks
    `),
    pool.query(`
      select u.id, u.username, u.email, u.role, u.created_ip, u.created_user_agent, u.created_at,
             count(distinct a.id)::int as analysis_count,
             count(distinct s.id) filter (where s.revoked_at is null and s.expires_at > now())::int as active_sessions,
             max(coalesce(e.created_at, t.created_at, u.created_at)) as last_activity
      from users u
      left join file_metadata_analyses a on a.user_id = u.id
      left join user_sessions s on s.user_id = u.id
      left join user_events e on e.user_id = u.id
      left join request_telemetry t on t.user_id = u.id
      group by u.id
      order by last_activity desc nulls last, u.created_at desc
      limit 80
    `),
    pool.query(`
      select t.id, t.method, t.path, t.ip, t.user_agent, t.device_label, t.browser, t.os, t.device_type,
             t.referer, t.accept_language, t.cf_country, t.created_at,
             u.username, u.email
      from request_telemetry t
      left join users u on u.id = t.user_id
      order by t.created_at desc
      limit 120
    `),
    pool.query(`
      select e.id, e.event_type, e.entity_type, e.entity_id, e.ip, e.details, e.created_at,
             u.username, u.email
      from user_events e
      left join users u on u.id = e.user_id
      order by e.created_at desc
      limit 120
    `),
    pool.query(`
      select b.id, b.block_type, b.value, b.reason, b.created_at, b.expires_at,
             u.username as created_by_username
      from admin_blocks b
      left join users u on u.id = b.created_by
      where b.revoked_at is null and (b.expires_at is null or b.expires_at > now())
      order by b.created_at desc
      limit 80
    `)
  ]);

  sendJson(res, 200, {
    ok: true,
    stats: stats.rows[0] || {},
    users: users.rows,
    telemetry: telemetry.rows,
    events: events.rows,
    blocks: blocks.rows
  });
}

function cleanBlockType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!['ip', 'user'].includes(type)) throw new RequestError(400, 'Tipo de bloqueo invalido.');
  return type;
}

async function normalizeBlockValue(blockType, rawValue, auth, req) {
  const value = String(rawValue || '').trim();
  if (!value) throw new RequestError(400, 'Indica el valor que quieres bloquear.');
  if (blockType === 'ip') {
    const ip = value.slice(0, 80);
    if (ip === clientIp(req)) throw new RequestError(400, 'No bloquees la IP administrativa actual desde la interfaz.');
    return ip;
  }

  const lookup = value.toLowerCase();
  const { rows } = await pool.query(
    `select id, role from users
     where id::text = $1 or email_normalized = $1 or lower(username) = $1
     limit 1`,
    [lookup]
  );
  const user = rows[0];
  if (!user) throw new RequestError(404, 'No se encontro ese usuario.');
  if (user.id === auth.user.id || user.role === 'admin') {
    throw new RequestError(400, 'No se puede bloquear la cuenta administradora desde este panel.');
  }
  return user.id;
}

async function createAdminBlock(req, res, auth) {
  requireAdmin(auth);
  const payload = await readJson(req);
  const blockType = cleanBlockType(payload.blockType);
  const value = await normalizeBlockValue(blockType, payload.value, auth, req);
  const reason = shortHeader(payload.reason, 300);
  const { rows } = await pool.query(
    `insert into admin_blocks (id, block_type, value, reason, created_by)
     values ($1, $2, $3, $4, $5)
     on conflict do nothing
     returning id`,
    [randomUUID(), blockType, value, reason, auth.user.id]
  );
  await logUserEvent(auth, req, 'admin_block_created', 'admin_block', rows[0]?.id || '', { blockType, value, reason });
  sendJson(res, 201, { ok: true, id: rows[0]?.id || null });
}

async function revokeAdminBlock(req, res, auth, blockId) {
  requireAdmin(auth);
  await pool.query(
    'update admin_blocks set revoked_at = now() where id = $1 and revoked_at is null',
    [blockId]
  );
  await logUserEvent(auth, req, 'admin_block_revoked', 'admin_block', blockId);
  sendJson(res, 200, { ok: true });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const routeAliases = {
    '/admin': '/index.html',
    '/terminos': '/terms.html',
    '/condiciones': '/terms.html',
    '/privacidad': '/privacy.html',
    '/cookies': '/cookies.html',
    '/terms': '/terms.html',
    '/privacy': '/privacy.html'
  };
  const routePath = routeAliases[url.pathname] || url.pathname;
  const rawPath = routePath === '/' ? '/index.html' : routePath;
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
      ...securityHeaders
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { ok: false, error: 'Not found' });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const auth = await currentAuth(req);
    logRequestTelemetry(auth, req, url);
    await enforceRequestBlocks(req, auth, url);
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
        auth: pool && APP_SECRET.length >= 24 ? 'enabled' : 'disabled',
        metadataEditor: EXIFTOOL_BIN,
        maxFileBytes: MAX_FILE_BYTES,
        time: new Date().toISOString()
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      sendJson(res, 200, { ok: true, user: auth?.user || null });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      await handleRegister(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      await handleLogin(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      await handleLogout(req, res, auth);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/account/history') {
      await accountHistory(req, res, auth);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/account/sessions') {
      await accountSessions(req, res, auth);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/account/sessions/logout-others') {
      await logoutOtherSessions(req, res, auth);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
      await adminOverview(req, res, auth);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/blocks') {
      await createAdminBlock(req, res, auth);
      return;
    }

    const adminBlockRevokeMatch = url.pathname.match(/^\/api\/admin\/blocks\/([0-9a-f-]{36})\/revoke$/);
    if (req.method === 'POST' && adminBlockRevokeMatch) {
      await revokeAdminBlock(req, res, auth, adminBlockRevokeMatch[1]);
      return;
    }

    const revokeMatch = url.pathname.match(/^\/api\/account\/sessions\/([0-9a-f-]{36})\/revoke$/);
    if (req.method === 'POST' && revokeMatch) {
      await revokeSession(req, res, auth, revokeMatch[1]);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      const result = await analyzeFile(req, auth);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/edit-metadata') {
      await handleEditMetadata(req, res, auth);
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    const status = error.statusCode || 400;
    if (error?.code === '23505') {
      const constraint = String(error.constraint || '');
      if (constraint === 'users_email_normalized_key') {
        sendJson(res, 409, { ok: false, error: 'Ese correo ya esta registrado.' });
        return;
      }
      if (constraint === 'users_username_lower_idx') {
        sendJson(res, 409, { ok: false, error: 'Ese usuario ya esta en uso.' });
        return;
      }
      sendJson(res, 409, { ok: false, error: 'Ese dato ya existe.' });
      return;
    }
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    sendJson(res, status, { ok: false, error: error.message || 'Request failed' });
  }
});

await initDb();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Metadata file analyzer listening on ${PORT}`);
});
