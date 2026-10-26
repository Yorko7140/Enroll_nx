/**
 * 学在浙大（courses.zju.edu.cn）课件下载修复 v3
 *
 * 背景：平台对「只有查看权限」的课件，下载型接口（/api/uploads/{id}/blob、
 * /api/uploads/reference/{rid}/blob）会返回 HTTP 200 + {"message":"您没有权限完成此操作"}，
 * 旧流程只看 status==200 就落盘，于是把这段 75 字节 JSON 存成了 .pdf。
 *
 * v1 → v2 → v3 的两次返工：
 *   v1 只在当前文档找 #pdf-viewer/iframe 的 src → 页面是 WPS 预览（_w_third_file_id），
 *      跨域 iframe 读不到 → 报「没有课件预览信息」。
 *   v2 把 DOM 里抓到的数字当 upload id 逐个试签名 → 命中了同页的图片附件，
 *      要 PDF 却下到了 21(14).gif；列表/批量还报 403。
 *   v3 原则：**不再从 DOM 猜 id**，只信两处——
 *     a) 当前活动：/api/activities/{aid}?sub_course_id=0 的 uploads[]（aid 来自
 *        URL 的 /activity/{aid}、hash #/{aid} 或 ?activityId=）；
 *     b) 课程课件列表：/api/course/{cid}/coursewares?page=1&page_size=100
 *        （失败再退 /api/courses/{cid}/activities）。
 *   签名接口按「矩阵」逐个试，并把每次尝试的状态码记进面板日志，403 到底是
 *   列表还是文件一眼能看出；自动识别只认 type === 'document'，图片/音频不会
 *   再冒充课件被下载。
 */

const API = 'https://courses.zju.edu.cn/api';
const PANEL_ID = 'zju-webx-xzzd-panel';
const LOG = (...args) => console.log('[zju-webx][xzzd]', ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  attempts: [],                                  // [{label, status, note}]
  uploadCache: new Map(),                        // courseId -> uploads
  signedCache: new Map(),                        // key -> signed url
  shapes: [],                                    // 接口返回体结构快照（诊断用）
};

/** 只留结构信息：顶层键、活动数、第一条活动的键与 uploads 概况 */
function shapeOf(label, data) {
  const info = { label, topKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 20) : typeof data };
  const acts = Array.isArray(data && data.activities) ? data.activities
    : (Array.isArray(data) ? data : null);
  if (acts) {
    info.activityCount = acts.length;
    const first = acts.find((a) => Array.isArray(a.uploads) && a.uploads.length) || acts[0];
    if (first) {
      info.firstActivity = {
        keys: Object.keys(first).slice(0, 30),
        id: first.id,
        type: first.type,
        name: first.name,
        title: first.title,
        uploads: Array.isArray(first.uploads) ? first.uploads.length : 'none',
        firstUpload: Array.isArray(first.uploads) ? first.uploads[0] : null,
      };
    }
  } else if (data && typeof data === 'object') {
    info.keys = Object.keys(data).slice(0, 30);
    info.id = data.id;
    info.type = data.type;
    info.name = data.name;
    info.uploads = Array.isArray(data.uploads) ? data.uploads.length : 'none';
    info.firstUpload = Array.isArray(data.uploads) ? data.uploads[0] : null;
  }
  state.shapes.push(info);
  if (state.shapes.length > 6) state.shapes.shift();
  return info;
}

function note(label, status, extra = '') {
  state.attempts.push({ label, status, extra });
  if (state.attempts.length > 60) state.attempts.shift();
  LOG(label, status, extra);
}

/* ------------------------------------------------------------------ 基础请求 */

async function jget(url, label = 'GET') {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json, text/plain, */*' },
  });
  const text = await res.text();
  note(label, res.status, `${res.headers.get('content-type') || ''} ${text.slice(0, 80)}`);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${url}`);
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error(`返回非 JSON：${text.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
}

function absolute(raw) {
  try {
    return new URL(raw, location.href).href;
  } catch (e) {
    return null;
  }
}

function nameFromSigned(signedUrl, fallback) {
  try {
    const url = new URL(signedUrl);
    const name = url.searchParams.get('name') || url.searchParams.get('filename');
    if (name) return decodeURIComponent(name);
  } catch (e) { /* ignore */ }
  return fallback || 'courseware.pdf';
}

