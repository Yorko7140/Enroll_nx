/**
 * 学在浙大（courses.zju.edu.cn）课件下载修复 v2
 *
 * 背景：平台对「只有查看权限」的课件，下载型接口（/api/uploads/{id}/blob、
 * /api/uploads/reference/{rid}/blob）会返回 HTTP 200 + {"message":"您没有权限完成此操作"}。
 * 旧流程只看 xhr.status == 200 就落盘，于是把这段 75 字节 JSON 存成了 .pdf。
 *
 * v1 的问题：只在「当前文档」里找 #pdf-viewer / iframe 的 src，而实际上课件的
 * 预览是 WPS 在线预览（src 里带 _w_third_file_id），常常在跨域 iframe 或
 * blob: URL 里，甚至只有 canvas，于是「检测不到」。
 *
 * v2 改成「多源候选 + 逐个试签名 + 列表兜底」：
 *   - 候选来源：本站与所有同源 iframe 的 location.href、任意元素的 src/href/data-*、
 *     performance 里的资源请求、WPS 的 _w_third_file_id、URL 里的 activityId/upload_id；
 *   - 对每个候选 id 依次试 /api/uploads/reference/document/{id}/url?preview=true
 *     和 /api/uploads/document/{id}/url?preview=true，签名接口不给链就自动换下一个；
 *   - 还不行就用 /api/activities/{aid} 或整门课程的 activities 列表按名字匹配；
 *   - 最后面板上给一份「本课程课件列表」，点哪条下哪条，不吃检测的运气。
 * 落盘前强校验 status 与 Content-Type，JSON 一律判失败。
 */

const API = 'https://courses.zju.edu.cn/api';
const PANEL_ID = 'zju-webx-xzzd-panel';
const LOG = (...args) => console.log('[zju-webx][xzzd]', ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ 基础请求 */

async function jget(url) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`返回非 JSON：${text.slice(0, 160)}`);
  }
}

const signedCache = new Map();

