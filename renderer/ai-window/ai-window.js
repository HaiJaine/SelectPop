const state = {
  sourceText: '',
  sourceExpanded: false,
  activeTargetId: '',
  pinned: false,
  sessions: new Map()
};

const elements = {
  sourcePanel: document.querySelector('.source-panel'),
  sourceText: document.querySelector('#source-text'),
  sourceToggle: document.querySelector('#source-toggle'),
  sessionTabs: document.querySelector('#session-tabs'),
  metaText: document.querySelector('#meta-text'),
  resultContent: document.querySelector('#result-content'),
  pinButton: document.querySelector('#pin-button'),
  minimizeButton: document.querySelector('#minimize-button'),
  closeButton: document.querySelector('#close-button'),
  copyMarkdownButton: document.querySelector('#copy-markdown-button'),
  copyButton: document.querySelector('#copy-button'),
  retryButton: document.querySelector('#retry-button')
};

function applyUiConfig(config = {}) {
  const scale = Math.min(2, Math.max(0.7, Number(config?.aiWindowFontScale || 100) / 100));
  document.documentElement.style.setProperty('--font-scale', String(scale));
}

let tickerHandle = null;
let renderHandle = null;
let pendingRenderDelay = 0;
let renderToken = 0;
const buttonResetHandles = new Map();

function createSession(payload) {
  return {
    targetId: payload.targetId || payload.providerId,
    targetName: payload.targetName || payload.providerName,
    targetKind: payload.targetKind || 'provider',
    model: payload.model,
    markdown: '',
    statusText: '等待请求',
    metaText: '',
    pinned: false,
    streaming: false,
    startedAt: 0,
    tokens: 0,
    receivedContent: false,
    completed: false,
    errorMessage: '',
    pendingReset: false
  };
}

function formatElapsed(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getSessionStateLabel(session) {
  if (session.errorMessage) {
    return '失败';
  }

  if (session.streaming) {
    return '进行中';
  }

  if (session.receivedContent || session.completed) {
    return '完成';
  }

  return '等待';
}

function getActiveSession() {
  return state.sessions.get(state.activeTargetId) || null;
}

function stopTicker() {
  if (tickerHandle) {
    clearInterval(tickerHandle);
    tickerHandle = null;
  }
}

function startTicker() {
  stopTicker();
  tickerHandle = setInterval(() => {
    const activeSession = getActiveSession();

    if (!activeSession?.streaming) {
      return;
    }

    activeSession.metaText = formatElapsed(Date.now() - activeSession.startedAt);
    renderMeta();
    renderTabs();
  }, 1000);
}

function syncTicker() {
  if (Array.from(state.sessions.values()).some((session) => session.streaming)) {
    if (!tickerHandle) {
      startTicker();
    }

    return;
  }

  stopTicker();
}

function syncButtonLabel(button, idleLabel) {
  if (!buttonResetHandles.has(button.id)) {
    button.textContent = idleLabel;
  }
}

function flashButtonFeedback(button, idleLabel, successLabel) {
  const existingHandle = buttonResetHandles.get(button.id);

  if (existingHandle) {
    clearTimeout(existingHandle);
  }

  button.textContent = successLabel;
  const handle = setTimeout(() => {
    buttonResetHandles.delete(button.id);
    button.textContent = idleLabel;
  }, 1400);
  buttonResetHandles.set(button.id, handle);
}

function flashButtonError(button, idleLabel) {
  const existingHandle = buttonResetHandles.get(button.id);

  if (existingHandle) {
    clearTimeout(existingHandle);
  }

  button.textContent = '复制失败';
  const handle = setTimeout(() => {
    buttonResetHandles.delete(button.id);
    button.textContent = idleLabel;
  }, 1600);
  buttonResetHandles.set(button.id, handle);
}

function resetButtonFeedback() {
  for (const handle of buttonResetHandles.values()) {
    clearTimeout(handle);
  }

  buttonResetHandles.clear();
  elements.copyButton.textContent = '复制译文';
  elements.copyMarkdownButton.textContent = '复制 Markdown';
}

function renderSource() {
  elements.sourceText.textContent = state.sourceText || '暂无原文。';
  elements.sourcePanel.classList.toggle('expanded', state.sourceExpanded);
  elements.sourceText.hidden = !state.sourceExpanded;
  elements.sourceToggle.textContent = state.sourceExpanded ? '收起原文' : '显示原文';
  elements.sourceToggle.setAttribute('aria-expanded', String(state.sourceExpanded));
}

function renderActionButtons() {
  const activeSession = getActiveSession();
  const hasSession = Boolean(activeSession);
  const hasMarkdown = Boolean(activeSession?.markdown?.trim());

  elements.copyButton.disabled = !hasMarkdown;
  elements.copyMarkdownButton.disabled = !hasMarkdown;
  elements.retryButton.disabled = !hasSession || activeSession?.streaming === true;
  syncButtonLabel(elements.copyButton, '复制译文');
  syncButtonLabel(elements.copyMarkdownButton, '复制 Markdown');
  syncButtonLabel(elements.retryButton, activeSession?.streaming ? '请求中...' : '重新翻译');
}

function renderHeader() {
  renderSource();
  elements.pinButton.classList.toggle('active', state.pinned);
  renderActionButtons();
}

function renderMeta() {
  const activeSession = getActiveSession();
  elements.metaText.textContent = activeSession?.metaText || '';
  elements.metaText.title = activeSession?.metaText || '';
}

function renderResultMarkup(markup, { streaming = false } = {}) {
  elements.resultContent.classList.toggle('streaming', streaming);
  elements.resultContent.innerHTML = markup;
}

function renderTabs() {
  const sessions = Array.from(state.sessions.values());
  elements.sessionTabs.classList.toggle('is-multi', sessions.length > 1);

  elements.sessionTabs.innerHTML = sessions
    .map((session) => {
      const stateLabel = getSessionStateLabel(session);

      return `
        <button
          class="session-tab ${state.activeTargetId === session.targetId ? 'active' : ''}"
          type="button"
          data-target-id="${session.targetId}"
        >
          <span class="session-tab-name">${escapeHtml(session.targetName)}</span>
          <span class="session-tab-state">${stateLabel}</span>
        </button>
      `;
    })
    .join('');

  const renderedTabCount = elements.sessionTabs.querySelectorAll('.session-tab').length;

  if (sessions.length > 1 && renderedTabCount < 2) {
    console.warn('[SelectPop] Expected multiple AI tabs, but fewer were rendered.', {
      expected: sessions.length,
      rendered: renderedTabCount,
      activeTargetId: state.activeTargetId
    });
    window.aiWindowApi.reportUiDiagnostic?.({
      type: 'tabs-rendered-less-than-expected',
      expectedCount: sessions.length,
      renderedCount: renderedTabCount,
      activeTargetId: state.activeTargetId
    });
  }
}

function scrollActiveTabIntoView() {
  const activeTab = elements.sessionTabs.querySelector('.session-tab.active');

  if (!activeTab) {
    return;
  }

  activeTab.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest',
    inline: 'nearest'
  });
}