const OFFICE_EXT = /\.(pptx?|docx?|xlsx?|key|pages|odt|odp|ods)$/i;

/* ------------------------------------------------------------- 签名链与落盘 */

/**
 * 签名接口矩阵：ZJU 上 /reference/document/{rid}/url?preview=true 通常直接给链；
 * 部分只读/跨课程件需要带 refer_id+refer_type（NJU 同款畅课就是这么要求的）；
 * 图片/音频则是 /uploads/{id}?preview=true。全部失败才报错。
 */
function signEndpoints(upload, ctx = {}) {
  const rid = upload && upload.reference_id;
  const id = upload && upload.id;
  const referType = ctx.referType || 'learning_activity';
  const refer = ctx.activityId ? `&refer_id=${ctx.activityId}&refer_type=${referType}` : '';
  const raw = [];
  if (rid) {
    raw.push([`reference/document/${rid}/url?preview=true`, 'ref']);
    raw.push([`reference/document/${rid}/url?preview=true${refer}`, 'ref+refer']);
  }
  if (id) {
    raw.push([`document/${id}/url?preview=true`, 'doc']);
    raw.push([`document/${id}/url?preview=true${refer}`, 'doc+refer']);
    raw.push([`${id}?preview=true`, 'raw']);
    raw.push([`${id}?preview=true${refer}`, 'raw+refer']);
  }
  const seen = new Set();
  return raw
    .filter(([path]) => (seen.has(path) ? false : seen.add(path)))
    .map(([path, label]) => ({ url: `${API}/uploads/${path}`, label }));
}

async function signUrl(upload, ctx = {}) {
  const key = `${upload.reference_id || ''}|${upload.id || ''}|${ctx.activityId || ''}`;
  if (state.signedCache.has(key)) return state.signedCache.get(key);

  let lastErr = null;
  for (const endpoint of signEndpoints(upload, ctx)) {
    try {
      const json = await jget(endpoint.url, `sign:${endpoint.label}`);
      if (json && json.url) {
        state.signedCache.set(key, json.url);
        return json.url;
      }
      lastErr = new Error(`签名接口没给 url（${endpoint.label}）`);
    } catch (e) {
      lastErr = new Error(`签名失败 ${endpoint.label}: ${e.message}`);
    }
  }
  throw lastErr || new Error('没有可用的签名接口');
}

function triggerAnchorDownload(href, name) {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** 取字节：先按 omit 拿（tcmedia 是 token 鉴权），再退 include，最后退浏览器直下 */
async function fetchBytes(signedUrl) {
  const tries = [
    { credentials: 'omit', referrerPolicy: 'no-referrer-when-downgrade' },
    { credentials: 'include' },
    { credentials: 'omit', referrer: location.href, referrerPolicy: 'unsafe-url' },
  ];
  let lastErr = null;
  for (const init of tries) {
    let res;
    try {
      res = await fetch(signedUrl, init);
    } catch (e) {
      lastErr = new Error(`fetch 抛错：${e.message}`);
      continue;
    }
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || contentType.includes('json') || contentType.includes('text/html')) {
      const body = await res.text().catch(() => '');
      lastErr = new Error(`取文件被拒 ${res.status} ${contentType} :: ${body.slice(0, 120)}`);
      note(`file:${init.credentials}`, res.status, contentType);
      continue;
    }
    note(`file:${init.credentials}`, res.status, contentType);
    return { blob: await res.blob(), contentType };
  }
  throw lastErr || new Error('取文件失败');
}

/** 落盘：校验过的字节直接存；实在被 CORS 拦就交回浏览器导航下载 */
async function saveSigned(signedUrl, fallbackName, extHint = '') {
  try {
    const { blob, contentType } = await fetchBytes(signedUrl);
    let name = nameFromSigned(signedUrl, fallbackName);
    if (contentType.includes('pdf') && OFFICE_EXT.test(name)) name += '.pdf';
    else if (contentType.includes('pdf') && !/\.pdf$/i.test(name)) name += '.pdf';
    const href = URL.createObjectURL(blob);
    triggerAnchorDownload(href, name);
    setTimeout(() => URL.revokeObjectURL(href), 60000);
    return { name, size: blob.size, type: contentType, via: 'fetch' };
  } catch (e) {
    if (/fetch 抛错/.test(String(e.message))) {
      const name = nameFromSigned(signedUrl, fallbackName || extHint);
      triggerAnchorDownload(signedUrl, name);
      note('nav-download', 'fallback', name);
      return { name, size: -1, type: 'navigation', via: 'navigation' };
    }
    throw e;
  }
}

