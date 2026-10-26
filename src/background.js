chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === "getPPTUrl") {
    chrome.storage.sync.get(["pptUrl"], function(result) {
      sendResponse({ pptUrl: result.pptUrl });
    });
    // 需要返回 true，表示异步响应
    return true;
  }
  else if (request.action === 'setShowDiv') {
    chrome.storage.sync.set({ showDiv: request.value }, () => {
      console.log(`设置 showDiv 为: ${request.value}`);
    });
    sendResponse({ status: 'success' });
  }
  else if (request.action === 'xzzdGetSigned') {
    return false; // 交给下面 xzzd 嗅探监听器处理
  }
  else if (request && request.data){
    let data = request.data;
    showDataOnPage(data.title, data.message, data.closeTime, data.url);
    sendResponse("已执行弹窗");
  }
});


// 将data数据以桌面通知的方式显示给用户
function showDataOnPage(title, data, closeTime = 3000, url = "") {
  if (chrome.notifications) {
    let opt = {
      type: "basic",
      title: title,
      message: data,
      iconUrl: chrome.runtime.getURL("icon.png"),
    };

    chrome.notifications.create("", opt, function (id) {
      // 定义点击通知的回调函数
      function onClicked(notificationId) {
        console.log("click notification", url);
        if (url) {
          console.log("open url", url);
          chrome.tabs.create({ url: url });
        }
        // 清除通知
        chrome.notifications.clear(notificationId, function () { });
      }

      // 注册监听器
      chrome.notifications.onClicked.addListener(onClicked);

      // 设置定时器，在指定时间后清除通知
      setTimeout(function () {
        chrome.notifications.clear(id, function () { });
        // 移除监听器
        chrome.notifications.onClicked.removeListener(onClicked);
      }, closeTime);
    });
  } else {
    console.error("chrome.notifications is not available");
  }
}


chrome.webRequest.onCompleted.addListener(
  function(details) {
    // 检查请求的 URL 是否匹配目标 API
    if (details.url.includes('/api/uploads/reference/document/')) {
      // 通过 fetch 重新发起请求获取响应数据
      fetch(details.url)
        .then(response => response.json())
        .then(data => {
          // 假设返回的数据包含目标 PPT 下载 URL
          if (data && data.url) {
            // 存储 URL 到 chrome.storage
            chrome.storage.sync.set({ pptUrl: data.url }, () => {
              console.log('PPT URL 已存储:', data.url);
            });
          }
          else{
            console.log('fail to save pptUrl');
          }
        })
        .catch(error => console.error('获取数据失败:', error));
    }
  },
  { urls: ["https://courses.zju.edu.cn/api/uploads/reference/document/*/url"] },
);
// ===== 学在浙大（xzzd）预览链接嗅探 =====
// WPS/pdf.js 预览常常在跨域 iframe 里渲染，内容脚本读不到 src；
// 但浏览器实际请求过 tcmedia 的签名下载链——在后台按标签页记下来，内容脚本随时来取。
const XZZD_SIGNED = new Map(); // tabId -> [url...]

function rememberXzzdSigned(tabId, url) {
  if (!url || tabId === undefined || tabId < 0) return;
  const list = (XZZD_SIGNED.get(tabId) || []).filter((item) => item !== url);
  list.unshift(url);
  const kept = list.slice(0, 12);
  XZZD_SIGNED.set(tabId, kept);
  try {
    chrome.storage.local.set({ ["xzzd:signed:" + tabId]: kept });
  } catch (e) { /* ignore */ }
}

chrome.webRequest.onBeforeRequest.addListener(
  function (details) {
    if (/tcmedia\.zju\.edu\.cn\/download\//i.test(details.url)
      || /\/api\/uploads\/(reference\/)?(document|image|audio)\/[^/]+\/url/i.test(details.url)) {
      rememberXzzdSigned(details.tabId, details.url);
    }
  },
  { urls: ["https://tcmedia.zju.edu.cn/*", "http://tcmedia.zju.edu.cn/*", "https://courses.zju.edu.cn/api/uploads/*"] }
);

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request && request.action === "xzzdGetSigned") {
    const tabId = sender && sender.tab ? sender.tab.id : -1;
    const stored = tabId >= 0 ? XZZD_SIGNED.get(tabId) || [] : [];
    chrome.storage.local.get(["xzzd:signed:" + tabId], function (result) {
      const disk = result["xzzd:signed:" + tabId] || [];
      const merged = [];
      [...stored, ...disk].forEach(function (url) {
        if (url && merged.indexOf(url) === -1) merged.push(url);
      });
      sendResponse({ urls: merged, tabId: tabId });
    });
    return true;
  }
  return false;
});

// 监听插件安装时初始化设置
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ showDiv: true }, () => {
    console.log("插件初始化：显示 div");
  });
});

// 监听特定 URL 的请求
chrome.webRequest.onHeadersReceived.addListener(
  function (details) {
    console.log("响应头捕获：", details);

    // 提取状态码
    const statusCode = details.statusCode;
    console.log("状态码：", statusCode);

    // 检查状态码是否为403或404
    if (statusCode === 403 || statusCode === 404) {
      console.log(`${statusCode}状态码检测到，准备重载页面`);

      // 重载当前活动标签页
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs.length > 0) {
          console.log("重载标签页：", tabs[0].id);
          chrome.tabs.reload(tabs[0].id); // 重载页面
        } else {
          console.error("未找到活动标签页");
        }
      });
    }
  },
  { urls: ["https://api.cc98.org/topic/*"] }, // 监听特定 URL
  ["responseHeaders"] // 需要获取响应头
);