const state = {
  sourceText: '',
  sourceExpanded: false,
  activeProviderId: '',
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
const buttonResetHandles = new Map();

function createSession(payload) {
  return {
    providerId: payload.providerId,
    providerName: payload.providerName,
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
  return state.sessions.get(state.activeProviderId) || null;
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
  elements.retryButton.disabled = !hasSession;
  syncButtonLabel(elements.copyButton, '复制译文');
  syncButtonLabel(elements.copyMarkdownButton, '复制 Markdown');
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

function renderTabs() {
  const sessions = Array.from(state.sessions.values());
  elements.sessionTabs.classList.toggle('is-multi', sessions.length > 1);

  elements.sessionTabs.innerHTML = sessions
    .map((session) => {
      const stateLabel = getSessionStateLabel(session);

      return `
        <button
          class="session-tab ${state.activeProviderId === session.providerId ? 'active' : ''}"
          type="button"
          data-provider-id="${session.providerId}"
        >
          <span class="session-tab-name">${escapeHtml(session.providerName)}</span>
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
      activeProviderId: state.activeProviderId
    });
    window.aiWindowApi.reportUiDiagnostic?.({
      type: 'tabs-rendered-less-than-expected',
      expectedCount: sessions.length,
      renderedCount: renderedTabCount,
      activeProviderId: state.activeProviderId
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
      providerId: session?.providerId || '',
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
      providerId: activeSession.providerId,
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
      providerId: activeSession.providerId,
      copyType: format,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function flushMarkdown() {
  renderHandle = null;
  pendingRenderDelay = 0;
  const activeSession = getActiveSession();
  const activeProviderId = state.activeProviderId;
  const markdown = String(activeSession?.markdown || '');

  if (!activeSession) {
    elements.resultContent.classList.remove('streaming');
    elements.resultContent.innerHTML = '<p class="placeholder">点击 AI 工具后将在这里显示翻译结果。</p>';
    return;
  }

  if (activeSession.errorMessage) {
    elements.resultContent.classList.remove('streaming');
    elements.resultContent.innerHTML = `<div class="error-block">${activeSession.errorMessage}</div>`;
    return;
  }

  if (!markdown) {
    elements.resultContent.classList.remove('streaming');
    elements.resultContent.innerHTML = activeSession.completed
      ? '<p class="placeholder">模型返回了空内容。</p>'
      : '<p class="placeholder">正在等待返回内容...</p>';
    return;
  }

  try {
    const html = await window.aiWindowApi.renderMarkdown(markdown, {
      providerId: activeSession.providerId,
      completed: activeSession.completed
    });
    const latestSession = state.sessions.get(activeProviderId);

    if (!latestSession || state.activeProviderId !== activeProviderId || latestSession.markdown !== markdown) {
      return;
    }

    elements.resultContent.innerHTML = html;
  } catch (error) {
    console.error('[SelectPop] AI markdown render failed:', error);
    window.aiWindowApi.reportUiDiagnostic?.({
      type: 'markdown-render-failed',
      providerId: activeSession.providerId,
      textLength: markdown.length,
      message: error instanceof Error ? error.message : String(error)
    });
    const latestSession = state.sessions.get(activeProviderId);

    if (!latestSession || state.activeProviderId !== activeProviderId || latestSession.markdown !== markdown) {
      return;
    }

    elements.resultContent.innerHTML = '<pre class="plain-markdown"></pre>';
    const fallbackElement = elements.resultContent.querySelector('.plain-markdown');

    if (fallbackElement) {
      fallbackElement.textContent = markdown;
    }
  }

  elements.resultContent.classList.toggle('streaming', activeSession.streaming);

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
    void flushMarkdown();
  }, nextDelay);
}

function resetForSession(payload) {
  stopTicker();
  resetButtonFeedback();
  state.sourceText = payload.text || '';
  state.sourceExpanded = false;
  state.activeProviderId = payload.activeProviderId || payload.sessions?.[0]?.providerId || '';
  state.pinned = Boolean(payload.pinned);
  state.sessions = new Map((payload.sessions || []).map((session) => [session.providerId, createSession(session)]));
  renderTabs();
  scrollActiveTabIntoView();
  renderHeader();
  renderMeta();
  scheduleMarkdownRender(true);
  syncTicker();
}

function updateSession(providerId, updater) {
  const session = state.sessions.get(providerId);

  if (!session) {
    return null;
  }

  updater(session);
  renderTabs();

  if (state.activeProviderId === providerId) {
    renderHeader();
    renderMeta();
    scheduleMarkdownRender(session.completed === true);
  }

  syncTicker();

  return session;
}

window.aiWindowApi.onSession(resetForSession);
window.aiWindowApi.onStreamStart((payload) => {
  updateSession(payload.providerId, (session) => {
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
window.aiWindowApi.onChunk(({ providerId, chunk }) => {
  updateSession(providerId, (session) => {
    session.markdown = session.pendingReset ? chunk : `${session.markdown}${chunk}`;
    session.pendingReset = false;
    session.receivedContent = session.markdown.trim().length > 0;
  });
});
window.aiWindowApi.onDone(({ providerId, timeMs, tokens, cached }) => {
  updateSession(providerId, (session) => {
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
window.aiWindowApi.onRetrying(({ providerId, message }) => {
  updateSession(providerId, (session) => {
    session.statusText = message;
    session.errorMessage = '';
    session.streaming = true;
    session.completed = false;
    session.pendingReset = true;
  });
});
window.aiWindowApi.onError(({ providerId, message }) => {
  updateSession(providerId, (session) => {
    session.streaming = false;
    session.statusText = '请求失败';
    session.errorMessage = message;
    session.completed = true;
  });
});
window.aiWindowApi.onAborted(({ providerId }) => {
  updateSession(providerId, (session) => {
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
  const tab = event.target.closest('[data-provider-id]');

  if (!tab) {
    return;
  }

  state.activeProviderId = tab.dataset.providerId;
  renderTabs();
  scrollActiveTabIntoView();
  renderHeader();
  renderMeta();
  scheduleMarkdownRender(true);
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
  window.aiWindowApi.retry(activeSession.providerId);
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
