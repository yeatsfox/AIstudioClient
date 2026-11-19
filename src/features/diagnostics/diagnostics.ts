import type { SettingsTab } from '@/stores/settingsUiStore';
import type { AppSettings } from '@/types';
import { getDesktopToolsConfig, isServerAccessPasswordRequired } from '@/runtime/runtimeConfig';
import { dbService } from '@/services/db/dbService';

/**
 * 诊断项的三种结果。
 *
 * - `ok`      有明确证据表明这一环是通的
 * - `warn`    能用，但存在会引发问题的隐患（比如 key 是掩码、代理没配密码）
 * - `fail`    这一环断了，后面的功能会失败
 * - `skip`    当前配置下这一环不适用（比如纯 Gemini 直连时不需要检查第三方路由）
 */
export type DiagnosticStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DiagnosticCheck {
  id: string;
  /** i18n key：诊断项名称。 */
  labelKey: string;
  status: DiagnosticStatus;
  /** i18n key：一句话说明检测到了什么。运行期出错时这里是原始错误摘要。 */
  detailKey: string;
  /** 可选的插值参数，配合 detailKey 使用。 */
  detailParams?: Record<string, string | number>;
  /** i18n key：可落地的处理建议。仅 fail / warn 时给出。 */
  hintKey?: string;
  /** 可选的「去修复」跳转目标（设置页 tab id）。 */
  fixTab?: SettingsTab;
}

export interface DiagnosticReport {
  checks: DiagnosticCheck[];
  okCount: number;
  warnCount: number;
  failCount: number;
  skipCount: number;
  /** 全部检查完成后为 true。 */
  completed: boolean;
}

