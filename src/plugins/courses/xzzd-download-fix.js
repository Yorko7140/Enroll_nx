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
const LOG = (...args) => console.log('[zju-webx][xzzd]', ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  attempts: [],                                  // [{label, status, note}]
  uploadCache: new Map(),                        // courseId -> uploads
  signedCache: new Map(),                        // key -> signed url
  shapes: [],                                    // 接口返回体结构快照（诊断用）
  rescued: new Set(),                            // 已通过 blob 兜底处理过的 upload id
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
  // 实测顺序（courses.zju.edu.cn）：
  //   document/{id}/url?preview=true        多数只读件 200
  //   document/{id}/url?preview=true&refer… 部分件只有带 refer 才 200
  //   reference/document/{ref}/url          该课程一律 403 {"message":""}，放最后当兜底
  const raw = [];
  if (id) {
    raw.push([`document/${id}/url?preview=true`, 'doc']);
    raw.push([`document/${id}/url?preview=true${refer}`, 'doc+refer']);
    raw.push([`${id}?preview=true`, 'raw']);
    raw.push([`${id}?preview=true${refer}`, 'raw+refer']);
  }
  if (rid) {
    raw.push([`reference/document/${rid}/url?preview=true`, 'ref']);
    raw.push([`reference/document/${rid}/url?preview=true${refer}`, 'ref+refer']);
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
    if (!/tcmedia\.zju\.edu\.cn\/download\/(file|processed|media)\//i.test(raw)) return;
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
        if (/tcmedia\.zju\.edu\.cn\/download\/(file|processed|media)\//i.test(parsed)) push(parsed);
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

/* ------------------------------------------------------- 接管平台「下载课件」 */

function ensureTopFrame() {
  try {
    return window.top === window.self;
  } catch (e) {
    return true;
  }
}

function normalizeText(node) {
  return (node.textContent || '').replace(/\s+/g, '');
}

/** 从点击目标向上找平台那颗「下载课件」按钮（按文字认，不依赖 class） */
function findPlatformEntry(target) {
  const ENTRY = '下载课件';
  let node = target;
  for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth += 1, node = node.parentElement) {
    if (node.dataset && node.dataset.zjuXzzdStatus) return null;   // 别把自己的状态条当按钮
    const text = normalizeText(node);
    if (text === ENTRY) return node;
    if (text.length > ENTRY.length + 4) break;
  }
  return null;
}

let statusNode = null;
let statusTimer = 0;

/** 状态直接挂在平台按钮旁边（行内文字，不是悬浮窗） */
function showStatus(text, entry) {
  if (!entry || !entry.parentElement) return;
  if (!statusNode || !statusNode.isConnected) {
    statusNode = document.createElement('span');
    statusNode.dataset.zjuXzzdStatus = '1';
    statusNode.style.cssText = [
      'margin-left:10px', 'font:12px/1.4 -apple-system,"Microsoft YaHei",sans-serif',
      'color:#1d6fb8', 'pointer-events:none', 'white-space:nowrap',
    ].join(';');
    entry.insertAdjacentElement('afterend', statusNode);
  }
  statusNode.textContent = text;
  statusNode.style.color = /失败|无/.test(text) ? '#c1272d' : '#1d6fb8';
  if (statusTimer) clearTimeout(statusTimer);
  if (!/下载中|准备/.test(text)) {
    statusTimer = setTimeout(() => {
      if (statusNode && statusNode.isConnected && !/下载中/.test(statusNode.textContent || '')) {
        statusNode.textContent = '';
      }
    }, 8000);
  }
}

/** 本页面应该下载的课件：优先当前活动的 uploads，其次课程列表里出现在页面上的那些 */
async function pageCoursewares() {
  const aid = currentActivityId();
  let uploads = aid ? await listActivityUploads(aid).catch(() => []) : [];
  if (uploads.length) return { uploads, source: `activity:${aid}` };

  const cid = currentCourseId();
  if (!cid) return { uploads: [], source: 'none' };
  const all = await listCourseUploads(cid).catch(() => []);
  if (!all.length) return { uploads: [], source: 'none' };

  const pageText = normalizeText(document.body);
  const onPage = all.filter((u) => {
    const stem = baseName(u.name).replace(/\.[^.]+$/, '').slice(0, 6);
    return stem && pageText.includes(stem);
  });
  return { uploads: onPage.length ? onPage : all, source: onPage.length ? 'page-filtered' : 'course-list' };
}

let running = false;

async function runEntryDownload(entry) {
  if (running) {
    showStatus('正在下载，稍等…', entry);
    return;
  }
  running = true;
  const setStatus = (text) => showStatus(text, entry);
  showStatus('准备…', entry);

  try {
    const { uploads, source } = await pageCoursewares();
    if (!uploads.length) {
      setStatus('这一步没找到课件，先点开课件再看');
      return;
    }
    const docs = uploads.filter((u) => u.type === 'document' || !u.type);
    const targets = docs.length ? docs : uploads;
    LOG('入口下载', source, `${targets.length} 件`);

    const ctx = { referType: currentReferType() };
    const ok = [];
    const failed = [];
    for (let i = 0; i < targets.length; i += 1) {
      const upload = targets[i];
      const label = upload.name || `upload-${upload.id}`;
      setStatus(`下载中 ${i + 1}/${targets.length}：${label}`);
      try {
        ok.push(await downloadUpload(upload, {
          ...ctx,
          activityId: upload.activityId || currentActivityId(),
        }));
      } catch (e) {
        failed.push({ name: label, error: String(e.message || e) });
        LOG('失败', label, e);
      }
      await sleep(350);
    }

    if (!failed.length) setStatus(`已下载 ${ok.length} 个文件`);
    else if (ok.length) setStatus(`完成 ${ok.length} 个，失败 ${failed.length} 个（见控制台）`);
    else setStatus(`下载失败：${failed[0].error}`);
    if (failed.length) console.table(failed);
  } catch (e) {
    LOG('入口下载异常', e);
    setStatus(`失败：${e.message || e}`);
  } finally {
    running = false;
  }
}

function onPlatformClick(event) {
  const entry = findPlatformEntry(event.target);
  if (!entry) return;
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
  runEntryDownload(entry);
}

/** 兜底：平台自己发 /blob 请求时（换了入口、或我们没拦住），顺手用签名链重下一份 */
function patchBlobXhr() {
  const proto = XMLHttpRequest.prototype;
  if (proto.__zjuXzzdPatched) return;
  proto.__zjuXzzdPatched = true;

  const rawOpen = proto.open;
  proto.open = function patchedOpen(method, url, ...rest) {
    try {
      this.__zjuXzzdUrl = typeof url === 'string' ? url : String(url);
    } catch (e) { /* ignore */ }
    return rawOpen.call(this, method, url, ...rest);
  };

  const rawSend = proto.send;
  proto.send = function patchedSend(...args) {
    try {
      const url = this.__zjuXzzdUrl || '';
      const hit = url.match(/\/api\/uploads\/(?:reference\/)?(?:document|image|audio|video)\/(\d+)\/blob/i)
        || url.match(/\/api\/uploads\/(\d+)\/blob/i);
      if (hit) {
        const uploadId = Number(hit[1]);
        if (!state.rescued.has(uploadId)) {
          state.rescued.add(uploadId);
          setTimeout(() => rescueBlob(uploadId), 0);
        }
      }
    } catch (e) { /* ignore */ }
    return rawSend.apply(this, args);
  };
}

async function rescueBlob(uploadId) {
  const aid = currentActivityId();
  let pool = aid ? await listActivityUploads(aid).catch(() => []) : [];
  let upload = pool.find((u) => u.id === uploadId || u.reference_id === uploadId);
  if (!upload) {
    const cid = currentCourseId();
    pool = cid ? await listCourseUploads(cid).catch(() => []) : [];
    upload = pool.find((u) => u.id === uploadId || u.reference_id === uploadId);
  }
  if (!upload) upload = { id: uploadId, reference_id: null, name: `upload-${uploadId}`, type: 'document' };
  LOG('blob 兜底', upload.name);
  try {
    await downloadUpload(upload, { activityId: upload.activityId || aid, referType: currentReferType() });
  } catch (e) {
    LOG('blob 兜底失败', upload.name, e);
  }
}

export default function mountXzzdDownloadFix() {
  if (!/^courses\.zju\.edu\.cn$/i.test(location.hostname)) return;
  if (!ensureTopFrame()) return;
  if (window.__xzzdMounted) return;
  window.__xzzdMounted = true;

  patchBlobXhr();
  document.addEventListener('click', onPlatformClick, true);

  // 平台有些页面把附件区放在同源 iframe 里，那边也要挂一份
  const hookFrames = () => {
    try {
      Array.from(window.frames || []).forEach((frame) => {
        try {
          frame.document.addEventListener('click', onPlatformClick, true);
        } catch (e) { /* 跨域，忽略 */ }
      });
    } catch (e) { /* ignore */ }
  };
  hookFrames();
  window.addEventListener('load', hookFrames);
  setTimeout(hookFrames, 1200);
  setTimeout(hookFrames, 3000);

  // 给命令行/脚本留的接口（无 UI）
  window.__xzzd = {
    downloadPage: () => runEntryDownload(null),
    downloadCurrent: () => downloadCurrentCourseware(),
    downloadWholeCourse,
    pageCoursewares,
    sniffedSignedUrls,
    diagnostics: async () => ({
      href: location.href,
      hash: location.hash,
      courseId: currentCourseId(),
      activityId: currentActivityId(),
      referType: currentReferType(),
      shapes: state.shapes,
      attempts: state.attempts,
    }),
  };
  LOG('已接管「下载课件」按钮');
}