function extractPlainTextFromHtml(html) {
  const sandbox = document.createElement('div');
  sandbox.innerHTML = html;
  sandbox.setAttribute('aria-hidden', 'true');
  sandbox.style.position = 'fixed';
  sandbox.style.left = '-99999px';
  sandbox.style.top = '0';
  sandbox.style.width = '720px';
  sandbox.style.opacity = '0';
  sandbox.style.pointerEvents = 'none';
  sandbox.style.whiteSpace = 'normal';
  document.body.append(sandbox);
  const text = sandbox.innerText || sandbox.textContent || '';
  sandbox.remove();
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

async function getCopyPayload(session, format) {
  const markdown = String(session?.markdown || '').trim();

  if (!markdown) {
    return '';
  }

  if (format === 'markdown') {
    return markdown;
  }

  try {
    const html = await window.aiWindowApi.renderMarkdown(markdown, {
      targetId: session?.targetId || '',
      silent: true
    });
    return extractPlainTextFromHtml(html) || markdown;
  } catch (error) {
    console.error('[SelectPop] Failed to build plain text copy payload:', error);
    return markdown;
  }
}

async function copyActiveSession(format) {
  const activeSession = getActiveSession();

  if (!activeSession) {
    return;
  }

  const payload = await getCopyPayload(activeSession, format);

  if (!payload) {
    return;
  }

  try {
    const copied = await window.aiWindowApi.copyText(payload, format);

    if (copied !== true) {
      flashButtonError(
        format === 'markdown' ? elements.copyMarkdownButton : elements.copyButton,
        format === 'markdown' ? '复制 Markdown' : '复制译文'
      );
      return;
    }

    window.aiWindowApi.reportUiDiagnostic?.({
      type: 'copy-action',
      targetId: activeSession.targetId,
      copyType: format,
      textLength: payload.length
    });
    flashButtonFeedback(
      format === 'markdown' ? elements.copyMarkdownButton : elements.copyButton,
      format === 'markdown' ? '复制 Markdown' : '复制译文',
      format === 'markdown' ? 'Markdown 已复制' : '已复制'
    );
  } catch (error) {
    console.error('[SelectPop] Failed to copy AI output:', error);
    flashButtonError(
      format === 'markdown' ? elements.copyMarkdownButton : elements.copyButton,
      format === 'markdown' ? '复制 Markdown' : '复制译文'
    );
    window.aiWindowApi.reportUiDiagnostic?.({
      type: 'copy-failed',
      targetId: activeSession.targetId,
      copyType: format,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function flushMarkdown(targetId = state.activeTargetId) {
  if (renderHandle) {
    clearTimeout(renderHandle);
  }
  renderHandle = null;
  pendingRenderDelay = 0;
  const activeTargetId = String(targetId || '').trim();
  const activeSession = state.sessions.get(activeTargetId) || null;
  const currentRenderToken = ++renderToken;
  const markdown = String(activeSession?.markdown || '');

  if (!activeTargetId || state.activeTargetId !== activeTargetId) {
    return;
  }

  if (!activeSession) {
    renderResultMarkup('<p class="placeholder">点击 AI 工具后将在这里显示翻译结果。</p>');
    return;
  }

  if (activeSession.errorMessage) {
    renderResultMarkup(`<div class="error-block">${activeSession.errorMessage}</div>`);
    return;
  }

  if (!markdown) {
    renderResultMarkup(
      activeSession.completed
        ? '<p class="placeholder">模型返回了空内容。</p>'
        : '<p class="placeholder">正在等待返回内容...</p>'
    );
    return;
  }

  try {
    const html = await window.aiWindowApi.renderMarkdown(markdown, {
      targetId: activeSession.targetId,
      completed: activeSession.completed
    });
    const latestSession = state.sessions.get(activeTargetId);

    if (
      currentRenderToken !== renderToken
      || !latestSession
      || state.activeTargetId !== activeTargetId
      || latestSession.markdown !== markdown
    ) {
      if (state.activeTargetId === activeTargetId) {
        scheduleMarkdownRender(true);
      }
      return;
    }

    renderResultMarkup(html, { streaming: latestSession.streaming });
  } catch (error) {
    console.error('[SelectPop] AI markdown render failed:', error);
    window.aiWindowApi.reportUiDiagnostic?.({
      type: 'markdown-render-failed',
      targetId: activeSession.targetId,
      textLength: markdown.length,
      message: error instanceof Error ? error.message : String(error)
    });
    const latestSession = state.sessions.get(activeTargetId);

    if (
      currentRenderToken !== renderToken
      || !latestSession
      || state.activeTargetId !== activeTargetId
      || latestSession.markdown !== markdown
    ) {
      if (state.activeTargetId === activeTargetId) {
        scheduleMarkdownRender(true);
      }
      return;
    }

    renderResultMarkup('<pre class="plain-markdown"></pre>', { streaming: latestSession.streaming });
    const fallbackElement = elements.resultContent.querySelector('.plain-markdown');

    if (fallbackElement) {
      fallbackElement.textContent = markdown;
    }
  }

  try {
    await window.aiWindowApi.enhanceCodeBlocks('#result-content');
  } catch (error) {
    console.error('[SelectPop] AI code block enhancement failed:', error);
  }
}

function scheduleMarkdownRender(force = false) {
  const activeSession = getActiveSession();
  const nextDelay = force ? 0 : activeSession?.streaming ? 220 : 60;

  if (renderHandle) {
    if (nextDelay >= pendingRenderDelay) {
      return;
    }

    clearTimeout(renderHandle);
  }

  pendingRenderDelay = nextDelay;
  renderHandle = setTimeout(() => {
    renderHandle = null;
    pendingRenderDelay = 0;
    void flushMarkdown(state.activeTargetId);
  }, nextDelay);
}

function resetForSession(payload) {
  stopTicker();
  resetButtonFeedback();
  state.sourceText = payload.text || '';
  state.sourceExpanded = false;
  state.activeTargetId = payload.activeTargetId || payload.sessions?.[0]?.targetId || payload.sessions?.[0]?.providerId || '';
  state.pinned = Boolean(payload.pinned);
  state.sessions = new Map((payload.sessions || []).map((session) => [session.targetId || session.providerId, createSession(session)]));
  renderTabs();
  scrollActiveTabIntoView();
  renderHeader();
  renderMeta();
  void flushMarkdown(state.activeTargetId);
  syncTicker();
}

function updateSession(targetId, updater) {
  const session = state.sessions.get(targetId);

  if (!session) {
    return null;
  }

  updater(session);
  renderTabs();

  if (state.activeTargetId === targetId) {
    renderHeader();
    renderMeta();
    scheduleMarkdownRender(session.completed === true);
  }

  syncTicker();

  return session;
}

window.aiWindowApi.onSession(resetForSession);
window.aiWindowApi.onStreamStart((payload) => {
  updateSession(payload.targetId || payload.providerId, (session) => {
    session.streaming = true;
    session.startedAt = payload.startedAt;
    session.statusText = payload.cached ? '已命中缓存' : '正在翻译...';
    session.metaText = formatElapsed(0);
    session.errorMessage = '';
    session.pendingReset = payload.preserveExisting === true;

    if (!session.pendingReset) {
      session.markdown = '';
      session.receivedContent = false;
    }

    session.completed = false;
  });
  syncTicker();
});
window.aiWindowApi.onChunk(({ targetId, providerId, chunk }) => {
  updateSession(targetId || providerId, (session) => {
    session.markdown = session.pendingReset ? chunk : `${session.markdown}${chunk}`;
    session.pendingReset = false;
    session.receivedContent = session.markdown.trim().length > 0;
  });
});
window.aiWindowApi.onDone(({ targetId, providerId, timeMs, tokens, cached }) => {
  updateSession(targetId || providerId, (session) => {
    session.streaming = false;
    session.tokens = tokens || 0;
    session.statusText = '完成';
    session.pendingReset = false;
    session.metaText = cached
      ? `缓存 · ${session.tokens} tokens`
      : `${formatElapsed(timeMs || 0)} · ${session.tokens} tokens`;
    session.completed = true;
  });
});
window.aiWindowApi.onRetrying(({ targetId, providerId, message }) => {
  updateSession(targetId || providerId, (session) => {
    session.statusText = message;
    session.errorMessage = '';
    session.streaming = true;
    session.completed = false;
    session.pendingReset = true;
  });
});
window.aiWindowApi.onError(({ targetId, providerId, message }) => {
  updateSession(targetId || providerId, (session) => {
    session.streaming = false;
    session.statusText = '请求失败';
    session.errorMessage = message;
    session.completed = true;
  });
});
window.aiWindowApi.onAborted(({ targetId, providerId }) => {
  updateSession(targetId || providerId, (session) => {
    session.streaming = false;
    session.statusText = '请求已中断';
    session.errorMessage = '请求已中断。';
    session.completed = true;
  });
});
window.aiWindowApi.onPinned(({ pinned }) => {
  state.pinned = pinned;
  renderHeader();
});
window.aiWindowApi.onUiConfig((payload) => {
  applyUiConfig(payload);
});

elements.sessionTabs.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-target-id]');

  if (!tab) {
    return;
  }

  state.activeTargetId = tab.dataset.targetId;
  renderTabs();
  scrollActiveTabIntoView();
  renderHeader();
  renderMeta();
  void flushMarkdown(state.activeTargetId);
});

elements.sessionTabs.addEventListener(
  'wheel',
  (event) => {
    if (elements.sessionTabs.scrollWidth <= elements.sessionTabs.clientWidth) {
      return;
    }

    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;

    if (!delta) {
      return;
    }

    event.preventDefault();
    elements.sessionTabs.scrollLeft += delta;
  },
  { passive: false }
);

elements.resultContent.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');

  if (!link) {
    return;
  }

  event.preventDefault();
  window.aiWindowApi.openExternal(link.href);
});

