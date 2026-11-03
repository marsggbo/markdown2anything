(function () {
  'use strict';

  const targetNames = { wechat: '微信公众号', zhihu: '知乎', cnblogs: '博客园' };
  const stateNames = {
    pending: '等待中', preflighting: '检查中', acquiringAssets: '获取图片中', running: '处理中',
    readyForReview: '待审核', published: '已发布', unavailable: '不可用', failed: '失败',
    partial: '部分完成', completed: '已完成', cancelled: '已取消', discarded: '已丢弃',
  };
  let currentJobId = null;
  let preflightBinding = null;
  let cover = { kind: 'none' };

  function post(message) {
    const vscode = window.__m2a_vscode || (window.acquireVsCodeApi && window.acquireVsCodeApi());
    if (vscode && typeof vscode.postMessage === 'function') vscode.postMessage(message);
  }
  function byId(id) { return document.getElementById(id); }
  function selectedTargets() {
    return ['wechat', 'zhihu', 'cnblogs'].filter(target => byId(`publish-target-${target}`).checked);
  }
  function setText(id, text) { const element = byId(id); if (element) element.textContent = text; }
  function showStatus(text, kind) {
    const element = byId('publish-status');
    if (!element) return;
    element.textContent = text || '';
    element.dataset.kind = kind || '';
  }
  function resetAuto() {
    preflightBinding = null;
    const auto = byId('publish-auto');
    const confirm = byId('publish-confirm-auto');
    auto.checked = false;
    auto.disabled = true;
    confirm.disabled = true;
  }
  function options() {
    const topics = byId('publish-zhihu-topics').value.split(/\n|,/).map(value => value.trim()).filter(Boolean);
    const categories = byId('publish-cnblogs-categories').value.split(',').map(value => value.trim()).filter(Boolean);
    const tags = byId('publish-cnblogs-tags').value.split(',').map(value => value.trim()).filter(Boolean);
    return {
      wechat: { comments: { enabled: byId('publish-wechat-comments').checked } },
      zhihu: {
        topics,
        tableOfContents: byId('publish-zhihu-toc').checked,
        creationDeclaration: byId('publish-zhihu-declaration').checked ? 'original' : undefined,
      },
      cnblogs: { categories, tags, allowComments: byId('publish-cnblogs-comments').checked },
    };
  }
  function metadata() {
    return {
      title: byId('publish-title').value.trim(),
      author: byId('publish-author').value.trim(),
      digest: byId('publish-digest').value.trim(),
      cover,
    };
  }
  function request() {
    return { targets: selectedTargets(), mode: 'prepare', autoAcknowledged: false, metadata: metadata(), options: options() };
  }
  function clearList(id) { const element = byId(id); while (element && element.firstChild) element.removeChild(element.firstChild); return element; }
  function renderAssets(assets) {
    const list = clearList('publish-assets');
    (assets || []).filter(asset => asset.role !== 'cover').forEach((asset, index) => {
      const row = document.createElement('li');
      row.id = `publish-asset-${asset.assetId}`;
      row.textContent = `图片 ${index + 1}: ${stateNames[asset.acquisition] || asset.acquisition || '等待中'}`;
      list.appendChild(row);
    });
  }
  function setAssetProgress(assetId, state) {
    const row = byId(`publish-asset-${assetId}`);
    if (row) row.textContent = `${row.textContent.split(':')[0]}: ${stateNames[state] || state || '处理中'}`;
  }
  function renderTargets(targets, aggregate) {
    const list = clearList('publish-target-results');
    Object.keys(targets || {}).forEach(target => {
      const result = targets[target] || {};
      const row = document.createElement('li');
      row.textContent = `${targetNames[target] || target}: ${stateNames[result.state] || result.state || '等待中'}`;
      list.appendChild(row);
    });
    if (aggregate && aggregate.state === 'partial') showStatus('部分平台已完成，请检查失败项后重试。', 'partial');
  }
  function updateCapability(capabilities) {
    const list = clearList('publish-capabilities');
    const targets = selectedTargets();
    let autoReady = targets.length > 0;
    targets.forEach(target => {
      const capability = capabilities && capabilities[target] || {};
      const row = document.createElement('li');
      const available = capability.availability === 'available';
      row.textContent = `${targetNames[target]}: ${available ? '可准备' : (capability.reason || '不可用')}`;
      list.appendChild(row);
      autoReady = autoReady && available && capability.autoSupported === true;
    });
    const auto = byId('publish-auto');
    auto.disabled = !autoReady || !preflightBinding;
    if (auto.disabled) auto.checked = false;
    byId('publish-confirm-auto').disabled = !(autoReady && auto.checked && currentJobId && preflightBinding);
  }
  function openPanel() {
    const panel = byId('publish-panel');
    if (!panel) return;
    panel.classList.add('open');
    const title = byId('publish-title');
    if (title && !title.value && window.__m2a_current_title) title.value = window.__m2a_current_title;
  }
  function initialize() {
    const root = byId('publish-controls-root');
    if (!root) return;
    root.innerHTML = `
      <div class="publish-section">
        <p class="hint">默认只准备草稿。图片按文章中的顺序处理，并分别显示每个平台的结果。</p>
        <div class="publish-targets">
          <label><input id="publish-target-wechat" type="checkbox" checked> 微信公众号</label>
          <label><input id="publish-target-zhihu" type="checkbox" checked> 知乎</label>
          <label><input id="publish-target-cnblogs" type="checkbox" checked> 博客园</label>
        </div>
      </div>
      <div class="publish-section">
        <label>标题 <input id="publish-title" type="text" maxlength="4096"></label>
        <label>作者 <input id="publish-author" type="text" maxlength="4096"></label>
        <label>摘要 <textarea id="publish-digest" maxlength="4096"></textarea></label>
        <div class="panel-actions"><button class="btn btn-secondary" id="publish-choose-cover">选择封面文件</button><span id="publish-cover-label">未选择封面</span></div>
      </div>
      <details class="publish-section"><summary>平台选项</summary>
        <label><input id="publish-wechat-comments" type="checkbox"> 允许微信评论</label>
        <label>知乎话题（最多三个，每行一个）<textarea id="publish-zhihu-topics" placeholder="https://www.zhihu.com/topic/..."></textarea></label>
        <label><input id="publish-zhihu-toc" type="checkbox"> 知乎显示目录</label>
        <label><input id="publish-zhihu-declaration" type="checkbox"> 我确认内容为原创</label>
        <label>博客园分类（逗号分隔）<input id="publish-cnblogs-categories" type="text"></label>
        <label>博客园标签（逗号分隔）<input id="publish-cnblogs-tags" type="text"></label>
        <label><input id="publish-cnblogs-comments" type="checkbox"> 允许博客园评论</label>
      </details>
      <div class="publish-section">
        <div class="panel-actions"><button class="btn btn-primary" id="publish-preflight">最终检查</button><button class="btn btn-primary" id="publish-prepare">准备草稿</button></div>
        <label class="publish-auto-label"><input id="publish-auto" type="checkbox" disabled> 确认自动发布（完成最终检查后才可用）</label>
        <button class="btn btn-zhihu-publish" id="publish-confirm-auto" disabled>确认自动发布</button>
        <p id="publish-status" class="hint" role="status"></p>
      </div>
      <div class="publish-section"><strong>能力与回退</strong><ul id="publish-capabilities"></ul></div>
      <div class="publish-section"><strong>图片顺序与进度</strong><ol id="publish-assets"></ol></div>
      <div class="publish-section"><strong>发布结果</strong><ul id="publish-target-results"></ul></div>`;

    byId('publish-preflight').addEventListener('click', () => {
      const value = request();
      if (!value.targets.length) { showStatus('至少选择一个发布平台。', 'failed'); return; }
      resetAuto();
      showStatus('正在进行最终检查。');
      post({ type: 'publishPreflight', ...value });
    });
    byId('publish-prepare').addEventListener('click', () => {
      const value = request();
      if (!currentJobId) { showStatus('请先完成最终检查。', 'failed'); return; }
      showStatus('正在准备草稿。');
      post({ type: 'publishStart', ...value });
    });
    byId('publish-auto').addEventListener('change', () => {
      const auto = byId('publish-auto');
      byId('publish-confirm-auto').disabled = !(auto.checked && currentJobId && preflightBinding && !auto.disabled);
    });
    byId('publish-confirm-auto').addEventListener('click', () => {
      if (!currentJobId || !preflightBinding) return;
      post({ type: 'publishConfirmAuto', jobId: currentJobId, preflightBinding, autoAcknowledged: true });
    });
    byId('publish-choose-cover').addEventListener('click', () => post({ type: 'publishChooseCoverFile' }));
    ['wechat', 'zhihu', 'cnblogs'].forEach(target => byId(`publish-target-${target}`).addEventListener('change', resetAuto));
    document.querySelectorAll('[data-publish-launcher]').forEach(launcher => launcher.addEventListener('click', () => {
      if (window.closeAllDropdowns) window.closeAllDropdowns();
      openPanel();
    }));
    const close = byId('publish-panel-close');
    if (close) close.addEventListener('click', () => byId('publish-panel').classList.remove('open'));
  }

  window.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'publishPreflightResult') {
      currentJobId = message.jobId || null;
      preflightBinding = message.preflightBinding || null;
      renderAssets(message.assets);
      updateCapability(message.capabilities);
      showStatus('最终检查完成。请准备草稿。', 'review');
    } else if (message.type === 'publishProgress') {
      if (message.assetId) setAssetProgress(message.assetId, message.state);
      if (message.target) showStatus(`${targetNames[message.target] || message.target}: ${stateNames[message.state] || message.state}`);
    } else if (message.type === 'publishResult') {
      if (message.jobId) currentJobId = message.jobId;
      renderTargets(message.targets, message.aggregate);
      if (message.job && message.job.assets) renderAssets(message.job.assets);
      const state = message.aggregate && message.aggregate.state || message.job && message.job.status;
      if (state) showStatus(stateNames[state] || state, state);
    } else if (message.type === 'publishCoverFileResult') {
      if (message.selection) {
        cover = { kind: 'fileSelection', selectionId: message.selection.selectionId };
        setText('publish-cover-label', message.selection.label || '已选择封面');
      } else showStatus('未选择封面文件。');
    } else if (message.type === 'publishError') {
      resetAuto();
      showStatus(`发布操作失败：${message.code || 'INVALID_PUBLISH_REQUEST'}`, 'failed');
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
}());
