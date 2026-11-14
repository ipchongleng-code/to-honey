/*
 * Eating Manager 后端：提供网页 + 拍照识别接口（/vision）
 *
 * 启动：node --env-file=api.env server.js
 * 打开：http://localhost:8787
 *
 * 说明：
 * - API 密钥只放在 api.env 里，由这个程序读取，网页里看不到。
 * - 网页文件放在 public/ 文件夹，只有这个文件夹里的文件会被公开访问。
 * - 每次识别会在 usage.csv 里记一行（时间、耗时、token 用量），不保存照片。
 * - 不需要安装任何第三方依赖，Node.js 20.6 或更新版本即可运行。
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/* ---------- 配置（都可以在 api.env 里改） ---------- */
const API_KEY = (process.env.LLM_API_KEY || process.env.DASHSCOPE_API_KEY || '').trim();
// 默认阿里云百炼（通义千问）的 OpenAI 兼容地址；换豆包、智谱时改这里和模型名即可
const BASE_URL = (process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').trim().replace(/\/+$/, '');
const MODEL = (process.env.LLM_MODEL || 'qwen-vl-plus').trim();
const PORT = Number(process.env.PORT) || 8787;
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 300;   // 全站每天最多识别次数
const PER_IP_LIMIT = Number(process.env.PER_IP_LIMIT) || 40;  // 每个访问者每天最多识别次数
const TRUST_PROXY = process.env.TRUST_PROXY === '1';           // 放在 Nginx 等反向代理后面时设为 1
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '').trim(); // 网页和接口不在同一个域名时才需要

const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_IMAGE = 6 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 50000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PUBLIC_DIR = path.join(__dirname, 'public');
const USAGE_LOG = path.join(__dirname, 'usage.csv');

/* ---------- 提示词（在服务器上生成，不使用网页传来的文字） ---------- */
function visionPrompt(kind, lib) {
  const fmtSpec = `只回复一个 JSON 对象，不要任何其他文字。格式：{"summary":"菜名或简短名称，不超过 12 个字，不要描述画面","items":[{"name":"中文名称","matchId":"下面食物库里对应的 id，没有对应就填 null","role":"protein|carb|veg|fruit|fat|oil|other 其中之一","unit":"g 或 ml","grams":估算的数量（数字）,"per100":{"kcal":数字,"protein":数字,"carb":数字,"fat":数字},"confidence":0到1之间的数字}],"note":"一句给用户的提醒，没有就留空"}。per100 是每 100g 或 100ml 可食部分的营养估算，参考《中国食物成分表》。最多 10 项。照片里看不到${kind === 'meal' ? '食物' : '食材'}时，items 返回空数组，并在 note 里说明。\n食物库（id:名称）：${lib || '（无）'}`;
  if (kind === 'meal') return `你是营养师助手。这张照片是用户正要吃的一顿饭，可能是家常菜、外卖或食堂。请识别其中每一样单独的食物或菜品，按照片里能看到的份量估算熟重。混合菜品能拆开就拆成主要食材，拆不开就作为一项整体估算；明显用油较多的菜，把烹调用油单独列一项。\n` + fmtSpec;
  return `你是厨房助手。这张照片里是还没做的生食材，可能在冰箱、菜篮子或厨房台面上。请识别每一种能看清的食材，grams 填照片里大约的总量，估不出就填 100。忽略调味品、包装和餐具。\n` + fmtSpec;
}

// 网页会把食物库列表一起发过来。只接受「英文id:中文名」这种格式的条目，其他内容一律丢弃，
// 防止有人借这个字段塞进别的指令，把接口当成免费的通用 AI 来用。
function cleanLibrary(raw) {
  if (typeof raw !== 'string' || raw.length > 4000) return '';
  return raw.split('，').map(s => s.trim())
    .filter(s => /^[a-z0-9_]{1,24}:[一-龥A-Za-z0-9（）() ]{1,16}$/.test(s))
    .slice(0, 150).join('，');
}

/* ---------- 每日调用上限 ---------- */
let quotaDay = '', quotaTotal = 0;
const quotaByIp = new Map();
function takeQuota(ip) {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== quotaDay) { quotaDay = d; quotaTotal = 0; quotaByIp.clear(); }
  if (quotaTotal >= DAILY_LIMIT) return 'daily';
  const n = quotaByIp.get(ip) || 0;
  if (n >= PER_IP_LIMIT) return 'ip';
  quotaTotal++; quotaByIp.set(ip, n + 1);
  return '';
}
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || 'unknown';
}