/* --------------------------------------------------------------- 上下文解析 */

function readHashId() {
  const hash = location.hash || '';
  const matched = hash.match(/#\/?(\d{3,})/);
  return matched ? matched[1] : null;
}

function currentCourseId() {
  const matched = location.pathname.match(/\/course\/(\d+)/);
  if (matched) return matched[1];
  const href = location.href;
  const query = href.match(/[?&]course_?[iI]d=(\d+)/);
  return query ? query[1] : null;
}

function currentActivityId() {
  const path = location.pathname.match(/\/activit(?:y|ies)\/(\d+)/);
  if (path) return path[1];
  const href = location.href;
  const query = href.match(/[?&](?:activityId|activity_id|section_?id)=(\d+)/i);
  if (query) return query[1];
  return readHashId();
}

function currentReferType() {
  return /classroom/.test(location.pathname) ? 'classroom_activity' : 'learning_activity';
}

/** 同源 iframe / #pdf-viewer 里 pdf.js 的影印件：最可信的「当前文件」来源 */
/** 后台嗅探到的 tcmedia 签名链（WPS/pdf.js 预览在跨域 iframe 里时，这是唯一线索） */
async function sniffedSignedUrls() {
  const out = [];
  const push = (raw) => {
    if (!raw || typeof raw !== 'string') return;
    if (!/tcmedia\.zju\.edu\.cn\/.*\/download\//i.test(raw)) return;
    if (!out.includes(raw)) out.push(raw);
  };

  try {
    const res = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'xzzdGetSigned' }, (reply) => resolve(reply));
      } catch (e) { resolve(null); }
      setTimeout(() => resolve(null), 800);
    });
    ((res && res.urls) || []).forEach(push);
  } catch (e) { /* ignore */ }

  try {
    const stored = await new Promise((resolve) => {
      try {
        chrome.storage.sync.get(['pptUrl'], (r) => resolve(r));
      } catch (e) { resolve(null); }
    });
    if (stored && stored.pptUrl) push(stored.pptUrl);
  } catch (e) { /* ignore */ }

  return out;
}

