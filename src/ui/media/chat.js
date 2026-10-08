/**
 * nota 学习助手 webview 前端逻辑（原生 JS，无框架，风格参照 media/pdf/viewer.js）。
 *
 * 单页承载两个视图：?view=session（会话列表）| ?view=chat（对话面板）。
 * 与扩展侧通过 acquireVsCodeApi().postMessage 通信，协议见 src/ui/protocol.ts：
 * - 收：init / conversation / delta / finalize / toolLifecycle / error /
 *       confirmRequest / confirmResolved / noteSaved / pageText / attachmentPicked
 * - 发：newConversation / send / abort / openConversation / deleteConversation /
 *       renameConversation / setMode / setModel / toggleSkill / confirmWorkspace /
 *       retry / pickAttachment（requestPageText / openNote / saveAsNote 由 Task 7/9 接线）
 *
 * 流式渲染约定：
 * - delta 的文本/推理增量一律以纯文本节点追加（天然防注入）；
 * - finalize.html 为扩展侧渲染好的 markdown HTML，直接整体替换该消息 DOM（信任扩展侧）；
 * - 流式去重：按 conversationId + 本地轮次序号定位，每轮只建一条 assistant 气泡/推理块。
 */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  /* ---------------- 全局状态 ---------------- */
  var state = {
    view: 'session',
    sessions: [],            // ConversationMeta[]
    models: [],
    skills: [],              // {id, displayName, description, defaultOn, icon?}
    webSearchAvailable: false,  // init 前按不可用兜底（所有 defaultSkillIds 调用点均在 init 之后）
    workspaceWriteEnabled: false,
    convId: null,            // 当前打开的会话 id
    convTitle: '',
    mode: 'chat',            // 当前会话模式
    activeSkills: [],        // 当前会话已启用的 skill id
    streaming: false,        // 流式进行中标志（发送按钮变「停止」）
    assistantEl: null,       // 当前流式 assistant 气泡（本轮唯一，防重复插入）
    reasoningEl: null,       // 当前流式推理折叠块
    lastFullText: '',        // 本轮流式累积的完整原文（finalize 生成为笔记用；勿依赖 store）
    turnSeq: 0,              // 本地轮次序号（流式去重 key 的一部分）
    toolCards: {},           // callId -> {card, statusEl, resultEl}
    pendingAttachments: [],  // 待发送附件队列
    pendingModel: ''         // 新对话默认模型
  };

  var MODE_CN = { chat: '对话', research: '研究', quiz: '出题' };
  var MODE_ICON = { chat: '💬', research: '🔎', quiz: '🎯' };

  /* ---------------- 工具函数 ---------------- */

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function post(msg) { vscode.postMessage(msg); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatTime(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var now = new Date();
    if (d.getFullYear() === now.getFullYear()) {
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
    }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
  }

  /**
   * 与 Task 3 defaultSkillIds 对齐，但 research 默认值 web 感知（与控制器 defaultSkillsFor 语义一致）：
   * web 可用 → ['search']；不可用 → []（避免「search 启用但 web_search 未注册」作为默认态）。
   * 调用点（onNewConversation/模式 tab）均为 init 之后用户交互，state.webSearchAvailable 已就绪；
   * 初始值兜底为 false（不可用），见 state 定义。
   */
  function defaultSkillIds(mode) {
    if (mode === 'research') return state.webSearchAvailable ? ['search'] : [];
    if (mode === 'quiz') return ['quiz'];
    return state.skills.filter(function (s) { return s.defaultOn; }).map(function (s) { return s.id; });
  }

  function switchView(v) {
    state.view = v;
    $('session-view').classList.toggle('hidden', v !== 'session');
    $('chat-view').classList.toggle('hidden', v !== 'chat');
    updateWebSearchBanner();
  }

  /* ---------------- 会话列表视图 ---------------- */

  function renderSessions() {
    var list = $('session-list');
    list.innerHTML = '';
    var metas = state.sessions.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    metas.forEach(function (m) {
      var li = el('li', 'session-item');
      li.setAttribute('data-id', m.id);

      var main = el('div', 'session-main');
      var title = el('div', 'session-title', m.title || '未命名会话');
      var meta = el('div', 'session-meta');
      meta.appendChild(el('span', 'badge', (MODE_ICON[m.mode] || '') + (MODE_CN[m.mode] || m.mode)));
      meta.appendChild(el('span', 'session-time', formatTime(m.updatedAt) + ' · ' + (m.messageCount || 0) + ' 条'));
      main.appendChild(title);
      main.appendChild(meta);

      var actions = el('div', 'session-actions');
      var renameBtn = el('button', '', '重命名');
      renameBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        startRename(li, m);
      });
      var delBtn = el('button', 'danger', '删除');
      delBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        post({ type: 'deleteConversation', id: m.id });
        state.sessions = state.sessions.filter(function (s) { return s.id !== m.id; });
        renderSessions();
      });
      actions.appendChild(renameBtn);
      actions.appendChild(delBtn);

      li.appendChild(main);
      li.appendChild(actions);
      li.addEventListener('click', function () {
        post({ type: 'openConversation', id: m.id });
      });
      list.appendChild(li);
    });
    $('session-empty').classList.toggle('hidden', metas.length > 0);
  }

  /** 行内重命名：标题替换为输入框，Enter/失焦提交，Esc 取消 */
  function startRename(li, m) {
    var titleEl = li.querySelector('.session-title');
    if (!titleEl || li.querySelector('.rename-input')) return;
    var input = document.createElement('input');
    input.className = 'rename-input';
    input.value = m.title || '';
    input.style.cssText = 'flex:1;font-size:13px;padding:2px 6px;background:var(--vscode-input-background);'
      + 'color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,.35));border-radius:3px;';
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    var done = false;
    function commit() {
      if (done) return;
      done = true;
      var t = (input.value || '').trim();
      if (t && t !== m.title) {
        post({ type: 'renameConversation', id: m.id, title: t });
        m.title = t;
      }
      renderSessions();
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { done = true; renderSessions(); }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  function openModeModal() { $('mode-modal').classList.remove('hidden'); }
  function closeModeModal() { $('mode-modal').classList.add('hidden'); }

  function onNewConversation(mode) {
    closeModeModal();
    state.pendingModel = state.pendingModel || (state.models[0] || '');
    post({
      type: 'newConversation',
      mode: mode,
      model: state.pendingModel,
      skillIds: defaultSkillIds(mode)
    });
  }

  /* ---------------- 对话面板视图 ---------------- */

  function setModeTabs(mode) {
    var tabs = document.querySelectorAll('#mode-tabs .mode-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-mode') === mode);
    }
  }

  function populateModelSelect() {
    var sel = $('model-select');
    sel.innerHTML = '';
    state.models.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    });
    var current = state.convId ? getConvModel() : (state.pendingModel || state.models[0] || '');
    if (current && state.models.indexOf(current) >= 0) {
      sel.value = current;
    }
  }

  function getConvModel() {
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === state.convId) return state.sessions[i].model || '';
    }
    return '';
  }

  function renderSkillChips() {
    var wrap = $('skill-chips');
    wrap.innerHTML = '';
    state.skills.forEach(function (s) {
      var chip = el('button', 'skill-chip' + (state.activeSkills.indexOf(s.id) >= 0 ? ' active' : ''));
      chip.setAttribute('data-skill', s.id);
      chip.title = s.description || '';
      chip.textContent = (s.icon ? s.icon + ' ' : '') + s.displayName;
      if (!state.webSearchAvailable && s.id === 'search') {
        var searchEnabled = state.activeSkills.indexOf(s.id) >= 0;
        /* web 不可用时禁止开启（disabled），但已启用的允许点击关闭——
         * 避免「store 启用但工具未注册」后回显 active+disabled 且无法移除 */
        if (!searchEnabled) chip.disabled = true;
        chip.title = (s.description || '') + '（web_search 不可用）';
      }
      chip.addEventListener('click', function () {
        if (chip.disabled || !state.convId) return;
        var idx = state.activeSkills.indexOf(s.id);
        if (idx >= 0) state.activeSkills.splice(idx, 1);
        else state.activeSkills.push(s.id);
        chip.classList.toggle('active', idx < 0);
        post({ type: 'toggleSkill', conversationId: state.convId, skillId: s.id });
      });
      wrap.appendChild(chip);
    });
  }

  function clearStreaming() {
    state.streaming = false;
    state.assistantEl = null;
    state.reasoningEl = null;
    state.lastFullText = '';
    state.toolCards = {};
    $('send-btn').textContent = '发送';
  }

  /** 输入区上方提示条：web 搜索不可用且当前会话为 research 时显示「未配置网页搜索，仅本地检索」 */
  function updateWebSearchBanner() {
    var banner = $('websearch-banner');
    if (!banner) return;
    var show = !state.webSearchAvailable && state.mode === 'research';
    banner.classList.toggle('hidden', !show);
  }

  function scrollBottom() {
    var box = $('messages');
    box.scrollTop = box.scrollHeight;
  }

  function removeEmptyHint() {
    var empty = $('chat-empty');
    if (empty) empty.remove();
  }

  /* ---- 消息元素构造 ---- */

  function addUserMsg(text, attachments) {
    removeEmptyHint();
    var div = el('div', 'msg-user');
    if (text) div.appendChild(document.createTextNode(text));
    (attachments || []).forEach(function (a) {
      var icon = a.kind === 'image' ? '🖼 ' : (a.kind === 'pdfPage' ? '📄 ' : '📎 ');
      div.appendChild(el('span', 'attach-tag', icon + (a.name || a.kind)));
    });
    $('messages').appendChild(div);
    scrollBottom();
  }

  function addAssistantStreaming() {
    removeEmptyHint();
    state.turnSeq += 1;
    var div = el('div', 'msg-assistant streaming');
    div.setAttribute('data-key', state.convId + ':' + state.turnSeq);
    var span = el('span', 'stream-text', '');
    div.appendChild(span);
    div.appendChild(el('span', 'cursor', ''));
    $('messages').appendChild(div);
    scrollBottom();
    return div;
  }

  function addReasoningBlock() {
    removeEmptyHint();
    var det = el('details', 'msg-reasoning');
    var sum = el('summary', '', '💭 思考过程');
    var body = el('div', 'reasoning-body', '');
    det.appendChild(sum);
    det.appendChild(body);
    $('messages').appendChild(det);
    scrollBottom();
    return det;
  }

  function addToolCard(callId, name, status, result) {
    removeEmptyHint();
    var card = el('div', 'msg-tool');
    card.setAttribute('data-call', callId);

    var header = el('div', 'tool-header');
    var statusEl = el('span', 'tool-status ' + status,
      status === 'running' ? '⏳' : (status === 'done' ? '✅' : '❌'));
    var nameEl = el('span', 'tool-name', '🔧 ' + (name || 'tool'));
    header.appendChild(statusEl);
    header.appendChild(nameEl);
    card.appendChild(header);

    var resultEl = null;
    if (result != null && status !== 'running') {
      var toggle = el('button', 'tool-toggle', '展开');
      resultEl = el('div', 'tool-result', String(result));
      toggle.addEventListener('click', function () {
        var exp = resultEl.classList.toggle('expanded');
        toggle.textContent = exp ? '收起' : '展开';
      });
      header.appendChild(toggle);
      card.appendChild(resultEl);
    }

    $('messages').appendChild(card);
    scrollBottom();
    return { card: card, statusEl: statusEl, resultEl: resultEl };
  }

  function addErrorMsg(kind, message, retryable) {
    removeEmptyHint();
    var div = el('div', 'msg-error');
    div.appendChild(el('span', 'error-text', '⚠ ' + message + (kind ? '（' + kind + '）' : '')));
    if (retryable) {
      var retry = el('button', '', '重试');
      retry.addEventListener('click', function () {
        if (!state.convId) return;
        post({ type: 'retry', conversationId: state.convId });
        div.remove();
      });
      div.appendChild(retry);
    }
    var cfg = el('button', '', '去配置');
    cfg.addEventListener('click', function () {
      post({ type: 'openSettings' });
      div.remove();
    });
    div.appendChild(cfg);
    $('messages').appendChild(div);
    scrollBottom();
  }

  /** noteSaved 通知：提示 + [打开笔记] 按钮（post openNote 由扩展侧打开文档） */
  function addNoteSavedNotice(prefix, path) {
    removeEmptyHint();
    var div = el('div', 'msg-notice');
    div.appendChild(document.createTextNode(prefix + path));
    var open = el('button', 'notice-open', '打开笔记');
    open.addEventListener('click', function () {
      post({ type: 'openNote', path: path });
    });
    div.appendChild(open);
    $('messages').appendChild(div);
    scrollBottom();
  }

  /** finalize 消息块 footer：[生成为笔记]——仅当该条消息含 http(s):// 链接时显示 */
  function maybeAddSaveNoteFooter(container, text) {
    if (!text || !/https?:\/\//i.test(text)) return;
    var footer = el('div', 'msg-footer');
    var btn = el('button', '', '生成为笔记');
    btn.title = '将该条回复保存为笔记（有来源时写入来源笔记，否则写入 Inbox）';
    btn.addEventListener('click', function () {
      if (!state.convId) return;
      post({ type: 'saveAsNote', conversationId: state.convId, text: text });
    });
    footer.appendChild(btn);
    container.appendChild(footer);
  }

  /* ---- 工作区写确认卡 ---- */

  function buildDiff(proposal) {
    var wrap = el('div', 'diff-wrap hidden');
    var cur = el('div', 'diff-col');
    cur.appendChild(el('div', 'diff-title', '当前内容'));
    var curPre = document.createElement('pre');
    curPre.textContent = proposal.currentContent == null ? '' : String(proposal.currentContent);
    cur.appendChild(curPre);
    var neo = el('div', 'diff-col');
    neo.appendChild(el('div', 'diff-title', '新内容'));
    var neoPre = document.createElement('pre');
    neoPre.textContent = proposal.newContent == null ? '' : String(proposal.newContent);
    neo.appendChild(neoPre);
    wrap.appendChild(cur);
    wrap.appendChild(neo);
    return wrap;
  }

  function addConfirmCard(proposal) {
    removeEmptyHint();
    state.proposal = proposal;
    var card = el('div', 'confirm-card');

    card.appendChild(el('div', 'confirm-summary', '📝 ' + (proposal.summary || '请求写入工作区文件')));
    card.appendChild(el('div', 'confirm-path', proposal.path || ''));

    var actions = el('div', 'confirm-actions');
    var applyBtn = el('button', 'apply', '应用');
    var rejectBtn = el('button', 'reject', '拒绝');
    var diffBtn = el('button', 'reject', '查看 Diff');
    var stateEl = el('span', 'confirm-state', '');

    var diffWrap = buildDiff(proposal);

    diffBtn.addEventListener('click', function () {
      diffWrap.classList.toggle('hidden');
      diffBtn.textContent = diffWrap.classList.contains('hidden') ? '查看 Diff' : '收起 Diff';
    });
    applyBtn.addEventListener('click', function () {
      if (state.convId) post({ type: 'confirmWorkspace', conversationId: state.convId, accept: true });
    });
    rejectBtn.addEventListener('click', function () {
      if (state.convId) post({ type: 'confirmWorkspace', conversationId: state.convId, accept: false });
    });

    actions.appendChild(applyBtn);
    actions.appendChild(rejectBtn);
    actions.appendChild(diffBtn);
    actions.appendChild(stateEl);

    card.appendChild(actions);
    card.appendChild(diffWrap);
    $('messages').appendChild(card);
    scrollBottom();
  }

  function resolveConfirmCard(accepted) {
    state.proposal = null;
    var cards = document.querySelectorAll('.confirm-card');
    for (var i = 0; i < cards.length; i++) {
      var btns = cards[i].querySelectorAll('.confirm-actions button');
      for (var j = 0; j < btns.length; j++) btns[j].disabled = true;
      var st = cards[i].querySelector('.confirm-state');
      if (st) st.textContent = accepted ? '✓ 已应用' : '✗ 已拒绝';
    }
  }

  /* ---- 历史消息整体渲染 ---- */

  function renderConversation(conv) {
    state.convId = conv.id;
    state.convTitle = conv.title || '未命名会话';
    state.mode = conv.mode || 'chat';
    state.activeSkills = (conv.skillIds || []).slice();
    clearStreaming();
    state.pendingAttachments = [];
    renderAttachmentChips();

    $('chat-title').textContent = state.convTitle;
    setModeTabs(state.mode);
    populateModelSelect();
    renderSkillChips();

    var box = $('messages');
    box.innerHTML = '<div id="chat-empty" class="chat-empty">开始你的第一次对话吧</div>';

    /* toolCallId -> 工具名映射（历史 tool 消息回显用） */
    var callNames = {};
    (conv.messages || []).forEach(function (msg) {
      (msg.toolCalls || []).forEach(function (tc) {
        if (tc && tc.id) callNames[tc.id] = tc.name || 'tool';
      });
    });

    (conv.messages || []).forEach(function (msg) {
      if (msg.role === 'user') {
        addUserMsg(msg.content, []);
      } else if (msg.role === 'assistant') {
        if (msg.reasoning) {
          var det = el('details', 'msg-reasoning');
          det.appendChild(el('summary', '', '💭 思考过程'));
          var body = el('div', 'reasoning-body', '');
          body.textContent = msg.reasoning;
          det.appendChild(body);
          box.appendChild(det);
        }
        /* 历史消息为原始 markdown 文本：转义渲染（富文本化仅流式 finalize 提供） */
        var div = el('div', 'msg-assistant', '');
        div.textContent = msg.content || '';
        box.appendChild(div);
      } else if (msg.role === 'tool') {
        var card = el('div', 'msg-tool');
        var header = el('div', 'tool-header');
        header.appendChild(el('span', 'tool-status done', '✅'));
        header.appendChild(el('span', 'tool-name', '🔧 ' + (callNames[msg.toolCallId] || msg.toolCallId || 'tool')));
        var toggle = el('button', 'tool-toggle', '展开');
        var resultEl = el('div', 'tool-result', msg.content || '');
        toggle.addEventListener('click', function () {
          var exp = resultEl.classList.toggle('expanded');
          toggle.textContent = exp ? '收起' : '展开';
        });
        header.appendChild(toggle);
        card.appendChild(header);
        card.appendChild(resultEl);
        box.appendChild(card);
      }
    });
    scrollBottom();
    updateWebSearchBanner();
  }

  /* ---- 会话列表缓存维护 ---- */

  function upsertSession(meta) {
    if (!meta || !meta.id) return;
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === meta.id) {
        for (var k in meta) state.sessions[i][k] = meta[k];
        renderSessions();
        return;
      }
    }
    state.sessions.push(meta);
    renderSessions();
  }

  /* ---- 输入区 ---- */

  function renderAttachmentChips() {
    var wrap = $('attachment-chips');
    wrap.innerHTML = '';
    wrap.classList.toggle('hidden', state.pendingAttachments.length === 0);
    state.pendingAttachments.forEach(function (a, idx) {
      var chip = el('span', 'attach-chip');
      var icon = a.kind === 'image' ? '🖼 ' : (a.kind === 'pdfPage' ? '📄 ' : '📎 ');
      chip.appendChild(el('span', 'chip-name', icon + (a.name || a.kind)));
      var rm = el('button', 'chip-remove', '✕');
      rm.addEventListener('click', function () {
        state.pendingAttachments.splice(idx, 1);
        renderAttachmentChips();
      });
      chip.appendChild(rm);
      wrap.appendChild(chip);
    });
  }

  function doSend() {
    var input = $('input');
    var text = input.value.replace(/\s+$/, '');
    if (state.streaming) {
      /* 流式进行中：发送按钮当前为「停止」 */
      if (state.convId) post({ type: 'abort', conversationId: state.convId });
      clearStreaming();
      return;
    }
    if (!text && state.pendingAttachments.length === 0) return;  // 空输入忽略
    if (!state.convId) return;                                   // 未打开会话时忽略
    post({
      type: 'send',
      conversationId: state.convId,
      text: text,
      attachments: state.pendingAttachments.slice()
    });
    addUserMsg(text, state.pendingAttachments);
    state.pendingAttachments = [];
    renderAttachmentChips();
    input.value = '';
    input.style.height = 'auto';
    state.turnSeq += 1;
    state.streaming = true;
    state.assistantEl = null;   // 等首个 delta 到达再建气泡
    state.reasoningEl = null;
    $('send-btn').textContent = '停止';
  }

  /* ---------------- UiOut 消息处理 ---------------- */

  function onMessage(data) {
    switch (data.type) {
      case 'init':
        state.sessions = data.sessions || [];
        state.models = data.models || [];
        state.skills = data.skills || [];
        state.webSearchAvailable = data.webSearchAvailable !== false;
        state.workspaceWriteEnabled = !!data.workspaceWriteEnabled;
        renderSessions();
        populateModelSelect();
        renderSkillChips();
        updateWebSearchBanner();
        break;

      case 'conversation':
        upsertSession({
          id: data.conv.id,
          title: data.conv.title,
          mode: data.conv.mode,
          model: data.conv.model,
          updatedAt: data.conv.updatedAt,
          messageCount: (data.conv.messages || []).length
        });
        if (state.view === 'chat') renderConversation(data.conv);
        break;

      case 'delta':
        if (data.conversationId !== state.convId) break;
        var d = data.delta || {};
        if (d.type === 'text') {
          if (!state.assistantEl) state.assistantEl = addAssistantStreaming();
          var span = state.assistantEl.querySelector('.stream-text');
          if (span) span.appendChild(document.createTextNode(d.text || ''));
          /* 累积完整原文：finalize 时作为 [生成为笔记] 的 text（save 在 finalize 之后，勿依赖 store） */
          state.lastFullText += d.text || '';
          scrollBottom();
        } else if (d.type === 'reasoning') {
          if (!state.reasoningEl) state.reasoningEl = addReasoningBlock();
          var body = state.reasoningEl.querySelector('.reasoning-body');
          if (body) body.appendChild(document.createTextNode(d.text || ''));
          scrollBottom();
        }
        /* toolCall 增量不渲染，由 toolLifecycle 驱动工具卡 */
        break;

      case 'finalize':
        if (data.conversationId !== state.convId) break;
        if (state.assistantEl) {
          /* finalize.html 为扩展侧渲染好的 markdown HTML，直接整体替换（信任扩展侧） */
          state.assistantEl.classList.remove('streaming');
          state.assistantEl.setAttribute('data-mid', data.messageId || '');
          state.assistantEl.innerHTML = data.html || '';
          /* 含来源链接的最终帧：追加 [生成为笔记]（text 用流式累积的完整原文） */
          maybeAddSaveNoteFooter(state.assistantEl, state.lastFullText);
          state.assistantEl = null;
        }
        clearStreaming();
        scrollBottom();
        break;

      case 'toolLifecycle':
        if (data.conversationId !== state.convId) break;
        handleToolLifecycle(data);
        break;

      case 'error':
        if (data.conversationId !== state.convId) break;
        addErrorMsg(data.kind, data.message, data.retryable);
        clearStreaming();
        break;

      case 'confirmRequest':
        if (data.conversationId !== state.convId) break;
        addConfirmCard(data.proposal || {});
        break;

      case 'confirmResolved':
        if (data.conversationId !== state.convId) break;
        resolveConfirmCard(data.accepted);
        break;

      case 'noteSaved':
        addNoteSavedNotice(data.created ? '笔记已创建: ' : '笔记已追加: ', data.path);
        break;

      case 'pageText':
        /* 骨架实现：页面文本挂为待发送附件，完整联动 Task 7/9 接线 */
        if (data.text) {
          state.pendingAttachments.push({ kind: 'selection', name: '页面文本', content: data.text });
          renderAttachmentChips();
        }
        break;

      case 'attachmentPicked':
        if (data.attachment) {
          state.pendingAttachments.push(data.attachment);
          renderAttachmentChips();
        }
        break;
    }
  }

  function handleToolLifecycle(data) {
    var rec = state.toolCards[data.callId];
    if (!rec) {
      rec = addToolCard(data.callId, data.name, data.status, data.result);
      state.toolCards[data.callId] = rec;
      return;
    }
    rec.statusEl.className = 'tool-status ' + data.status;
    rec.statusEl.textContent = data.status === 'running' ? '⏳' : (data.status === 'done' ? '✅' : '❌');
    if (data.result != null && !rec.resultEl) {
      var toggle = el('button', 'tool-toggle', '展开');
      rec.resultEl = el('div', 'tool-result', String(data.result));
      toggle.addEventListener('click', function () {
        var exp = rec.resultEl.classList.toggle('expanded');
        toggle.textContent = exp ? '收起' : '展开';
      });
      rec.card.querySelector('.tool-header').appendChild(toggle);
      rec.card.appendChild(rec.resultEl);
    } else if (data.result != null && rec.resultEl) {
      rec.resultEl.textContent = String(data.result);
    }
    scrollBottom();
  }

  /* ---------------- 事件绑定与启动 ---------------- */

  function bindEvents() {
    /* 会话列表 */
    $('new-conversation-btn').addEventListener('click', openModeModal);
    $('mode-cancel').addEventListener('click', closeModeModal);
    $('mode-modal-mask').addEventListener('click', closeModeModal);
    var modeOpts = document.querySelectorAll('.mode-option');
    for (var i = 0; i < modeOpts.length; i++) {
      modeOpts[i].addEventListener('click', function () {
        onNewConversation(this.getAttribute('data-mode'));
      });
    }

    /* 模式 tab 切换 */
    var tabs = document.querySelectorAll('#mode-tabs .mode-tab');
    for (var j = 0; j < tabs.length; j++) {
      tabs[j].addEventListener('click', function () {
        var mode = this.getAttribute('data-mode');
        if (mode === state.mode || !state.convId) return;
        state.mode = mode;
        setModeTabs(mode);
        post({ type: 'setMode', conversationId: state.convId, mode: mode });
        state.activeSkills = defaultSkillIds(mode);
        renderSkillChips();
        updateWebSearchBanner();
      });
    }

    /* 输入区 */
    var input = $('input');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      } else if (e.key === 'Escape') {
        input.value = '';
        input.style.height = 'auto';
      }
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    $('send-btn').addEventListener('click', doSend);
    $('attach-btn').addEventListener('click', function () {
      post({ type: 'pickAttachment' });
    });

    $('model-select').addEventListener('change', function () {
      state.pendingModel = this.value;
      if (state.convId) post({ type: 'setModel', conversationId: state.convId, model: this.value });
    });
  }

  function boot() {
    /* webview 内联 HTML 无 location.search，扩展侧通过 window.__NOTA_VIEW__ 注入视图标识 */
    var params = new URLSearchParams(window.location.search);
    var viewParam = window.__NOTA_VIEW__ || params.get('view');
    state.view = viewParam === 'chat' ? 'chat' : 'session';
    switchView(state.view);
    bindEvents();
    /* init 由扩展侧在 webview 加载后主动推送，前端只处理渲染；ready 保留协议不强求发送 */
    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (msg && typeof msg === 'object') onMessage(msg);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
