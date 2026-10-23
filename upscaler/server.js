// Tiny job server around realesrgan-ncnn-vulkan (CPU via Mesa lavapipe). No dependencies.
//   POST   /jobs?model=fast|best&scale=2..4   raw PNG/JPEG body -> { id }
//   GET    /jobs/:id                          -> { status: running|done|error, progress, error }
//   GET    /jobs/:id/result                   -> PNG
//   DELETE /jobs/:id                          cancel / discard
//   GET    /health
// One image at a time; a second request while busy gets 429.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = +process.env.PORT || 3000;
const BIN = process.env.REALESRGAN_BIN || '/opt/realesrgan/realesrgan-ncnn-vulkan';
const MODELS = process.env.REALESRGAN_MODELS || '/opt/realesrgan/models';
const GPU = process.env.GPU_ID || '0';
const TIMEOUT_MS = (+process.env.JOB_TIMEOUT_MIN || 45) * 60000;
const MAX_BYTES = 12 * 1024 * 1024;
// fast: quick, crisp, can look a bit painterly on texture. best: photo-style model, keeps texture, much slower.
const MODEL_CFG = { fast: { name: 'realesr-animevideov3', tile: 128 }, best: { name: 'realesrgan-x4plus', tile: 32 } };

function findIcd() {
  try {
    const dir = '/usr/share/vulkan/icd.d';
    const f = fs.readdirSync(dir).find(n => /^lvp_icd.*\.json$/.test(n));
    return f ? path.join(dir, f) : null;
  } catch { return null; }
}
const ICD = process.env.VK_ICD_FILENAMES || findIcd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'upscale-'));
const jobs = new Map();
let active = null; // the running job, or true while a request is being read

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
function readBody(req) {
  return new Promise((ok, bad) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n <= MAX_BYTES) chunks.push(c); });
    req.on('end', () => (n > MAX_BYTES ? bad(new Error('Image too large')) : ok(Buffer.concat(chunks))));
    req.on('error', bad);
  });
}

function start(buf, model, scale) {
  const id = crypto.randomUUID(), cfg = MODEL_CFG[model];
  const inp = path.join(TMP, id + (buf[0] === 0x89 ? '-in.png' : '-in.jpg')), out = path.join(TMP, id + '-out.png');
  fs.writeFileSync(inp, buf);
  const job = { id, status: 'running', progress: 0, error: null, out, created: Date.now(), proc: null, log: '' };
  const args = ['-i', inp, '-o', out, '-n', cfg.name, '-s', String(model === 'best' ? 4 : scale), '-m', MODELS, '-g', GPU, '-t', String(cfg.tile), '-j', '1:1:1', '-f', 'png'];
  const proc = spawn(BIN, args, { env: { ...process.env, ...(ICD ? { VK_ICD_FILENAMES: ICD } : {}) } });
  job.proc = proc;
  const timer = setTimeout(() => { job.error = 'Timed out'; proc.kill('SIGKILL'); }, TIMEOUT_MS);
  const onData = d => {
    const s = d.toString(); job.log = (job.log + s).slice(-2000);
    const m = s.match(/(\d+(?:\.\d+)?)%/g);
    if (m) job.progress = Math.min(99, parseFloat(m[m.length - 1]));
  };
  proc.stderr.on('data', onData); proc.stdout.on('data', onData);
  const fail = msg => { if (job.status === 'running') { job.status = 'error'; job.error = job.error || msg; } };
  proc.on('error', e => { clearTimeout(timer); if (active === job) active = null; fs.rm(inp, { force: true }, () => {}); fail('Could not start upscaler: ' + e.message); });
  proc.on('close', code => {
    clearTimeout(timer); if (active === job) active = null; fs.rm(inp, { force: true }, () => {});
    if (job.status !== 'running') return;
    if (code === 0 && fs.existsSync(out)) { job.status = 'done'; job.progress = 100; }
    else fail('Upscaler failed: ' + (job.log.split('\n').filter(l => l.trim() && !/llvmpipe|%$/.test(l)).slice(-2).join(' ') || 'exit ' + code));
  });
  jobs.set(id, job); active = job;
  return job;
}

setInterval(() => { // drop finished jobs after 20 minutes
  for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - j.created > 20 * 60000) { fs.rm(j.out, { force: true }, () => {}); jobs.delete(id); }
}, 60000).unref();

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/health') return send(res, 200, { ok: true, busy: !!active });
    const m = u.pathname.match(/^\/jobs(?:\/([\w-]{36}))?(\/result)?$/);
    if (!m) return send(res, 404, { error: 'Not found' });
    if (req.method === 'POST' && !m[1]) {
      if (active) { req.resume(); return send(res, 429, { error: 'The upscaler is busy with another image. Try again in a bit.' }); }
      active = true;
      let job;
      try {
        const buf = await readBody(req);
        const isPng = buf[0] === 0x89 && buf[1] === 0x50, isJpg = buf[0] === 0xff && buf[1] === 0xd8;
        if (!isPng && !isJpg) throw Object.assign(new Error('Unsupported image'), { code: 400 });
        const model = u.searchParams.get('model') === 'best' ? 'best' : 'fast';
        const scale = Math.min(4, Math.max(2, parseInt(u.searchParams.get('scale'), 10) || 4));
        job = start(buf, model, scale);
      } catch (e) { active = null; return send(res, e.code || 400, { error: e.message }); }
      return send(res, 200, { id: job.id });
    }
    const job = m[1] && jobs.get(m[1]);
    if (!job) return send(res, 404, { error: 'Job not found' });
    if (req.method === 'GET' && !m[2]) return send(res, 200, { status: job.status, progress: job.progress, error: job.error });
    if (req.method === 'GET' && m[2]) {
      if (job.status !== 'done') return send(res, 409, { error: 'Not finished' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': fs.statSync(job.out).size });
      return fs.createReadStream(job.out).pipe(res);
    }
    if (req.method === 'DELETE' && !m[2]) {
      if (job.status === 'running') { job.status = 'cancelled'; job.proc.kill('SIGKILL'); }
      else { fs.rm(job.out, { force: true }, () => {}); jobs.delete(job.id); }
      return send(res, 200, { ok: true });
    }
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) { if (!res.headersSent) send(res, 500, { error: e.message }); }
}).listen(PORT, '0.0.0.0', () => console.log(`Upscaler on :${PORT} (icd ${ICD || 'default'}, bin ${BIN})`));
