(function () {
  'use strict';

  const targetNames = { wechat: '微信公众号', zhihu: '知乎', cnblogs: '博客园' };
  const credentialNames = {
    'publishing.wechat.appSecret': '微信公众号凭证',
    'publishing.zhihu.browserCookies': '知乎登录状态',
    'publishing.cnblogs.username': '博客园用户名',
    'publishing.cnblogs.token': '博客园访问令牌',
  };
  const stateNames = {
    pending: '等待中', preflighting: '检查中', acquiringAssets: '获取图片中', running: '处理中',
    readyForReview: '待审核', published: '已发布', unavailable: '不可用', failed: '失败',
    partial: '部分完成', completed: '已完成', cancelled: '已取消', discarded: '已丢弃', needsAttention: '需要处理',
  };
  let currentJobId = null;
  let preflightBinding = null;
  let cover = { kind: 'none' };
  let optionSupport = { wechat: ['comments'], zhihu: [], cnblogs: [] };

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
  function optionEnabled(target, field) { return Array.isArray(optionSupport[target]) && optionSupport[target].includes(field); }
  function options() {
    const result = { wechat: {}, zhihu: {}, cnblogs: {} };
    const topics = byId('publish-zhihu-topics').value.split(/\n|,/).map(value => value.trim()).filter(Boolean);
    const categories = byId('publish-cnblogs-categories').value.split(',').map(value => value.trim()).filter(Boolean);
    const tags = byId('publish-cnblogs-tags').value.split(',').map(value => value.trim()).filter(Boolean);
    if (optionEnabled('wechat', 'comments')) result.wechat.comments = { enabled: byId('publish-wechat-comments').checked };
    if (optionEnabled('wechat', 'original') && byId('publish-wechat-original').checked) result.wechat.original = { kind: 'original' };
    if (optionEnabled('wechat', 'repost') && byId('publish-wechat-repost').checked) result.wechat.repost = { kind: 'repost' };
    if (optionEnabled('zhihu', 'commentPermission')) result.zhihu.commentPermission = byId('publish-zhihu-comment-permission').value;
    if (optionEnabled('zhihu', 'topics') && topics.length) result.zhihu.topics = topics;
    if (optionEnabled('zhihu', 'tableOfContents')) result.zhihu.tableOfContents = byId('publish-zhihu-toc').checked;
    if (optionEnabled('zhihu', 'creationDeclaration') && byId('publish-zhihu-declaration').value) result.zhihu.creationDeclaration = byId('publish-zhihu-declaration').value;
    if (optionEnabled('cnblogs', 'categories') && categories.length) result.cnblogs.categories = categories;
    if (optionEnabled('cnblogs', 'tags') && tags.length) result.cnblogs.tags = tags;
    if (optionEnabled('cnblogs', 'allowComments')) result.cnblogs.allowComments = byId('publish-cnblogs-comments').checked;
    return result;
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
    const targets = selectedTargets();
    const allOptions = options();
    return { targets, mode: 'prepare', autoAcknowledged: false, metadata: metadata(), options: Object.fromEntries(targets.map(target => [target, allOptions[target]])) };
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
    if (aggregate && (aggregate.state === 'partial' || aggregate.summary === 'partialRetryable')) showStatus('部分平台已完成，请检查失败项后重试。', 'partial');
  }
  function updateOptionControls(capabilities) {
    const controls = [
      ['wechat', 'comments', ['publish-wechat-comments']],
      ['wechat', 'original', ['publish-wechat-original']],
      ['wechat', 'repost', ['publish-wechat-repost']],
      ['zhihu', 'commentPermission', ['publish-zhihu-comment-permission']],
      ['zhihu', 'topics', ['publish-zhihu-topics']],
      ['zhihu', 'tableOfContents', ['publish-zhihu-toc']],
      ['zhihu', 'creationDeclaration', ['publish-zhihu-declaration']],
      ['cnblogs', 'categories', ['publish-cnblogs-categories']],
      ['cnblogs', 'tags', ['publish-cnblogs-tags']],
      ['cnblogs', 'allowComments', ['publish-cnblogs-comments']],
    ];
    ['wechat', 'zhihu', 'cnblogs'].forEach(target => {
      const capability = capabilities && capabilities[target] || {};
      optionSupport[target] = Array.isArray(capability.supportedOptions) ? capability.supportedOptions.slice() : [];
    });
    controls.forEach(([target, field, ids]) => {
      const supported = optionEnabled(target, field);
      ids.forEach(id => { const element = byId(id); if (element) element.disabled = !supported; });
      const note = byId(`publish-option-${target}-${field}-status`);
      if (note) note.textContent = supported ? '' : '（不支持/待配置）';
    });
  }
  function updateCapability(capabilities) {
    updateOptionControls(capabilities);
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
  function requestCredential(slot, type) {
    showStatus(`正在设置${credentialNames[slot] || '发布凭证'}。`);
    post({ type, slot });
  }
  function savePublishConfig() {
    post({
      type: 'publishSaveConfig',
      config: {
        appid: byId('publish-wechat-appid').value.trim(),
        cnblogsBlogId: byId('publish-cnblogs-blog-id').value.trim(),
        cnblogsBlogSlug: byId('publish-cnblogs-blog-slug').value.trim(),
      },
    });
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
      <details class="publish-section"><summary>账号与凭证</summary>
        <label>微信公众号 AppID <input id="publish-wechat-appid" type="text" maxlength="256"></label>
        <label>博客园博客 ID <input id="publish-cnblogs-blog-id" type="text" maxlength="256"></label>
        <label>博客园博客 slug <input id="publish-cnblogs-blog-slug" type="text" maxlength="256"></label>
        <div class="panel-actions"><button class="btn btn-secondary" id="publish-save-config">保存账号配置</button></div>
        <div class="panel-actions"><button class="btn btn-secondary" id="publish-set-wechat-secret">设置公众号 AppSecret</button></div>
        <div class="panel-actions"><button class="btn btn-secondary" id="publish-login-zhihu">登录知乎</button></div>
        <div class="panel-actions"><button class="btn btn-secondary" id="publish-set-cnblogs-username">设置博客园用户名</button><button class="btn btn-secondary" id="publish-set-cnblogs-token">设置博客园令牌</button></div>
        <p class="hint" id="publish-credential-status">凭证仅在主机安全存储中输入和保存。</p>
      </details>
      <details class="publish-section"><summary>平台选项</summary>
        <label> <input id="publish-wechat-comments" type="checkbox"> 允许微信评论 <span id="publish-option-wechat-comments-status"></span></label>
        <label><input id="publish-wechat-original" type="checkbox" disabled> 微信原创标记 <span id="publish-option-wechat-original-status">（不支持/待配置）</span></label>
        <label><input id="publish-wechat-repost" type="checkbox" disabled> 微信转载标记 <span id="publish-option-wechat-repost-status">（不支持/待配置）</span></label>
        <label>知乎评论权限 <select id="publish-zhihu-comment-permission" disabled><option value="all">任何人都可以评论</option><option value="nobody">不允许评论</option><option value="followee">我关注的人能评论</option><option value="censor">仅显示我筛选后的评论</option><option value="follower">关注我的人能评论</option></select> <span id="publish-option-zhihu-commentPermission-status">（不支持/待配置）</span></label>
        <label>知乎话题（最多三个，每行一个）<textarea id="publish-zhihu-topics" placeholder="https://www.zhihu.com/topic/..." disabled></textarea> <span id="publish-option-zhihu-topics-status">（不支持/待配置）</span></label>
        <label><input id="publish-zhihu-toc" type="checkbox" disabled> 知乎显示目录 <span id="publish-option-zhihu-tableOfContents-status">（不支持/待配置）</span></label>
        <label>知乎创作声明 <select id="publish-zhihu-declaration" disabled><option value="">不设置</option><option value="spoiler">包含剧透</option><option value="medical_advice">包含医疗建议</option><option value="fictional_creation">虚构创作</option><option value="contain_finance">包含理财内容</option><option value="ai_creation">包含 AI 辅助创作，作者对内容负责</option></select> <span id="publish-option-zhihu-creationDeclaration-status">（不支持/待配置）</span></label>
        <label>博客园分类（逗号分隔）<input id="publish-cnblogs-categories" type="text" disabled> <span id="publish-option-cnblogs-categories-status">（不支持/待配置）</span></label>
        <label>博客园标签（逗号分隔）<input id="publish-cnblogs-tags" type="text" disabled> <span id="publish-option-cnblogs-tags-status">（不支持/待配置）</span></label>
        <label><input id="publish-cnblogs-comments" type="checkbox" disabled> 允许博客园评论 <span id="publish-option-cnblogs-allowComments-status">（不支持/待配置）</span></label>
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
    byId('publish-save-config').addEventListener('click', savePublishConfig);
    byId('publish-set-wechat-secret').addEventListener('click', () => requestCredential('publishing.wechat.appSecret', 'publishRequestCredentialEntry'));
    byId('publish-login-zhihu').addEventListener('click', () => requestCredential('publishing.zhihu.browserCookies', 'publishBeginBrowserLogin'));
    byId('publish-set-cnblogs-username').addEventListener('click', () => requestCredential('publishing.cnblogs.username', 'publishRequestCredentialEntry'));
    byId('publish-set-cnblogs-token').addEventListener('click', () => requestCredential('publishing.cnblogs.token', 'publishRequestCredentialEntry'));
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
      const state = message.aggregate && (message.aggregate.state || (message.aggregate.summary === 'partialRetryable' ? 'partial' : message.aggregate.status)) || message.job && message.job.status;
      if (state) showStatus(stateNames[state] || state, state);
    } else if (message.type === 'publishCoverFileResult') {
      if (message.selection) {
        cover = { kind: 'fileSelection', selectionId: message.selection.selectionId };
        setText('publish-cover-label', message.selection.label || '已选择封面');
      } else showStatus('未选择封面文件。');
    } else if (message.type === 'publishCredentialResult') {
      setText('publish-credential-status', message.cleared ? '凭证已从安全存储中移除。' : message.available ? `${credentialNames[message.slot] || '发布凭证'}已保存到安全存储。` : '未保存凭证。');
    } else if (message.type === 'publishError') {
      resetAuto();
      showStatus(`发布操作失败：${message.code || 'INVALID_PUBLISH_REQUEST'}`, 'failed');
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
}());
