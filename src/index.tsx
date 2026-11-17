import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { toast, toastSuccess, toastError, toastInfo, toastWarning } from './stores/toastStore';
import { initProviderVirtualMcpServer } from './features/settings-assistant/providerVirtualMcpServer';
import { initSettingsVirtualMcpServer } from './features/settings-mcp/settingsVirtualMcpServer';
import { initLocalPythonVirtualMcpServer } from './features/local-python/localPythonVirtualMcpServer';
import { initLocalJsVirtualMcpServer } from './features/local-js/localJsVirtualMcpServer';
import { initChatMemoryVirtualMcpServer } from './features/chat-memory/chatMemoryVirtualMcpServer';
import { initLibraryVirtualMcpServer } from './features/library-search/libraryVirtualMcpServer';
import { initDesktopToolsMcpServer } from './features/desktop-tools/desktopToolsServer';

initProviderVirtualMcpServer();
initSettingsVirtualMcpServer();
initLocalPythonVirtualMcpServer();
initLocalJsVirtualMcpServer();
initChatMemoryVirtualMcpServer();
initLibraryVirtualMcpServer();
// Desktop build only: registers the bundled file/PowerShell MCP server. A
// no-op on the web where no desktopTools config is injected.
initDesktopToolsMcpServer();

if (typeof window !== 'undefined') {
  Object.assign(window, {
    toast,
    toastSuccess,
    toastError,
    toastInfo,
    toastWarning,
  });
}

import './styles/main.css';
import './styles/animations.css';
import './styles/markdown.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount to');
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
