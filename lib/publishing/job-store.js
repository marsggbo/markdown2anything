'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createPublishJob, serializeJob, transitionJob, markIntent, settleMutation, calculateClaimKey } = require('./model');

function storeError(code) { const error = new Error(code); error.code = code; return error; }
function fsyncDirectory(directory, io) { try { const fd = io.openSync(directory, 'r'); try { io.fsyncSync(fd); } finally { io.closeSync(fd); } } catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error.code)) throw error; } }
function atomicWriteJson(file, value, io) {
  const directory = path.dirname(file); io.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const payload = JSON.stringify(serializeJob(value), null, 2) + '\n';
  let fd;
  try { fd = io.openSync(temp, 'wx', 0o600); io.writeFileSync(fd, payload, 'utf8'); io.fsyncSync(fd); io.closeSync(fd); fd = null; io.renameSync(temp, file); fsyncDirectory(directory, io); } catch (error) { if (fd !== null && fd !== undefined) try { io.closeSync(fd); } catch (_) {} try { io.unlinkSync(temp); } catch (_) {} throw error; }
}
function readJson(file, io) { try { return JSON.parse(io.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw storeError('CLAIM_RECOVERY_REQUIRED'); } }
function safeName(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value); }

class JobStore {
  constructor(root, options) {
    this.root = path.resolve(root); this.io = options && options.fs || fs;
    this.jobsDir = path.join(this.root, 'jobs'); this.claimsDir = path.join(this.root, 'claims'); this.cacheDir = path.join(this.root, 'cache');
    this.io.mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 }); this.io.mkdirSync(this.claimsDir, { recursive: true, mode: 0o700 }); this.io.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
  }
  jobPath(jobId) { if (!safeName(jobId)) throw storeError('INVALID_JOB_ID'); return path.join(this.jobsDir, `${jobId}.json`); }
  claimPath(claimKey) { if (!/^[a-f0-9]{64}$/i.test(claimKey || '')) throw storeError('INVALID_CLAIM_KEY'); return path.join(this.claimsDir, `${claimKey}.json`); }
  create(input) { const job = createPublishJob(input); if (this.io.existsSync(this.jobPath(job.jobId))) throw storeError('JOB_ALREADY_EXISTS'); atomicWriteJson(this.jobPath(job.jobId), job, this.io); return job; }
  load(jobId) { const data = readJson(this.jobPath(jobId), this.io); if (!data) return null; try { return createPublishJob(data); } catch (_) { throw storeError('CLAIM_RECOVERY_REQUIRED'); } }
  save(job) { const clean = createPublishJob(job); atomicWriteJson(this.jobPath(clean.jobId), clean, this.io); return clean; }
  createClaim(job) {
    const claimKey = job.claimKey || calculateClaimKey(job); const file = this.claimPath(claimKey); const claim = { schemaVersion: 1, claimKey, jobId: job.jobId };
    let fd;
    try { fd = this.io.openSync(file, 'wx', 0o600); this.io.writeFileSync(fd, JSON.stringify(claim) + '\n', 'utf8'); this.io.fsyncSync(fd); this.io.closeSync(fd); fd = null; fsyncDirectory(this.claimsDir, this.io); return { created: true, claim }; }
    catch (error) { if (fd !== null && fd !== undefined) try { this.io.closeSync(fd); } catch (_) {} if (error.code !== 'EEXIST') throw error; const existing = readJson(file, this.io); if (!existing || existing.claimKey !== claimKey || !safeName(existing.jobId) || !this.load(existing.jobId)) throw storeError('CLAIM_RECOVERY_REQUIRED'); return { created: false, claim: existing }; }
  }
  claim(job) {
    let created = job;
    if (!this.io.existsSync(this.jobPath(job.jobId))) created = this.create(job);
    const result = this.createClaim(created);
    if (!result.created) return { job: this.load(result.claim.jobId), reused: true };
    const current = this.load(created.jobId); current.claimKey = result.claim.claimKey; transitionJob(current, 'claimed'); this.save(current); return { job: current, reused: false };
  }
  start(input) { const job = this.create(input); return this.claim(job); }
  intent(jobId, target, operation, operationId) { const job = this.load(jobId); if (!job) throw storeError('JOB_NOT_FOUND'); markIntent(job, target, operation, operationId); return this.save(job); }
  settle(jobId, target, patch) { const job = this.load(jobId); if (!job) throw storeError('JOB_NOT_FOUND'); Object.assign(job.targets[target] || {}, patch || {}); settleMutation(job, target); return this.save(job); }
  discard(jobId) { const job = this.load(jobId); if (!job) throw storeError('JOB_NOT_FOUND'); if (job.mutationPhase === 'intent') throw storeError('AMBIGUOUS_CREATE'); transitionJob(job, 'discarded'); return this.save(job); }
  cachePath(jobId) { const result = path.resolve(this.cacheDir, jobId); if (path.relative(this.cacheDir, result).startsWith('..')) throw storeError('CACHE_PATH_INVALID'); return result; }
  recover() {
    const findings = []; const claims = new Map();
    this.io.readdirSync(this.claimsDir).filter(file => file.endsWith('.json')).forEach(file => { const claim = readJson(path.join(this.claimsDir, file), this.io); if (!claim || !safeName(claim.jobId)) findings.push({ code: 'CLAIM_RECOVERY_REQUIRED', claim: file }); else claims.set(claim.jobId, claim); });
    this.io.readdirSync(this.jobsDir).filter(file => file.endsWith('.json')).forEach(file => {
      const jobId = file.slice(0, -5); let job;
      try { job = this.load(jobId); } catch (_) { findings.push({ code: 'CLAIM_RECOVERY_REQUIRED', jobId }); return; }
      if (!job) return;
      if (!claims.has(jobId) && job.status === 'created' && job.mutationPhase === 'none') { transitionJob(job, 'discarded'); this.save(job); findings.push({ code: 'ORPHAN_DISCARDED', jobId }); return; }
      if (job.mutationPhase === 'intent') { job.status = 'needsAttention'; Object.keys(job.targets).forEach(target => { if (job.targets[target].mutation) job.targets[target].state = 'ambiguous'; }); this.save(job); findings.push({ code: 'AMBIGUOUS_CREATE', jobId }); }
    });
    claims.forEach((claim, jobId) => { if (!this.load(jobId)) findings.push({ code: 'CLAIM_RECOVERY_REQUIRED', jobId }); }); return findings;
  }
}

module.exports = { JobStore, atomicWriteJson, fsyncDirectory, storeError };
