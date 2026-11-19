import { describe, expect, it, vi } from 'vitest';
import { createDbServiceMockModule } from '@/test/doubles/moduleMocks';
import type { AppSettings } from '@/types';

const getAppSettings = vi.fn();

vi.mock('@/services/db/dbService', () => createDbServiceMockModule({ getAppSettings: () => getAppSettings() }));

const mockDesktopTools = vi.fn();
vi.mock('@/runtime/runtimeConfig', () => ({
  getDesktopToolsConfig: () => mockDesktopTools(),
  isServerAccessPasswordRequired: () => false,
}));

const baseSettings = (overrides: Partial<AppSettings> = {}): AppSettings =>
  ({
    apiKey: 'AIza-test',
    useCustomApiConfig: false,
    apiProxyUrl: null,
    serverManagedApi: false,
    thirdPartyApi: { connections: [] },
    ...overrides,
  }) as AppSettings;

const loadModule = async () => {
  vi.resetModules();
  const module = await import('./diagnostics');
  return module;
};

/** jsdom 默认 isSecureContext=false；环境检查需要显式指定，不能靠运气。 */
const withSecureContext = async <T>(value: boolean, run: () => Promise<T>): Promise<T> => {
  const original = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
  try {
    return await run();
  } finally {
    if (original) {
      Object.defineProperty(window, 'isSecureContext', original);
    } else {
      delete (window as unknown as Record<string, unknown>).isSecureContext;
    }
  }
};

describe('runDiagnostics', () => {
  it('reports a healthy direct-Gemini setup', async () => {
    getAppSettings.mockResolvedValue(baseSettings());
    mockDesktopTools.mockReturnValue(null);
    const { runDiagnostics } = await loadModule();

    const report = await withSecureContext(true, () => runDiagnostics(baseSettings()));

    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    expect(byId.storage.status).toBe('ok');
    expect(byId.api.status).toBe('ok');
    expect(byId.api.detailKey).toBe('diagnosticsApiKeyPresent');
    expect(byId['third-party'].status).toBe('skip');
    expect(byId.environment.status).toBe('ok');
    expect(byId['desktop-tools'].status).toBe('skip');
    expect(report.failCount).toBe(0);
    expect(report.completed).toBe(true);
  });

  it('flags a missing API key and points at the API tab', async () => {
    getAppSettings.mockResolvedValue(baseSettings());
    mockDesktopTools.mockReturnValue(null);
    const { runDiagnostics } = await loadModule();

    const report = await runDiagnostics(baseSettings({ apiKey: null }));
    const api = report.checks.find((check) => check.id === 'api');

    expect(api?.status).toBe('fail');
    expect(api?.detailKey).toBe('diagnosticsApiKeyMissing');
    expect(api?.fixTab).toBe('api');
    expect(report.failCount).toBe(1);
  });

  it('does not call a server-managed sentinel key a user problem', async () => {
    getAppSettings.mockResolvedValue(baseSettings());
    mockDesktopTools.mockReturnValue(null);
    const { runDiagnostics } = await loadModule();

    const report = await runDiagnostics(baseSettings({ apiKey: '__SERVER_MANAGED__' }));
    const api = report.checks.find((check) => check.id === 'api');

    expect(api?.status).toBe('ok');
    expect(api?.detailKey).toBe('diagnosticsApiServerManaged');
  });

  it('fails custom API mode when the proxy URL is blank', async () => {
    getAppSettings.mockResolvedValue(baseSettings());
    mockDesktopTools.mockReturnValue(null);
    const { runDiagnostics } = await loadModule();

    const report = await runDiagnostics(baseSettings({ useCustomApiConfig: true, apiProxyUrl: '   ' }));
    const api = report.checks.find((check) => check.id === 'api');

    expect(api?.status).toBe('fail');
    expect(api?.detailKey).toBe('diagnosticsApiProxyUrlMissing');
  });

  it('fails third-party routing when no provider is enabled', async () => {
    getAppSettings.mockResolvedValue(baseSettings());
    mockDesktopTools.mockReturnValue(null);
    const { runDiagnostics } = await loadModule();

    const report = await runDiagnostics(
      baseSettings({
        useCustomApiConfig: true,
        apiProxyUrl: 'https://proxy.example.com',
        thirdPartyApi: {
          connections: [
            {
              id: 'p1',
              name: 'Off',
              templateId: 'custom' as never,
              protocol: 'openai' as never,
              apiKey: 'sk-x',
              baseUrl: 'https://api.example.com',
              extraHeaders: {},
              modelId: 'gpt-x',
              models: [],
              enabled: false,
            },
          ],
        },
      }),
    );
    const routing = report.checks.find((check) => check.id === 'third-party');

    expect(routing?.status).toBe('fail');
    expect(routing?.detailKey).toBe('diagnosticsThirdPartyMissing');
  });

  it('warns instead of failing when an enabled provider has no key', async () => {
    getAppSettings.mockResolvedValue(baseSettings());
    mockDesktopTools.mockReturnValue(null);
    const { runDiagnostics } = await loadModule();

    const report = await withSecureContext(true, () =>
      runDiagnostics(
        baseSettings({
          useCustomApiConfig: true,
          apiProxyUrl: 'https://proxy.example.com',
          thirdPartyApi: {
            connections: [
              {
                id: 'p1',
                name: 'Local',
                templateId: 'custom' as never,
                protocol: 'openai' as never,
                apiKey: null,
                baseUrl: 'http://127.0.0.1:11434/v1',
                extraHeaders: {},
                modelId: 'llama',
                models: [],
                enabled: true,
              },
            ],
          },
        }),
      ),
    );
    const routing = report.checks.find((check) => check.id === 'third-party');

    expect(routing?.status).toBe('warn');
    expect(report.warnCount).toBe(1);
    expect(report.failCount).toBe(0);
  });

  it('turns a storage exception into a named failure', async () => {
    const quotaError = new Error('quota');
    quotaError.name = 'QuotaExceededError';
    getAppSettings.mockRejectedValue(quotaError);
    mockDesktopTools.mockReturnValue(null);
    const { runDiagnostics } = await loadModule();

    const report = await runDiagnostics(baseSettings());
    const storage = report.checks.find((check) => check.id === 'storage');

    expect(storage?.status).toBe('fail');
    expect(storage?.detailKey).toBe('diagnosticsStorageError');
    expect(storage?.detailParams).toEqual({ error: 'QuotaExceededError' });
  });

  it('warns when the page is not a secure context', async () => {
    getAppSettings.mockResolvedValue(baseSettings());
    mockDesktopTools.mockReturnValue(null);
    const { runDiagnostics } = await loadModule();

    const report = await withSecureContext(false, () => runDiagnostics(baseSettings()));
    const environment = report.checks.find((check) => check.id === 'environment');

    expect(environment?.status).toBe('warn');
    expect(environment?.detailKey).toBe('diagnosticsEnvironmentInsecure');
  });

  it('skips local file tools outside the desktop app', async () => {
    getAppSettings.mockResolvedValue(baseSettings());
    mockDesktopTools.mockReturnValue({ serverPath: '/app/tools/server.js', command: 'node', roots: [] });
    const { runDiagnostics } = await loadModule();

    const report = await runDiagnostics(baseSettings());
    const tools = report.checks.find((check) => check.id === 'desktop-tools');

    // jsdom 不是桌面环境，所以这里的断言是"网页版不适用"这条分支。
    expect(tools?.status).toBe('skip');
  });
});