interface DiagnosticContext {
  settings: AppSettings;
  desktopTools: ReturnType<typeof getDesktopToolsConfig>;
  serverManagedApi: boolean;
  serverAccessPasswordRequired: boolean;
  /** 浏览器/桌面环境能力。 */
  capabilities: {
    isDesktop: boolean;
    hasIndexedDb: boolean;
    isSecureContext: boolean;
  };
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/**
 * 检测存储是否可用。
 *
 * IndexedDB 在隐私模式、配额耗尽、或者用户手动禁用时会直接拒绝打开，
 * 而这会在聊天记录保存时才炸，报错信息（QuotaExceededError / SecurityError）
 * 对用户毫无意义。提前探一下能把问题定位到「存储」这一环。
 */
const checkStorage = async (): Promise<DiagnosticCheck> => {
  const base: Pick<DiagnosticCheck, 'id' | 'labelKey'> = { id: 'storage', labelKey: 'diagnosticsStorageCheck' };

  if (typeof indexedDB === 'undefined') {
    return {
      ...base,
      status: 'fail',
      detailKey: 'diagnosticsStorageUnavailable',
      hintKey: 'diagnosticsStorageUnavailableHint',
    };
  }

  try {
    await dbService.getAppSettings();
    return { ...base, status: 'ok', detailKey: 'diagnosticsStorageOk' };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    return {
      ...base,
      status: 'fail',
      detailKey: 'diagnosticsStorageError',
      detailParams: { error: name },
      hintKey: 'diagnosticsStorageUnavailableHint',
    };
  }
};

/**
 * 检测 API 配置是否自洽。
 *
 * 这里不发起网络请求：诊断页的价值是「不用等网络就能说清楚哪一环没配」，
 * 真正的连通性测试单独放在 API 设置里，避免每次打开诊断都打一次 API。
 */
const checkApiConfiguration = (context: DiagnosticContext): DiagnosticCheck => {
  const { settings, serverManagedApi, serverAccessPasswordRequired } = context;
  const base: Pick<DiagnosticCheck, 'id' | 'labelKey' | 'fixTab'> = {
    id: 'api',
    labelKey: 'diagnosticsApiCheck',
    fixTab: 'api',
  };

  if (serverManagedApi) {
    return {
      ...base,
      status: 'ok',
      detailKey: 'diagnosticsApiServerManaged',
      hintKey: serverAccessPasswordRequired ? 'diagnosticsApiServerPasswordOn' : undefined,
    };
  }

  if (settings.useCustomApiConfig) {
    if (!isNonEmptyString(settings.apiProxyUrl)) {
      return {
        ...base,
        status: 'fail',
        detailKey: 'diagnosticsApiProxyUrlMissing',
        hintKey: 'diagnosticsApiProxyUrlMissingHint',
      };
    }
    return { ...base, status: 'ok', detailKey: 'diagnosticsApiProxyConfigured' };
  }

  const apiKey = settings.apiKey;
  const hasApiKey = isNonEmptyString(apiKey);
  // 服务端托管的哨兵值（__SERVER_MANAGED__ 这类）不是真 key，但也不需要用户填。
  const usesServerSentinel = isNonEmptyString(apiKey) && apiKey.startsWith('__') && apiKey.endsWith('__');

  if (!hasApiKey) {
    return {
      ...base,
      status: 'fail',
      detailKey: 'diagnosticsApiKeyMissing',
      hintKey: 'diagnosticsApiKeyMissingHint',
    };
  }

  return {
    ...base,
    status: 'ok',
    detailKey: usesServerSentinel ? 'diagnosticsApiServerManaged' : 'diagnosticsApiKeyPresent',
  };
};

/**
 * 检测第三方协议路由（OpenAI 兼容 / Anthropic）。
 *
 * 只检查「开了但没配」这种自相矛盾状态，不判断远端是否可达。
 */
const checkThirdPartyRouting = (context: DiagnosticContext): DiagnosticCheck => {
  const { settings, serverManagedApi } = context;
  const base: Pick<DiagnosticCheck, 'id' | 'labelKey' | 'fixTab'> = {
    id: 'third-party',
    labelKey: 'diagnosticsThirdPartyCheck',
    fixTab: 'providers',
  };

  const usesThirdParty = settings.useCustomApiConfig && !serverManagedApi;
  if (!usesThirdParty) {
    return { ...base, status: 'skip', detailKey: 'diagnosticsThirdPartyNotUsed' };
  }

  // 会话按 (providerId, modelId) 路由，诊断取当前启用的第一条连接作为"是否配好"的证据。
  const connection = settings.thirdPartyApi?.connections?.find((entry) => entry.enabled) ?? null;
  if (!connection) {
    return {
      ...base,
      status: 'fail',
      detailKey: 'diagnosticsThirdPartyMissing',
      hintKey: 'diagnosticsThirdPartyMissingHint',
    };
  }

  if (!isNonEmptyString(connection.baseUrl)) {
    return {
      ...base,
      status: 'fail',
      detailKey: 'diagnosticsThirdPartyBaseUrlMissing',
      hintKey: 'diagnosticsThirdPartyBaseUrlMissingHint',
    };
  }

  if (!isNonEmptyString(connection.apiKey)) {
    return {
      ...base,
      status: 'warn',
      detailKey: 'diagnosticsThirdPartyKeyMissing',
      hintKey: 'diagnosticsThirdPartyKeyMissingHint',
    };
  }

  return { ...base, status: 'ok', detailKey: 'diagnosticsThirdPartyConfigured' };
};

/**
 * 检测运行环境。
 *
 * 这里查的是「用户会困惑但又不是错」的几种情况：
 * 非安全上下文会让剪贴板、Service Worker、部分文件 API 静默失效。
 */
const checkEnvironment = (context: DiagnosticContext): DiagnosticCheck => {
  const { capabilities } = context;
  const base: Pick<DiagnosticCheck, 'id' | 'labelKey'> = { id: 'environment', labelKey: 'diagnosticsEnvironmentCheck' };

  if (!capabilities.isSecureContext) {
    return {
      ...base,
      status: 'warn',
      detailKey: 'diagnosticsEnvironmentInsecure',
      hintKey: 'diagnosticsEnvironmentInsecureHint',
    };
  }

  return {
    ...base,
    status: 'ok',
    detailKey: capabilities.isDesktop ? 'diagnosticsEnvironmentDesktop' : 'diagnosticsEnvironmentBrowser',
  };
};

/**
 * 检测本地工具桥。
 *
 * desktopTools 只有在服务端把 MCP server 路径注入进来时才非空；网页版
 * 永远为空，所以这里对网页版直接 skip，而不是报 fail——那是设计如此。
 */
const checkDesktopTools = (context: DiagnosticContext): DiagnosticCheck => {
  const { desktopTools, capabilities } = context;
  const base: Pick<DiagnosticCheck, 'id' | 'labelKey' | 'fixTab'> = {
    id: 'desktop-tools',
    labelKey: 'diagnosticsDesktopToolsCheck',
    fixTab: 'workspaces',
  };

  if (!capabilities.isDesktop) {
    return { ...base, status: 'skip', detailKey: 'diagnosticsDesktopToolsNotDesktop' };
  }

  if (!desktopTools || !isNonEmptyString(desktopTools.serverPath)) {
    return {
      ...base,
      status: 'warn',
      detailKey: 'diagnosticsDesktopToolsUnavailable',
      hintKey: 'diagnosticsDesktopToolsUnavailableHint',
    };
  }

  const rootCount = desktopTools.roots.length;
  if (rootCount === 0) {
    return {
      ...base,
      status: 'warn',
      detailKey: 'diagnosticsDesktopToolsNoRoots',
      hintKey: 'diagnosticsDesktopToolsNoRootsHint',
    };
  }

  return {
    ...base,
    status: 'ok',
    detailKey: 'diagnosticsDesktopToolsOk',
    detailParams: { count: rootCount },
  };
};

const summarize = (checks: DiagnosticCheck[]): DiagnosticReport => ({
  checks,
  okCount: checks.filter((check) => check.status === 'ok').length,
  warnCount: checks.filter((check) => check.status === 'warn').length,
  failCount: checks.filter((check) => check.status === 'fail').length,
  skipCount: checks.filter((check) => check.status === 'skip').length,
  completed: true,
});

/**
 * 跑一遍全部诊断。
 *
 * 只读：不修改任何设置、不发起 API 请求、不写库。
 */
export const runDiagnostics = async (settings: AppSettings): Promise<DiagnosticReport> => {
  const context: DiagnosticContext = {
    settings,
    desktopTools: getDesktopToolsConfig(),
    serverManagedApi: !!(
      settings.serverManagedApi ??
      (typeof window !== 'undefined' && window.__AMC_RUNTIME_CONFIG__?.serverManagedApi === true)
    ),
    serverAccessPasswordRequired: isServerAccessPasswordRequired(),
    capabilities: {
      isDesktop: typeof window !== 'undefined' && !!window.__AMC_DESKTOP__,
      hasIndexedDb: typeof indexedDB !== 'undefined',
      isSecureContext: typeof window === 'undefined' ? true : window.isSecureContext,
    },
  };

  const checks = await Promise.all([
    checkStorage(),
    Promise.resolve(checkApiConfiguration(context)),
    Promise.resolve(checkThirdPartyRouting(context)),
    Promise.resolve(checkEnvironment(context)),
    Promise.resolve(checkDesktopTools(context)),
  ]);

  return summarize(checks);
};
