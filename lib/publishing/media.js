'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { LIMITS } = require('./constants');
const { fetchRemoteImage } = require('./remote-fetch');

const MIME_EXTENSIONS = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' });
function mediaError(code) { const error = new Error(code); error.code = code; return error; }
function imageInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw mediaError('IMAGE_MIME_MISMATCH');
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', dimensions: { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) } };
  if (buffer.length >= 10 && buffer.subarray(0, 3).toString() === 'GIF') return { mime: 'image/gif', dimensions: { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) } };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return webpInfo(buffer);
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) return jpegInfo(buffer);
  throw mediaError('IMAGE_MIME_MISMATCH');
}
function jpegInfo(buffer) { let offset = 2; while (offset + 9 < buffer.length) { if (buffer[offset] !== 0xff) { offset++; continue; } const marker = buffer[offset + 1]; const length = buffer.readUInt16BE(offset + 2); if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && offset + 8 < buffer.length) return { mime: 'image/jpeg', dimensions: { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) } }; if (length < 2) break; offset += length + 2; } return { mime: 'image/jpeg', dimensions: null }; }
function webpInfo(buffer) { const kind = buffer.subarray(12, 16).toString(); if (kind === 'VP8X' && buffer.length >= 30) return { mime: 'image/webp', dimensions: { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) } }; if (kind === 'VP8L' && buffer.length >= 25) { const bits = buffer.readUInt32LE(21); return { mime: 'image/webp', dimensions: { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 } }; } return { mime: 'image/webp', dimensions: null }; }
function validateImageBytes(buffer, expectedMime) { if (buffer.length > LIMITS.maxImageBytes) throw mediaError('IMAGE_TOO_LARGE'); const info = imageInfo(buffer); if (expectedMime && expectedMime.split(';')[0].trim().toLowerCase() !== info.mime) throw mediaError('REMOTE_MIME_MISMATCH'); return info; }
function decodeDataUri(value) { const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(value || ''); if (!match) throw mediaError('INVALID_DATA_URI'); const body = match[2].replace(/\s/g, ''); if (body.length % 4 !== 0) throw mediaError('INVALID_DATA_URI'); const buffer = Buffer.from(body, 'base64'); if (!buffer.length || buffer.length > LIMITS.maxImageBytes) throw mediaError(buffer.length > LIMITS.maxImageBytes ? 'IMAGE_TOO_LARGE' : 'INVALID_DATA_URI'); return { buffer, mime: match[1].toLowerCase() }; }
function inside(root, value) { const relative = path.relative(root, value); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
async function acquireAsset(asset, inputSource, options) {
  options = options || {}; const fsPromises = options.fs || fs.promises; const cacheRoot = path.resolve(options.cacheRoot); const jobId = options.jobId;
  if (!jobId || !/^[A-Za-z0-9_-]{8,128}$/.test(jobId)) throw mediaError('CACHE_PATH_INVALID');
  const jobCache = path.join(cacheRoot, jobId); await fsPromises.mkdir(jobCache, { recursive: true, mode: 0o700 });
  let buffer; let declaredMime = null;
  if (asset.source.kind === 'local') { const source = inputSource || asset.source.path; let real; try { real = await fsPromises.realpath(source); const stat = await fsPromises.stat(real); if (!stat.isFile()) throw new Error('not-file'); buffer = await fsPromises.readFile(real); } catch (_) { throw mediaError('MISSING_LOCAL_FILE'); } }
  else if (asset.source.kind === 'data') { const decoded = decodeDataUri(inputSource); buffer = decoded.buffer; declaredMime = decoded.mime; }
  else if (asset.source.kind === 'remote') { const result = await (options.remoteFetch || fetchRemoteImage)(inputSource, options.remoteFetchOptions); buffer = result.buffer; declaredMime = result.contentType; }
  else throw mediaError('INVALID_IMAGE_SOURCE');
  const info = validateImageBytes(buffer, declaredMime); const contentSha256 = crypto.createHash('sha256').update(buffer).digest('hex'); const target = path.resolve(jobCache, `${contentSha256}.${MIME_EXTENSIONS[info.mime]}`);
  if (!inside(jobCache, target)) throw mediaError('CACHE_PATH_INVALID');
  try { await fsPromises.access(target); } catch (_) { const temp = path.join(jobCache, `.${contentSha256}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`); await fsPromises.writeFile(temp, buffer, { mode: 0o600 }); await fsPromises.chmod(temp, 0o600); await fsPromises.rename(temp, target); }
  await fsPromises.chmod(target, 0o600);
  return { ...asset, acquisition: 'acquired', cachePath: target, mime: info.mime, byteLength: buffer.length, contentSha256, dimensions: asset.dimensions || info.dimensions, error: null };
}
async function acquireAssets(assets, sourceInputs, options) { const results = []; for (const asset of assets) { try { results.push(await acquireAsset(asset, sourceInputs && sourceInputs[asset.assetId], options)); } catch (error) { results.push({ ...asset, acquisition: 'failed', error: { code: error.code || 'INVALID_IMAGE_SOURCE' } }); } } return results; }
function uploadGroups(assets, target, artifactKind, targetInputFingerprint) { const groups = new Map(); assets.filter(asset => asset.acquisition === 'acquired').sort((a, b) => (a.bodyOrder || 0) - (b.bodyOrder || 0)).forEach(asset => { const key = [target, artifactKind, asset.contentSha256, targetInputFingerprint || ''].join(':'); if (!groups.has(key)) groups.set(key, { key, target, artifactKind, contentSha256: asset.contentSha256, assetIds: [], cachePath: asset.cachePath, mime: asset.mime }); groups.get(key).assetIds.push(asset.assetId); }); return [...groups.values()]; }
async function cleanupJobCache(cacheRoot, jobId, terminal) { if (!terminal) return false; const target = path.resolve(cacheRoot, jobId); if (!inside(path.resolve(cacheRoot), target)) throw mediaError('CACHE_PATH_INVALID'); await fs.promises.rm(target, { recursive: true, force: true }); return true; }
function assertRetryContent(previous, next) { if (previous && previous.contentSha256 && previous.contentSha256 !== next.contentSha256) throw mediaError('RETRY_SOURCE_CHANGED'); return true; }

module.exports = { MIME_EXTENSIONS, imageInfo, validateImageBytes, decodeDataUri, acquireAsset, acquireAssets, uploadGroups, cleanupJobCache, assertRetryContent };
