const { contextBridge, ipcRenderer, shell } = require('electron');

const highlightRuntimePromise = Promise.all([
  import('highlight.js/lib/core'),
  import('highlight.js/lib/languages/plaintext'),
  import('highlight.js/lib/languages/javascript'),
  import('highlight.js/lib/languages/typescript'),
  import('highlight.js/lib/languages/json'),
  import('highlight.js/lib/languages/bash'),
  import('highlight.js/lib/languages/python'),
  import('highlight.js/lib/languages/c'),
  import('highlight.js/lib/languages/cpp'),
  import('highlight.js/lib/languages/java'),
  import('highlight.js/lib/languages/go'),
  import('highlight.js/lib/languages/rust'),
  import('highlight.js/lib/languages/sql'),
  import('highlight.js/lib/languages/xml'),
  import('highlight.js/lib/languages/markdown')
]).then(
  ([
    highlightModule,
    plaintextModule,
    javascriptModule,
    typescriptModule,
    jsonModule,
    bashModule,
    pythonModule,
    cModule,
    cppModule,
    javaModule,
    goModule,
    rustModule,
    sqlModule,
    xmlModule,
    markdownModule
  ]) => {
    const hljs = highlightModule.default || highlightModule;
    const registrations = {
      plaintext: plaintextModule,
      text: plaintextModule,
      javascript: javascriptModule,
      js: javascriptModule,
      typescript: typescriptModule,
      ts: typescriptModule,
      json: jsonModule,
      bash: bashModule,
      shell: bashModule,
      sh: bashModule,
      python: pythonModule,
      py: pythonModule,
      c: cModule,
      cpp: cppModule,
      'c++': cppModule,
      java: javaModule,
      go: goModule,
      rust: rustModule,
      sql: sqlModule,
      xml: xmlModule,
      html: xmlModule,
      svg: xmlModule,
      markdown: markdownModule,
      md: markdownModule
    };

    for (const [name, languageModule] of Object.entries(registrations)) {
      if (!hljs.getLanguage(name)) {
        hljs.registerLanguage(name, languageModule.default || languageModule);
      }
    }

    return {
      enhanceCodeBlocks(selector) {
        const root = document.querySelector(selector);

        if (!root) {
          return;
        }

        for (const block of root.querySelectorAll('pre code')) {
          const languageName =
            block.className
              .split(' ')
              .find((token) => token.startsWith('language-'))
              ?.replace('language-', '') || 'text';
          const pre = block.closest('pre');

          if (hljs.getLanguage(languageName)) {
            hljs.highlightElement(block);
          }

          if (pre && !pre.dataset.language) {
            pre.dataset.language = languageName;
          }
        }
      }
    };
  }
);

contextBridge.exposeInMainWorld('aiWindowApi', {
  retry: (providerId) => ipcRenderer.invoke('ai:retry', providerId),
  abort: (providerId) => ipcRenderer.invoke('ai:abort', providerId),
  reportUiDiagnostic: (payload) => ipcRenderer.send('ai:ui-diagnostic', payload),
  resizeWindow: (bounds) => ipcRenderer.invoke('window:resize', bounds),
  togglePin: () => ipcRenderer.invoke('window:pin-toggle'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  copyText: (text, kind = 'text') => ipcRenderer.invoke('ai:copy-text', { text, kind }),
  openExternal: (url) => shell.openExternal(url),
  renderMarkdown: async (markdown, meta = {}) => {
    return ipcRenderer.invoke('ai:render-markdown', { markdown, meta });
  },
  enhanceCodeBlocks: async (selector) => {
    const runtime = await highlightRuntimePromise;
    runtime.enhanceCodeBlocks(selector);
  },
  onSession: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('ai:session', wrapped);
    return () => ipcRenderer.removeListener('ai:session', wrapped);
  },
  onStreamStart: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('ai:stream-start', wrapped);
    return () => ipcRenderer.removeListener('ai:stream-start', wrapped);
  },
  onChunk: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('ai:chunk', wrapped);
    return () => ipcRenderer.removeListener('ai:chunk', wrapped);
  },
  onDone: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('ai:done', wrapped);
    return () => ipcRenderer.removeListener('ai:done', wrapped);
  },
  onError: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('ai:error', wrapped);
    return () => ipcRenderer.removeListener('ai:error', wrapped);
  },
  onRetrying: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('ai:retrying', wrapped);
    return () => ipcRenderer.removeListener('ai:retrying', wrapped);
  },
  onAborted: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('ai:aborted', wrapped);
    return () => ipcRenderer.removeListener('ai:aborted', wrapped);
  },
  onPinned: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('ai:pinned', wrapped);
    return () => ipcRenderer.removeListener('ai:pinned', wrapped);
  },
  onUiConfig: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('ai:ui-config', wrapped);
    return () => ipcRenderer.removeListener('ai:ui-config', wrapped);
  }
});
