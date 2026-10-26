/**
 * 学在浙大（courses.zju.edu.cn）课件下载修复
 *
 * 背景：平台对「只有查看权限」的课件，下载型接口（/api/uploads/{id}/blob、
 * /api/uploads/reference/{rid}/blob）会返回 HTTP 200 + {"message":"您没有权限完成此操作"}。
 * 旧流程只看 xhr.status == 200 就落盘，于是把这段 75 字节的 JSON 存成了 .pdf。
 *
 * 修复思路：不走下载鉴权，改走平台自己的预览签名链
 *   1) GET /api/courses/{cid}/activities                                  -> activities[].uploads[]
 *   2) GET /api/uploads/reference/document/{rid}/url?preview=true         -> { url }
 *      （兜底 /api/uploads/document/{id}/url?preview=true）
 *   3) GET { url }（timestamp + token 自带鉴权）                           -> 文件字节
 * 并在落盘前强校验 res.ok 与 Content-Type，JSON 一律视为失败。
 */

const API = 'https://courses.zju.edu.cn/api';
const LOG = (...args) => console.log('[zju-webx][xzzd]', ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** 取预览签名链：reference_id 优先，其次 upload id */
async function signUrl(upload) {
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
      if (json && json.url) return json.url;
      lastErr = new Error(`${url} -> ${JSON.stringify(json).slice(0, 160)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('没有可用的签名接口');
}

function nameFromSigned(signedUrl, fallback) {
  try {
    const name = new URL(signedUrl).searchParams.get('name');
    if (name) return decodeURIComponent(name);
  } catch (e) { /* ignore */ }
  return fallback || 'courseware.pdf';
}

/** 落盘前校验状态码与 Content-Type，绝不把 JSON 当文件存 */
async function saveSigned(signedUrl, fallbackName) {
  const res = await fetch(signedUrl, { credentials: 'include' });
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok || contentType.includes('json')) {
    const body = await res.text();
    throw new Error(`取文件被拒 ${res.status} ${contentType} :: ${body.slice(0, 160)}`);
  }
  const blob = await res.blob();
  let name = nameFromSigned(signedUrl, fallbackName);
  // processed/*.pdf 是平台转码后的预览件，原始 Office 文件拿到的就是 PDF
  if (contentType.includes('pdf') && !/\.pdf$/i.test(name)) name += '.pdf';

  const anchor = document.createElement('a');
  const href = URL.createObjectURL(blob);
  anchor.href = href;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60000);
  return { name, size: blob.size, type: contentType };
}

/** 从预览页 URL / iframe#pdf-viewer 的 src 里找出当前课件的签名链或 upload_id */
function currentViewerTarget() {
  const hrefs = [location.href];
  document.querySelectorAll('#pdf-viewer, iframe').forEach((frame) => {
    const src = frame.getAttribute('src');
    if (src) hrefs.push(src);
  });
  for (const raw of hrefs) {
    let url;
    try {
      url = new URL(raw, location.href);
    } catch (e) {
      continue;
    }
    const file = url.searchParams.get('file');
    const uploadId = url.searchParams.get('upload_id') || url.searchParams.get('uploadId');
    if (file && /^https?:\/\//i.test(file)) return { kind: 'signed', url: file };
    if (uploadId) return { kind: 'upload', id: uploadId };
    const inline = decodeURIComponent(url.href).match(/https?:\/\/tcmedia\.zju\.edu\.cn\/\S+?(?=["'\s&]|$)/);
    if (inline) return { kind: 'signed', url: inline[0] };
  }
  return null;
}

async function downloadCurrentCourseware() {
  const target = currentViewerTarget();
  if (!target) throw new Error('当前页面没有课件预览信息（先点开一个课件）');
  if (target.kind === 'signed') return saveSigned(target.url, 'courseware.pdf');
  const signed = await signUrl({ id: target.id });
  return saveSigned(signed, 'courseware.pdf');
}

function currentCourseId() {
  const matched = location.pathname.match(/\/course\/(\d+)/);
  return matched ? matched[1] : null;
}

async function listCourseUploads(courseId) {
  const data = await jget(`${API}/courses/${courseId}/activities`);
  const uploads = [];
  const seen = new Set();
  (data.activities || []).forEach((activity) => {
    (activity.uploads || []).forEach((upload) => {
      const key = upload.reference_id || upload.id;
      if (!key || seen.has(key)) return;
      seen.add(key);
      uploads.push(upload);
    });
  });
  return uploads;
}

async function downloadWholeCourse(onProgress) {
  const courseId = currentCourseId();
  if (!courseId) throw new Error('当前不在课程页（URL 需包含 /course/<id>）');
  const uploads = await listCourseUploads(courseId);
  LOG(`课程 ${courseId}：发现 ${uploads.length} 个课件`);
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

function mountPanel() {
  if (!/^courses\.zju\.edu\.cn$/i.test(location.hostname)) return;
  if (document.getElementById('zju-webx-xzzd-panel')) return;

  const box = document.createElement('div');
  box.id = 'zju-webx-xzzd-panel';
  box.style.cssText = [
    'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
    'background:#fff', 'border:1px solid #003f88', 'border-radius:10px',
    'box-shadow:0 6px 24px rgba(0,0,0,.18)', 'padding:10px 12px',
    'font:13px/1.5 -apple-system,"Microsoft YaHei",sans-serif', 'color:#0b2545',
    'min-width:190px', 'user-select:none',
  ].join(';');
  box.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px;color:#003f88">学在浙大课件下载</div>
    <button id="zju-webx-xzzd-cur" style="width:100%;margin:3px 0;padding:6px;border:0;border-radius:6px;background:#003f88;color:#fff;cursor:pointer">下载当前课件</button>
    <button id="zju-webx-xzzd-all" style="width:100%;margin:3px 0;padding:6px;border:0;border-radius:6px;background:#1d6fb8;color:#fff;cursor:pointer">下载本课程全部</button>
    <div id="zju-webx-xzzd-msg" style="margin-top:6px;color:#555;max-width:260px;word-break:break-all"></div>
  `;
  document.body.appendChild(box);

  const msg = box.querySelector('#zju-webx-xzzd-msg');
  const setMsg = (text) => { msg.textContent = text; };

  box.querySelector('#zju-webx-xzzd-cur').addEventListener('click', async () => {
    setMsg('处理中…');
    try {
      const info = await downloadCurrentCourseware();
      setMsg(`已下载 ${info.name}（${info.size} 字节）`);
    } catch (e) {
      setMsg(`失败：${e.message || e}`);
    }
  });

  box.querySelector('#zju-webx-xzzd-all').addEventListener('click', async (event) => {
    const button = event.currentTarget;
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
    signUrl,
    saveSigned,
  };
}