/* ---------- 用量记录（用来算每次识别的成本） ---------- */
function logUsage(row) {
  const line = [new Date().toISOString(), row.kind, MODEL, row.ms, row.promptTokens ?? '', row.completionTokens ?? '', row.items ?? '', row.status].join(',') + '\n';
  const write = () => fs.appendFile(USAGE_LOG, line, () => {});
  if (!fs.existsSync(USAGE_LOG)) fs.writeFile(USAGE_LOG, 'time,kind,model,ms,prompt_tokens,completion_tokens,items,status\n', write);
  else write();
}

/* ---------- 小工具 ---------- */
function corsHeaders() {
  return ALLOWED_ORIGIN ? {'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin'} : {};
}
function sendJson(res, status, obj) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders()});
  res.end(JSON.stringify(obj));
}
function httpError(status, code) { return Object.assign(new Error(code), {status, code}); }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > limit) { reject(httpError(413, 'image_rejected')); req.resume(); return; }
    const chunks = []; let size = 0, failed = false;
    req.on('data', c => {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; reject(httpError(413, 'image_rejected')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
// 模型偶尔会在 JSON 外面包一层 ```json 或多说几句话，这里把 JSON 抠出来
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} }
  return null;
}
// 把 Node 的「fetch failed」翻译成具体原因
function networkHint(e) {
  if (e && e.name === 'AbortError') return `等了 ${UPSTREAM_TIMEOUT_MS / 1000} 秒没有回应（超时）。网络慢，或者开着 VPN/代理时请先关掉再试。`;
  const c = (e && e.cause) || {};
  const code = String(c.code || '');
  const why = `${code} ${c.message || (e && e.message) || ''}`.trim();
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return `找不到 ${new URL(BASE_URL).host}（${why}）。请检查电脑能否上网，以及 LLM_BASE_URL 有没有写错。`;
  if (/CERT|SELF_SIGNED|UNABLE_TO|TLS|SSL/i.test(why)) return `HTTPS 证书校验失败（${why}）。通常是代理软件或杀毒软件在拦截加密连接，请暂时关掉它们再试。`;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR|EPIPE|socket/i.test(why)) return `连接被中断或超时（${why}）。如果开着 VPN/代理，请先关掉再试；也可能是网络不稳定。`;
  return why || '未知网络错误';
}
function describeKey(k) {
  if (!k) return '';
  if (/^LTAI/i.test(k)) return '⚠ 这看起来是阿里云 AccessKey（LTAI 开头），不是百炼的 API Key（sk- 开头），请到百炼控制台的 API-KEY 页面重新复制。';
  if (/[\s"'“”‘’]/.test(k)) return '⚠ 密钥里有空格或引号，请检查 api.env：等号后面直接跟密钥，不要加引号。';
  if (/[^\x21-\x7e]/.test(k)) return '⚠ 密钥里混进了中文或全角字符，请重新复制。';
  if (!/^sk-/.test(k)) return `⚠ 密钥开头是「${k.slice(0, 3)}」，百炼的密钥一般以 sk- 开头，请确认复制的是 API Key。`;
  return `密钥：${k.slice(0, 3)}…（共 ${k.length} 位，只显示开头）`;
}
function messageText(j) {
  const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (Array.isArray(c)) return c.map(p => (p && p.text) || '').join('');
  return c;
}

/* ---------- 拍照识别 ---------- */
async function handleVision(req, res) {
  const t0 = Date.now();
  let kind = '';
  try {
    if (!API_KEY) throw httpError(503, 'no_api_key');
    const body = await readBody(req, MAX_UPLOAD);
    let form;
    try {
      form = await new Request('http://local/vision', {method: 'POST', headers: {'content-type': req.headers['content-type'] || ''}, body}).formData();
    } catch (_) { throw httpError(400, 'bad_request'); }

    kind = form.get('kind');
    if (kind !== 'meal' && kind !== 'ingredient') throw httpError(400, 'bad_request');
    const image = form.get('image');
    if (!image || typeof image === 'string') throw httpError(400, 'bad_request');
    if (!IMAGE_TYPES.has(image.type)) throw httpError(415, 'image_rejected');
    if (image.size > MAX_IMAGE) throw httpError(413, 'image_rejected');

    const over = takeQuota(clientIp(req));
    if (over) throw httpError(429, 'rate_limited');

    const dataUrl = `data:${image.type};base64,${Buffer.from(await image.arrayBuffer()).toString('base64')}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.2,
          max_tokens: 1500,
          messages: [{role: 'user', content: [
            {type: 'image_url', image_url: {url: dataUrl}},
            {type: 'text', text: visionPrompt(kind, cleanLibrary(form.get('library')))}
          ]}]
        }),
        signal: ctl.signal
      });
    } catch (e) {
      console.error('[识别] 连不上模型平台：' + networkHint(e));
      throw httpError(502, 'network_error');
    } finally { clearTimeout(timer); }

    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).slice(0, 300);
      if (r.status === 429) { console.error('[识别] 平台限流（调用太频繁或额度用完）：', detail); throw httpError(429, 'rate_limited'); }
      if (r.status === 400 && /inspection|inappropriate|safety|sensitive/i.test(detail)) { console.error('[识别] 照片没通过平台的内容审核：', detail); throw httpError(422, 'refused'); }
      if (r.status === 401 || r.status === 403) {
        console.error('[识别] 平台拒绝了请求：API 密钥不对，或者没有开通这个模型。请检查 api.env 里的密钥（应以 sk- 开头），改完后关掉窗口重新启动。', detail);
        throw httpError(502, 'bad_api_key');
      }
      if ((r.status === 400 || r.status === 404) && /model/i.test(detail)) {
        console.error(`[识别] 模型名称「${MODEL}」可能不对：请到平台的模型广场核对，改 api.env 里的 LLM_MODEL 后重新启动。`, detail);
        throw httpError(502, 'model_error');
      }
      console.error(`[识别] 平台返回错误 ${r.status}：`, detail);
      throw httpError(502, 'upstream_error');
    }

    const j = await r.json().catch(() => null);
    const data = extractJson(messageText(j));
    const usage = (j && j.usage) || {};
    if (!data || typeof data !== 'object') {
      console.error('[识别] 模型没有按要求返回 JSON：', String(messageText(j)).slice(0, 200));
      logUsage({kind, ms: Date.now() - t0, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, status: 'invalid_json'});
      throw httpError(502, 'invalid_json');
    }
    if (!Array.isArray(data.items)) data.items = [];
    const ms = Date.now() - t0;
    logUsage({kind, ms, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, items: data.items.length, status: 'ok'});
    console.log(`[识别] ${kind === 'meal' ? '餐食' : '食材'} · ${data.items.length} 项 · ${(ms / 1000).toFixed(1)} 秒 · 输入 ${usage.prompt_tokens ?? '?'} / 输出 ${usage.completion_tokens ?? '?'} tokens`);
    sendJson(res, 200, {data});
  } catch (e) {
    const status = e.status || 500, code = e.code || 'upstream_error';
    if (status === 500) console.error('[识别] 程序出错：', e);
    if (code === 'no_api_key') console.error('[识别] 没有读到 API 密钥，请检查 api.env 文件和启动命令。');
    if (code !== 'invalid_json' && code !== 'bad_request') logUsage({kind: kind || '-', ms: Date.now() - t0, status: code});
    sendJson(res, status, {error: code});
  }
}

/* ---------- 网页文件 ---------- */
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2'};
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (_) { rel = ''; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  const inside = file.startsWith(PUBLIC_DIR + path.sep);
  const hidden = rel.split(/[\\/]/).some(seg => seg.startsWith('.'));
  if (!inside || hidden) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'}); res.end(rel === '/index.html' ? '没有找到 public/index.html，请把网页文件放进 public 文件夹' : 'Not found'); return; }
    res.writeHead(200, {'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff'});
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

/* ---------- 启动 ---------- */
const server = http.createServer((req, res) => {
  const {pathname} = new URL(req.url, 'http://local');
  if (pathname === '/vision') {
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return; }
    if (req.method === 'POST') { handleVision(req, res); return; }
    sendJson(res, 405, {error: 'method_not_allowed'}); return;
  }
  if (pathname === '/health') { sendJson(res, 200, {ok: true, model: MODEL, hasKey: !!API_KEY}); return; }
  if (req.method === 'GET' || req.method === 'HEAD') { serveStatic(req, res, pathname); return; }
  res.writeHead(405); res.end();
});
server.listen(PORT, () => {
  console.log(`\nEating Manager 已启动：用浏览器打开 http://localhost:${PORT}`);
  console.log(`模型：${MODEL}　每日上限：全站 ${DAILY_LIMIT} 次 / 每人 ${PER_IP_LIMIT} 次`);
  if (!API_KEY) console.log('⚠ 没有读到 API 密钥：拍照识别会失败。请检查 api.env，并用 node --env-file=api.env server.js 启动。');
  else console.log(describeKey(API_KEY));
  console.log(`接口地址：${BASE_URL}`);
  console.log('按 Ctrl+C 停止。\n');
});