function viewerSignedUrls() {
  const urls = [];
  const push = (raw) => {
    if (!raw) return;
    const url = absolute(typeof raw === 'string' ? raw : String(raw));
    if (url && !urls.includes(url)) urls.push(url);
  };
  const scanDoc = (doc) => {
    try {
      doc.querySelectorAll('#pdf-viewer, iframe, embed, object').forEach((node) => {
        const src = node.getAttribute('src') || node.getAttribute('data');
        if (!src) return;
        const parsed = absolute(src);
        if (!parsed) return;
        try {
          const file = new URL(parsed).searchParams.get('file');
          if (file) push(decodeURIComponent(file));
        } catch (e) { /* ignore */ }
        if (/tcmedia\.zju\.edu\.cn\/.*\/download\//i.test(parsed)) push(parsed);
      });
    } catch (e) { /* ignore */ }
  };
  scanDoc(document);
  try {
    Array.from(window.frames || []).forEach((child) => {
      try {
        if (child.document) scanDoc(child.document);
        const app = child.PDFViewerApplication;
        if (app && app.url) push(app.url);
      } catch (e) { /* 跨域 */ }
    });
  } catch (e) { /* ignore */ }
  try {
    if (window.PDFViewerApplication && window.PDFViewerApplication.url) push(window.PDFViewerApplication.url);
  } catch (e) { /* ignore */ }
  return urls;
}

/* ------------------------------------------------------------- 课件列表 API */

const UPLOAD_TYPES_DOWNLOADABLE = new Set(['document', 'image', 'audio', 'video']);
// 活动类型：这些对象自带 id/name/type，但它们是「活动」不是「附件」——
// 旧逻辑把 type=material、name=操作手册 的活动当成附件，导致 uploads 没被展开。
const ACTIVITY_TYPES = new Set([
  'material', 'homework', 'exam', 'discussion', 'classroom', 'questionnaire',
  'web_link', 'announcement', 'feedback', 'offline_activity', 'online_video',
  'lesson', 'scorm', 'survey', 'attendance', 'live', 'interaction',
]);

function isContainer(obj) {
  return Array.isArray(obj.uploads) || ACTIVITY_TYPES.has(String(obj.type || ''));
}

function looksLikeUpload(obj) {
  if (!obj || (typeof obj.id !== 'number' && typeof obj.reference_id !== 'number')) return false;
  if (isContainer(obj)) return false;
  if (obj.mime_type || obj.mime || obj.content_type) return true;
  const type = String(obj.type || '');
  if (UPLOAD_TYPES_DOWNLOADABLE.has(type)) return true;
  return type === '' && (obj.status === 'ready' || typeof obj.size === 'number');
}

/** 只收真正的附件；遇到带 uploads 的活动先下钻，别把它自己当附件 */
function harvestUploads(payload, bucket, seen, activityId) {
  if (Array.isArray(payload)) {
    payload.forEach((item) => harvestUploads(item, bucket, seen, activityId));
    return;
  }
  if (!payload || typeof payload !== 'object') return;

  if (looksLikeUpload(payload)) {
    const key = String(payload.reference_id || payload.id);
    if (!seen.has(key)) {
      seen.add(key);
      bucket.push({
        id: payload.id,
        reference_id: payload.reference_id,
        name: payload.name || payload.filename || payload.title || `upload-${payload.id}`,
        type: payload.type || '',
        status: payload.status || '',
        size: payload.size || 0,
        mime: payload.mime_type || payload.mime || payload.content_type || '',
        activityId: activityId || null,
      });
    }
    return;
  }

  const nextActivity = (typeof payload.id === 'number' && Array.isArray(payload.uploads))
    ? payload.id
    : activityId;
  Object.keys(payload).forEach((key) => {
    const value = payload[key];
    if (value && typeof value === 'object') harvestUploads(value, bucket, seen, nextActivity);
  });
}

async function listActivityUploads(activityId) {
  const endpoints = [
    `${API}/activities/${activityId}?sub_course_id=0`,
    `${API}/activities/${activityId}`,
    `${API}/activities/${activityId}/uploads`,
  ];
  for (const endpoint of endpoints) {
    try {
      const data = await jget(endpoint, 'activity');
      shapeOf(`activity:${activityId}`, data);
      const uploads = [];
      harvestUploads(data && (data.activity || data), uploads, new Set(), activityId);
      if (uploads.length) return uploads;
    } catch (e) { /* 换下一个 */ }
  }
  return [];
}

async function listCourseUploads(courseId, { force = false } = {}) {
  if (!courseId) throw new Error('当前不在课程页（URL 需包含 /course/<id>）');
  if (!force && state.uploadCache.has(courseId)) return state.uploadCache.get(courseId);

  const endpoints = [
    `${API}/course/${courseId}/coursewares?page=1&page_size=100`,
    `${API}/courses/${courseId}/activities`,
    `${API}/courses/${courseId}/activities?no_status=true`,
  ];
  let lastErr = null;
  for (const endpoint of endpoints) {
    try {
      const data = await jget(endpoint, 'list');
      shapeOf(endpoint.replace(API, ''), data);
      const uploads = [];
      harvestUploads(data, uploads, new Set(), null);
      if (uploads.length) {
        const keep = uploads.filter((u) => !u.type || UPLOAD_TYPES_DOWNLOADABLE.has(u.type));
        LOG(`课件列表来源 ${endpoint}，共 ${keep.length} 项`);
        state.uploadCache.set(courseId, keep);
        return keep;
      }
      lastErr = new Error(`${endpoint} 没解析到课件`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('拿不到课件列表');
}

/* ------------------------------------------------------- 「当前课件」的识别 */

function baseName(name) {
  return String(name || '').toLowerCase().replace(/\.[a-z0-9]+$/, '');
}

function pickDocument(uploads, hintName) {
  const docs = uploads.filter((u) => u.type === 'document' || !u.type);
  const pool = docs.length ? docs : uploads;
  if (!hintName) return pool[0] || null;
  const target = baseName(hintName);
  const scored = pool
    .map((upload) => {
      const other = baseName(upload.name);
      let score = 0;
      if (other && target && other === target) score = 3;
      else if (other && target && (other.includes(target) || target.includes(other))) score = 2;
      return { upload, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0] ? scored[0].upload : null;
}

async function downloadUpload(upload, ctx = {}) {
  const signed = await signUrl(upload, { ...ctx, activityId: ctx.activityId || upload.activityId });
  return saveSigned(signed, upload.name);
}

async function resolveCurrent({ quiet = false } = {}) {
  const ctx = { activityId: currentActivityId(), referType: currentReferType() };
  const hints = { courseId: currentCourseId(), ...ctx };
  if (!quiet) LOG('上下文', hints);

  // 1) 同源 viewer 里拿到的签名链（最可信）
  for (const url of viewerSignedUrls()) {
    try {
      const info = await saveSigned(url, nameFromSigned(url, 'courseware.pdf'));
      return { ...info, via: 'viewer-url' };
    } catch (e) {
      LOG('viewer 链不可用', url, e.message);
    }
  }

  // 1.5) 后台嗅探到的签名链（跨域 iframe / WPS 预览读不到 src 时的兜底）
  for (const url of await sniffedSignedUrls()) {
    try {
      const info = await saveSigned(url, nameFromSigned(url, 'courseware.pdf'));
      return { ...info, via: 'sniffed' };
    } catch (e) {
      LOG('嗅探链不可用', url.slice(0, 80), e.message);
    }
  }

  // 2) 当前活动自己的 uploads（aid 来自 URL / hash）
  if (ctx.activityId) {
    const uploads = await listActivityUploads(ctx.activityId).catch(() => []);
    const target = pickDocument(uploads, document.title || '');
    if (target) {
      try {
        return { ...(await downloadUpload(target, ctx)), via: `activity:${ctx.activityId}` };
      } catch (e) {
        LOG('活动课件下载失败', target.name, e.message);
      }
    }
  }

  // 3) 课程课件列表按名字匹配
  if (hints.courseId) {
    const uploads = await listCourseUploads(hints.courseId).catch(() => []);
    const target = pickDocument(uploads, document.title || '');
    if (target) {
      try {
        return { ...(await downloadUpload(target, ctx)), via: 'course-list' };
      } catch (e) {
        LOG('列表课件下载失败', target.name, e.message);
      }
    }
    if (uploads.length) {
      throw new Error(`识别不出当前课件（课程共 ${uploads.length} 项），用「选择课件下载」挑`);
    }
  }

  throw new Error('没有可用的课件线索：用「选择课件下载」按列表挑，或先点开课件');
}

async function downloadCurrentCourseware() {
  return resolveCurrent();
}

async function downloadWholeCourse(onProgress, { includeMedia = false } = {}) {
  const courseId = currentCourseId();
  const ctx = { referType: currentReferType() };
  const all = await listCourseUploads(courseId);
  const uploads = includeMedia ? all : all.filter((u) => u.type === 'document' || !u.type);
  const ok = [];
  const failed = [];
  for (let i = 0; i < uploads.length; i += 1) {
    const upload = uploads[i];
    const label = upload.name || `upload-${upload.id}`;
    if (onProgress) onProgress(i + 1, uploads.length, label);
    try {
      ok.push(await downloadUpload(upload, { ...ctx, activityId: upload.activityId }));
    } catch (e) {
      failed.push({ name: label, error: String(e.message || e) });
      LOG('失败', label, e);
    }
    await sleep(300);
  }
  return { ok, failed, total: uploads.length };
}

/* -------------------------------------------------------------------- 面板 */

function ensureTopFrame() {
  try {
    return window.top === window.self;
  } catch (e) {
    return true;
  }
}

function renderAttempts(box) {
  const logBox = box.querySelector('#zju-webx-xzzd-log');
  if (!logBox) return;
  const recent = state.attempts.slice(-8).map((a) => `${a.status} ${a.label} ${a.extra || ''}`.trim());
  logBox.textContent = recent.join('\n');
}

function mountPanel() {
  if (!/^courses\.zju\.edu\.cn$/i.test(location.hostname)) return;
  if (!ensureTopFrame()) return;
  if (document.getElementById(PANEL_ID)) return;

  const box = document.createElement('div');
  box.id = PANEL_ID;
  box.style.cssText = [
    'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
    'background:#fff', 'border:1px solid #003f88', 'border-radius:10px',
    'box-shadow:0 6px 24px rgba(0,0,0,.18)', 'padding:10px 12px',
    'font:13px/1.5 -apple-system,"Microsoft YaHei",sans-serif', 'color:#0b2545',
    'min-width:220px', 'max-width:340px', 'user-select:none',
  ].join(';');
  box.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px;color:#003f88;display:flex;justify-content:space-between;align-items:center">
      <span>学在浙大课件下载</span>
      <span id="zju-webx-xzzd-min" style="cursor:pointer;color:#888;font-weight:400">—</span>
    </div>
    <div id="zju-webx-xzzd-body">
      <button data-act="cur" style="width:100%;margin:3px 0;padding:6px;border:0;border-radius:6px;background:#003f88;color:#fff;cursor:pointer">下载当前课件</button>
      <button data-act="list" style="width:100%;margin:3px 0;padding:6px;border:0;border-radius:6px;background:#1d6fb8;color:#fff;cursor:pointer">选择课件下载</button>
      <button data-act="all" style="width:100%;margin:3px 0;padding:6px;border:0;border-radius:6px;background:#3c8f45;color:#fff;cursor:pointer">下载本课程全部</button>
      <button data-act="sniff" style="width:100%;margin:3px 0;padding:6px;border:0;border-radius:6px;background:#8a5a00;color:#fff;cursor:pointer">下载预览中的文件</button>
      <button data-act="diag" style="width:100%;margin:3px 0;padding:4px;border:1px solid #ccd;border-radius:6px;background:#f7f9fc;color:#456;cursor:pointer;font-size:12px">诊断（复制到剪贴板）</button>
      <div id="zju-webx-xzzd-list" style="display:none;margin-top:6px;max-height:260px;overflow:auto;border-top:1px solid #e3e8f0"></div>
      <div id="zju-webx-xzzd-msg" style="margin-top:6px;color:#555;max-width:300px;word-break:break-all;font-size:12px"></div>
      <pre id="zju-webx-xzzd-log" style="display:none;margin:6px 0 0;padding:4px;background:#f7f9fc;border-radius:4px;font-size:10px;line-height:1.35;max-height:110px;overflow:auto;white-space:pre-wrap;color:#666"></pre>
    </div>
  `;
  document.body.appendChild(box);

  const msg = box.querySelector('#zju-webx-xzzd-msg');
  const listBox = box.querySelector('#zju-webx-xzzd-list');
  const logBox = box.querySelector('#zju-webx-xzzd-log');
  const setMsg = (text) => { msg.textContent = text; renderAttempts(box); };

  logBox.style.display = 'block';

  box.querySelector('#zju-webx-xzzd-min').addEventListener('click', () => {
    const body = box.querySelector('#zju-webx-xzzd-body');
    const hidden = body.style.display === 'none';
    body.style.display = hidden ? 'block' : 'none';
    box.querySelector('#zju-webx-xzzd-min').textContent = hidden ? '—' : '+';
  });

  box.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const act = button.dataset.act;

    if (act === 'cur') {
      setMsg('处理中…');
      button.disabled = true;
      try {
        const info = await downloadCurrentCourseware();
        setMsg(`已下载 ${info.name}${info.size > 0 ? `（${info.size} 字节）` : ''} · ${info.via}`);
      } catch (e) {
        setMsg(`失败：${e.message || e}`);
      } finally {
        button.disabled = false;
        renderAttempts(box);
      }
      return;
    }

    if (act === 'sniff') {
      setMsg('查找预览链接…');
      button.disabled = true;
      try {
        const urls = await sniffedSignedUrls();
        if (!urls.length) {
          setMsg('没抓到预览链接：先把课件在页面里翻一页，再点这个按钮');
          return;
        }
        LOG('嗅探到', urls.length, urls[0].slice(0, 90));
        let last = null;
        for (const url of urls) {
          try {
            last = await saveSigned(url, nameFromSigned(url, 'courseware.pdf'));
            break;
          } catch (e) {
            LOG('嗅探链不可用', url.slice(0, 60), e.message);
          }
        }
        setMsg(last ? `已下载 ${last.name}${last.size > 0 ? `（${last.size} 字节）` : ''}` : `抓到 ${urls.length} 条链接但都取不到字节`);
      } catch (e) {
        setMsg(`失败：${e.message || e}`);
      } finally {
        button.disabled = false;
        renderAttempts(box);
      }
      return;
    }

    if (act === 'diag') {
      const courseId = currentCourseId();
      const activityId = currentActivityId();
      const uploads = courseId ? await listCourseUploads(courseId, { force: true }).catch(() => []) : [];
      const activityUploads = activityId ? await listActivityUploads(activityId).catch(() => []) : [];
      const dump = {
        href: location.href,
        hash: location.hash,
        courseId,
        activityId,
        referType: currentReferType(),
        viewer: viewerSignedUrls(),
        sniffed: await sniffedSignedUrls(),
        uploadCount: uploads.length,
        uploads: uploads.slice(0, 20),
        activityUploads,
        shapes: state.shapes,
        attempts: state.attempts,
      };
      try {
        await navigator.clipboard.writeText(JSON.stringify(dump, null, 2));
        setMsg(`已复制诊断 JSON 到剪贴板（课件 ${uploads.length}、活动件 ${activityUploads.length}）`);
      } catch (e) {
        console.log('[zju-webx][xzzd] 诊断', dump);
        setMsg('剪贴板不可用，诊断已打到控制台（F12）');
      }
      return;
    }

    if (act === 'list') {
      if (listBox.style.display === 'block') {
        listBox.style.display = 'none';
        return;
      }
      setMsg('拉取课件列表…');
      try {
        const uploads = await listCourseUploads(currentCourseId(), { force: true });
        listBox.innerHTML = '';
        if (!uploads.length) {
          setMsg('没解析到课件，点「诊断」把日志发我');
          return;
        }
        uploads.forEach((upload) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:3px 0;border-bottom:1px dashed #eef1f6';
          const label = document.createElement('span');
          label.textContent = `${upload.name}${upload.type && upload.type !== 'document' ? ` [${upload.type}]` : ''}`;
          label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px';
          label.title = upload.name;
          const pick = document.createElement('button');
          pick.textContent = '下载';
          pick.style.cssText = 'border:0;border-radius:4px;background:#1d6fb8;color:#fff;padding:2px 8px;cursor:pointer;font-size:12px';
          pick.addEventListener('click', async () => {
            pick.disabled = true;
            setMsg(`下载 ${upload.name}…`);
            try {
              const info = await downloadUpload(upload, {
                referType: currentReferType(),
                activityId: upload.activityId || currentActivityId(),
              });
              setMsg(`已下载 ${info.name}${info.size > 0 ? `（${info.size} 字节）` : ''}`);
            } catch (e) {
              setMsg(`失败：${e.message || e}`);
            } finally {
              pick.disabled = false;
              renderAttempts(box);
            }
          });
          row.appendChild(label);
          row.appendChild(pick);
          listBox.appendChild(row);
        });
        listBox.style.display = 'block';
        setMsg(`共 ${uploads.length} 项，点右侧「下载」`);
      } catch (e) {
        setMsg(`失败：${e.message || e}`);
      } finally {
        renderAttempts(box);
      }
      return;
    }

    if (act === 'all') {
      button.disabled = true;
      try {
        const result = await downloadWholeCourse((i, total, name) => setMsg(`${i}/${total} ${name}`));
        setMsg(`完成：成功 ${result.ok.length}，失败 ${result.failed.length}（共 ${result.total}）`);
        if (result.failed.length) console.table(result.failed);
      } catch (e) {
        setMsg(`失败：${e.message || e}`);
      } finally {
        button.disabled = false;
        renderAttempts(box);
      }
    }
  });
}

export default function mountXzzdDownloadFix() {
  if (window.__zjuWebxXzzdMounted) return;
  window.__zjuWebxXzzdMounted = true;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountPanel);
  } else {
    mountPanel();
  }
  window.__xzzd = {
    downloadCurrentCourseware,
    downloadWholeCourse,
    listCourseUploads,
    listActivityUploads,
    signUrl,
    saveSigned,
    viewerSignedUrls,
    resolveCurrent,
    state,
  };
}