elements.pinButton.addEventListener('click', async () => {
  state.pinned = await window.aiWindowApi.togglePin();
  renderHeader();
});

elements.minimizeButton.addEventListener('click', () => {
  window.aiWindowApi.minimizeWindow();
});

elements.closeButton.addEventListener('click', () => {
  window.aiWindowApi.closeWindow();
});

elements.sourceToggle.addEventListener('click', () => {
  state.sourceExpanded = !state.sourceExpanded;
  renderSource();
});

elements.copyMarkdownButton.addEventListener('click', () => {
  void copyActiveSession('markdown');
});

elements.copyButton.addEventListener('click', () => {
  void copyActiveSession('text');
});

elements.retryButton.addEventListener('click', () => {
  const activeSession = getActiveSession();

  if (!activeSession) {
    return;
  }

  activeSession.errorMessage = '';
  activeSession.markdown = '';
  activeSession.statusText = '准备请求...';
  activeSession.completed = false;
  activeSession.receivedContent = false;
  renderHeader();
  renderMeta();
  scheduleMarkdownRender();
  window.aiWindowApi.retry(activeSession.targetId);
});

window.addEventListener('beforeunload', () => {
  stopTicker();
  for (const handle of buttonResetHandles.values()) {
    clearTimeout(handle);
  }
  buttonResetHandles.clear();
  window.aiWindowApi.abort();
});

renderTabs();
renderHeader();
renderMeta();
applyUiConfig();
scheduleMarkdownRender();