/** 取预览签名链：reference_id 优先，其次 upload id */
async function signUrl(upload) {
  const id = upload && (upload.reference_id || upload.id);
  const cacheKey = String(id || '');
  if (cacheKey && signedCache.has(cacheKey)) return signedCache.get(cacheKey);

  const candidates = [];
  if (upload && upload.reference_id) {
    candidates.push(`${API}/uploads/reference/document/${upload.reference_id}/url?preview=true`);
  }
  if (upload && upload.id) {
    candidates.push(`${API}/uploads/document/${upload.id}/url?preview=true`);
  }
  let lastErr = null;
  for (const url of candidates) {
    try {
      const json = await jget(url);
      if (json && json.url) {
        if (cacheKey) signedCache.set(cacheKey, json.url);
        return json.url;
      }
      lastErr = new Error(`${url} -> ${JSON.stringify(json).slice(0, 160)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('没有可用的签名接口');
}

function nameFromSigned(signedUrl, fallback) {
  try {
    const url = new URL(signedUrl);
    const name = url.searchParams.get('name') || url.searchParams.get('filename');
    if (name) return decodeURIComponent(name);
  } catch (e) { /* ignore */ }
  return fallback || 'courseware.pdf';
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

/** 落盘前校验状态码与 Content-Type，绝不把 JSON 当文件存 */
async function saveSigned(signedUrl, fallbackName) {
  let res;
  try {
    res = await fetch(signedUrl, { credentials: 'omit' });
  } catch (e) {
    // 跨域（tcmedia 不带 CORS 头）时退化成浏览器直接下载：链接里自带 token 鉴权
    const name = nameFromSigned(signedUrl, fallbackName);
    triggerAnchorDownload(signedUrl, name);
    LOG('fetch 被 CORS 拦，改为浏览器直接下载', name);
    return { name, size: -1, type: 'browser-navigation' };
  }
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok || contentType.includes('json') || contentType.includes('text/html')) {
    const body = await res.text();
    throw new Error(`取文件被拒 ${res.status} ${contentType} :: ${body.slice(0, 160)}`);
  }
  const blob = await res.blob();
  let name = nameFromSigned(signedUrl, fallbackName);
  if (contentType.includes('pdf') && !/\.pdf$/i.test(name)) name += '.pdf';

  const href = URL.createObjectURL(blob);
  triggerAnchorDownload(href, name);
  setTimeout(() => URL.revokeObjectURL(href), 60000);
  return { name, size: blob.size, type: contentType };
}

/* ------------------------------------------------------- 候选 URL 的采集与解析 */

function safeLocation(win) {
  try {
    return win.location.href;
  } catch (e) {
    return null;
  }
}

/** 遍历本站 + 所有同源 iframe 的 document（跨域的就只能读属性） */
function collectDocuments() {
  const docs = [document];
  const walk = (win) => {
    let frames = [];
    try {
      frames = Array.from(win.frames || []);
    } catch (e) {
      return;
    }
    frames.forEach((child) => {
      try {
        if (child.document && child.document.body) docs.push(child.document);
        walk(child);
      } catch (e) { /* 跨域，跳过 */ }
    });
  };
  walk(window);
  return docs;
}

/** 靠 performance 抓到页面实际请求过的资源（预览链路都会在这里出现） */
function collectResourceUrls() {
  const urls = [];
  const windows = [window];
  try {
    Array.from(window.frames || []).forEach((child) => {
      try {
        if (child.performance) windows.push(child);
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }

  windows.forEach((win) => {
    try {
      win.performance.getEntriesByType('resource').forEach((entry) => {
        if (entry && entry.name) urls.push(entry.name);
      });
    } catch (e) { /* ignore */ }
  });
  return urls;
}

const HINT_ATTRS = ['src', 'href', 'data-src', 'data-url', 'data-href', 'data-file', 'data-path', 'content'];

function collectAttributeUrls() {
  const urls = [];
  collectDocuments().forEach((doc) => {
    let nodes;
    try {
      nodes = doc.querySelectorAll('iframe,embed,object,source,video,audio,a,link,div[id],div[class],meta');
    } catch (e) {
      return;
    }
    nodes.forEach((node) => {
      HINT_ATTRS.forEach((attr) => {
        const value = node.getAttribute && node.getAttribute(attr);
        if (value && value.length < 2048) urls.push(value);
      });
    });
  });
  return urls;
}

function absolute(raw) {
  try {
    return new URL(raw, location.href).href;
  } catch (e) {
    return null;
  }
}

/**
 * 从任意字符串里榨出可用线索：
 *  - signed: 直接可下的签名链（tcmedia /download/… 或任意 URL 的 file= 参数）
 *  - activityIds / uploadIds / names：用来回查 API 的 id
 */
function extractHints(raws) {
  const signed = [];
  const activityIds = new Set();
  const uploadIds = new Set();
  const names = new Set();

  const pushSigned = (value) => {
    if (value && /^https?:\/\//i.test(value) && !signed.includes(value)) signed.push(value);
  };

  raws.forEach((raw) => {
    if (!raw) return;
    const text = String(raw);

    // 直接写成完整 URL 的签名链
    if (/tcmedia\.zju\.edu\.cn\//i.test(text) && /\/download\//i.test(text)) {
      const matched = text.match(/https?:\/\/tcmedia\.zju\.edu\.cn\/[^\s"'<>]+/i);
      if (matched) pushSigned(matched[0]);
    }

    const url = absolute(text);
    if (!url) return;

    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return;
    }

    // 任何把真实文件地址塞在参数里的（file=…&name=…）
    ['file', 'url', 'src', 'download', 'preview_url', 'previewUrl'].forEach((key) => {
      const value = parsed.searchParams.get(key);
      if (!value) return;
      const decoded = decodeURIComponent(value);
      if (/^https?:\/\//i.test(decoded)) pushSigned(decoded);
    });

    // id 线索
    ['activityId', 'activity_id'].forEach((key) => {
      const value = parsed.searchParams.get(key);
      if (value && /^\d+$/.test(value)) activityIds.add(value);
    });
    ['upload_id', 'uploadId', 'file_id', 'fileId', 'reference_id', 'referenceId', '_w_third_file_id', 'id'].forEach((key) => {
      const value = parsed.searchParams.get(key);
      if (value && /^\d+$/.test(value)) uploadIds.add(value);
    });
    ['name', 'filename', 'fileName', 'title'].forEach((key) => {
      const value = parsed.searchParams.get(key);
      if (value) names.add(decodeURIComponent(value));
    });

    // 路径里的 id
    const path = parsed.pathname || '';
    const activityPath = path.match(/\/activit(?:y|ies)\/(\d+)/i);
    if (activityPath) activityIds.add(activityPath[1]);
    const uploadPath = path.match(/\/uploads?\/(?:document\/|reference\/document\/)?(\d+)/i);
    if (uploadPath) uploadIds.add(uploadPath[1]);
    const filePath = path.match(/\/(?:file|files|resource)\/(\d+)/i);
    if (filePath) uploadIds.add(filePath[1]);

    const nameInPath = path.match(/\/([^/]+\.(?:pdf|pptx?|docx?|xlsx?|zip|rar|txt|md|mp4))$/i);
    if (nameInPath) names.add(decodeURIComponent(nameInPath[1]));
  });

  return { signed, activityIds: [...activityIds], uploadIds: [...uploadIds], names: [...names] };
}

function collectHints() {
  const raws = [];
  const pushLocation = (win) => {
    const href = safeLocation(win);
    if (href) raws.push(href);
  };
  pushLocation(window);
  try {
    Array.from(window.frames || []).forEach((child) => pushLocation(child));
  } catch (e) { /* ignore */ }

  raws.push(...collectAttributeUrls());
  raws.push(...collectResourceUrls());
  return extractHints(raws);
}

/* ------------------------------------------------------------- 课程与课件列表 */

function currentCourseId() {
  const matched = location.pathname.match(/\/course\/(\d+)/);
  if (matched) return matched[1];
  const href = safeLocation(window) || '';
  const query = href.match(/[?&]course_?[iI]d=(\d+)/);
  return query ? query[1] : null;
}

function harvestUploads(payload, bucket, seen) {
  if (!payload || typeof payload !== 'object') return;
  if (Array.isArray(payload)) {
    payload.forEach((item) => harvestUploads(item, bucket, seen));
    return;
  }
  const looksLikeUpload = (payload.id || payload.reference_id) && (payload.name || payload.filename || payload.title);
  if (looksLikeUpload) {
    const key = String(payload.reference_id || payload.id);
    if (!seen.has(key)) {
      seen.add(key);
      bucket.push({
        id: payload.id,
        reference_id: payload.reference_id,
        name: payload.name || payload.filename || payload.title,
        type: payload.type || payload.content_type || '',
      });
    }
    return;
  }
  Object.keys(payload).forEach((key) => {
    const value = payload[key];
    if (value && typeof value === 'object') harvestUploads(value, bucket, seen);
  });
}

async function listCourseUploads(courseId, { force = false } = {}) {
  if (!courseId) throw new Error('当前不在课程页（URL 需包含 /course/<id>）');
  if (!force && courseUploadCache.has(courseId)) return courseUploadCache.get(courseId);

  const endpoints = [
    `${API}/courses/${courseId}/activities`,
    `${API}/courses/${courseId}/activities?no_status=true`,
    `${API}/courses/${courseId}/activities?page=1&page_size=200&no_status=true`,
    `${API}/courses/${courseId}/coursewares`,
  ];
  let lastErr = null;
  for (const endpoint of endpoints) {
    try {
      const data = await jget(endpoint);
      const uploads = [];
      harvestUploads(data, uploads, new Set());
      if (uploads.length) {
        LOG(`课件列表来源 ${endpoint}，共 ${uploads.length} 个`);
        courseUploadCache.set(courseId, uploads);
        return uploads;
      }
      lastErr = new Error(`${endpoint} 没有解析到课件`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('拿不到课件列表');
}

const courseUploadCache = new Map();

async function listActivityUploads(activityId) {
  const endpoints = [
    `${API}/activities/${activityId}`,
    `${API}/courses/${currentCourseId()}/activities/${activityId}`,
  ];
  for (const endpoint of endpoints) {
    try {
      const data = await jget(endpoint);
      const uploads = [];
      harvestUploads(data && (data.activity || data), uploads, new Set());
      if (uploads.length) return uploads;
    } catch (e) { /* 换下一个 */ }
  }
  return [];
}

/* ------------------------------------------------------- 「当前课件」的尽力而为 */

function scoreName(uploadName, hints) {
  if (!uploadName) return 0;
  const base = String(uploadName).toLowerCase().replace(/\.[a-z0-9]+$/, '');
  let score = 0;
  hints.names.forEach((candidate) => {
    const other = String(candidate).toLowerCase().replace(/\.[a-z0-9]+$/, '');
    if (!other) return;
    if (other === base) score = Math.max(score, 3);
    else if (other.includes(base) || base.includes(other)) score = Math.max(score, 2);
  });
  return score;
}

async function resolveCurrent({ quiet = false } = {}) {
  const hints = collectHints();
  if (!quiet) LOG('候选线索', hints);

  // 1) 直接拿到的签名链
  for (const url of hints.signed) {
    try {
      const info = await saveSigned(url, nameFromSigned(url, 'courseware.pdf'));
      return { ...info, via: 'signed-url' };
    } catch (e) {
      LOG('签名链不可用，继续', url, e.message);
    }
  }

  // 2) activityId -> 该活动的 uploads
  for (const activityId of hints.activityIds) {
    const uploads = await listActivityUploads(activityId).catch(() => []);
    for (const upload of uploads) {
      try {
        const signed = await signUrl(upload);
        const info = await saveSigned(signed, upload.name);
        return { ...info, via: `activity:${activityId}` };
      } catch (e) { /* 试下一个 */ }
    }
  }

  // 3) 把 URL / _w_third_file_id 里的数字当 upload / reference id 逐个试
  for (const id of hints.uploadIds) {
    const upload = { id, reference_id: id, name: 'courseware' };
    try {
      const signed = await signUrl(upload);
      const info = await saveSigned(signed, 'courseware.pdf');
      return { ...info, via: `upload-id:${id}` };
    } catch (e) { /* 试下一个 */ }
  }

  // 4) 课程课件列表按名字猜
  const courseId = currentCourseId();
  if (courseId) {
    const uploads = await listCourseUploads(courseId).catch(() => []);
    const ranked = uploads
      .map((upload) => ({ upload, score: scoreName(upload.name, hints) }))
      .sort((a, b) => b.score - a.score);
    for (const { upload } of ranked.slice(0, 3)) {
      try {
        const signed = await signUrl(upload);
        const info = await saveSigned(signed, upload.name);
        return { ...info, via: 'name-match' };
      } catch (e) { /* 试下一个 */ }
    }
    if (uploads.length) {
      throw new Error(`识别不出当前课件，请用「选择课件下载」从 ${uploads.length} 个里挑`);
    }
  }

  throw new Error('当前页面没有课件预览信息：用「选择课件下载」按列表挑，或先点开一个课件');
}

async function downloadCurrentCourseware() {
  return resolveCurrent();
}

async function downloadWholeCourse(onProgress) {
  const courseId = currentCourseId();
  const uploads = await listCourseUploads(courseId);
  const ok = [];
  const failed = [];
  for (let i = 0; i < uploads.length; i += 1) {
    const upload = uploads[i];
    const label = upload.name || `upload-${upload.id}`;
    if (onProgress) onProgress(i + 1, uploads.length, label);
    try {
      const signed = await signUrl(upload);
      ok.push(await saveSigned(signed, label));
    } catch (e) {
      failed.push({ name: label, error: String(e.message || e) });
      LOG('失败', label, e);
    }
    await sleep(350); // 温柔一点，别触发限流
  }
  return { ok, failed };
}

/* ------------------------------------------------------------------ 面板 UI */

function ensureTopFrame() {
  try {
    return window.top === window.self;
  } catch (e) {
    return true; // 跨域也说明自己是顶层
  }
}

function mountPanel() {
  if (!/^courses\.zju\.edu\.cn$/i.test(location.hostname)) return;
  if (!ensureTopFrame()) return; // 内嵌 iframe 里不重复挂面板
  if (document.getElementById(PANEL_ID)) return;

  const box = document.createElement('div');
  box.id = PANEL_ID;
  box.style.cssText = [
    'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
    'background:#fff', 'border:1px solid #003f88', 'border-radius:10px',
    'box-shadow:0 6px 24px rgba(0,0,0,.18)', 'padding:10px 12px',
    'font:13px/1.5 -apple-system,"Microsoft YaHei",sans-serif', 'color:#0b2545',
    'min-width:210px', 'max-width:320px', 'user-select:none',
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
      <button data-act="diag" style="width:100%;margin:3px 0;padding:4px;border:1px solid #ccd;border-radius:6px;background:#f7f9fc;color:#456;cursor:pointer;font-size:12px">诊断（输出到控制台）</button>
      <div id="zju-webx-xzzd-list" style="display:none;margin-top:6px;max-height:260px;overflow:auto;border-top:1px solid #e3e8f0"></div>
      <div id="zju-webx-xzzd-msg" style="margin-top:6px;color:#555;max-width:290px;word-break:break-all;font-size:12px"></div>
    </div>
  `;
  document.body.appendChild(box);

  const msg = box.querySelector('#zju-webx-xzzd-msg');
  const listBox = box.querySelector('#zju-webx-xzzd-list');
  const setMsg = (text) => { msg.textContent = text; };

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
        setMsg(`已下载 ${info.name}${info.size > 0 ? `（${info.size} 字节）` : ''} · 来源 ${info.via}`);
      } catch (e) {
        setMsg(`失败：${e.message || e}`);
      } finally {
        button.disabled = false;
      }
      return;
    }

    if (act === 'diag') {
      const hints = collectHints();
      const courseId = currentCourseId();
      console.log('[zju-webx][xzzd] 诊断', {
        href: location.href,
        frames: (() => {
          try {
            return Array.from(window.frames || []).map((f) => safeLocation(f));
          } catch (e) {
            return [];
          }
        })(),
        courseId,
        hints,
      });
      let extra = '';
      if (courseId) {
        const uploads = await listCourseUploads(courseId, { force: true }).catch((e) => {
          extra = `；课件列表失败 ${e.message}`;
          return [];
        });
        console.log('[zju-webx][xzzd] 课程课件', uploads);
        extra += `；课程 ${courseId} 解析到 ${uploads.length} 个课件`;
      }
      setMsg(`线索：签名链 ${hints.signed.length}、activityId ${hints.activityIds.length}、uploadId ${hints.uploadIds.length}${extra}（详见控制台）`);
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
          setMsg('没解析到课件，试试「诊断」看控制台');
          return;
        }
        uploads.forEach((upload) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:3px 0;border-bottom:1px dashed #eef1f6';
          const label = document.createElement('span');
          label.textContent = upload.name;
          label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px';
          label.title = upload.name;
          const pick = document.createElement('button');
          pick.textContent = '下载';
          pick.style.cssText = 'border:0;border-radius:4px;background:#1d6fb8;color:#fff;padding:2px 8px;cursor:pointer;font-size:12px';
          pick.addEventListener('click', async () => {
            pick.disabled = true;
            setMsg(`下载 ${upload.name}…`);
            try {
              const signed = await signUrl(upload);
              const info = await saveSigned(signed, upload.name);
              setMsg(`已下载 ${info.name}${info.size > 0 ? `（${info.size} 字节）` : ''}`);
            } catch (e) {
              setMsg(`失败：${e.message || e}`);
            } finally {
              pick.disabled = false;
            }
          });
          row.appendChild(label);
          row.appendChild(pick);
          listBox.appendChild(row);
        });
        listBox.style.display = 'block';
        setMsg(`共 ${uploads.length} 个课件，点右侧「下载」`);
      } catch (e) {
        setMsg(`失败：${e.message || e}`);
      }
      return;
    }

    if (act === 'all') {
      button.disabled = true;
      try {
        const result = await downloadWholeCourse((i, total, name) => setMsg(`${i}/${total} ${name}`));
        setMsg(`完成：成功 ${result.ok.length}，失败 ${result.failed.length}`);
        if (result.failed.length) console.table(result.failed);
      } catch (e) {
        setMsg(`失败：${e.message || e}`);
      } finally {
        button.disabled = false;
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
    collectHints,
    resolveCurrent,
  };
}
