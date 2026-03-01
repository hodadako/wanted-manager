import type { HideRule, Settings } from './types';

export const STORAGE_KEY = 'wanted_hider_settings_v1';

export const DEFAULT_SETTINGS: Settings = {
  rules: [],
  detailPageEnabled: false,
  debug: false
};

function hasRuntimeError(): string | null {
  return chrome.runtime.lastError?.message ?? null;
}

function choosePreferredSettings(syncSettings: Settings, localSettings: Settings): Settings {
  const syncScore =
    syncSettings.rules.length +
    (syncSettings.detailPageEnabled ? 1 : 0) +
    (syncSettings.debug ? 1 : 0);
  const localScore =
    localSettings.rules.length +
    (localSettings.detailPageEnabled ? 1 : 0) +
    (localSettings.debug ? 1 : 0);

  return localScore > syncScore ? localSettings : syncSettings;
}

function mergeWithDefaults(input?: Partial<Settings>): Settings {
  const rules = input?.rules;
  return {
    rules: Array.isArray(rules) ? rules : [],
    detailPageEnabled: Boolean(input?.detailPageEnabled),
    debug: Boolean(input?.debug)
  };
}

export function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (localResult) => {
      const localError = hasRuntimeError();
      const localSettings = mergeWithDefaults(
        localError ? undefined : (localResult[STORAGE_KEY] as Partial<Settings> | undefined)
      );

      chrome.storage.sync.get([STORAGE_KEY], (syncResult) => {
        const syncError = hasRuntimeError();
        if (syncError) {
          resolve(localSettings);
          return;
        }

        const syncSettings = mergeWithDefaults(syncResult[STORAGE_KEY] as Partial<Settings> | undefined);
        resolve(choosePreferredSettings(syncSettings, localSettings));
      });
    });
  });
}

export function saveSettings(next: Settings): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY]: next }, () => {
      const localError = hasRuntimeError();
      if (localError) {
        reject(new Error(localError));
        return;
      }

      // sync is best-effort replication. local is used as primary persistence.
      chrome.storage.sync.set({ [STORAGE_KEY]: next }, () => {
        resolve();
      });
    });
  });
}

export async function upsertRule(rule: HideRule): Promise<Settings> {
  const current = await getSettings();
  const idx = current.rules.findIndex((item) => item.id === rule.id);

  const rules = [...current.rules];
  if (idx >= 0) {
    rules[idx] = rule;
  } else {
    rules.push(rule);
  }

  const next = {
    ...current,
    rules
  };

  await saveSettings(next);
  return next;
}

export async function deleteRule(ruleId: string): Promise<Settings> {
  const current = await getSettings();
  const next = {
    ...current,
    rules: current.rules.filter((rule) => rule.id !== ruleId)
  };

  await saveSettings(next);
  return next;
}

export async function toggleRule(ruleId: string, enabled: boolean): Promise<Settings> {
  const current = await getSettings();
  const next = {
    ...current,
    rules: current.rules.map((rule) => {
      if (rule.id !== ruleId) {
        return rule;
      }

      return {
        ...rule,
        enabled
      };
    })
  };

  await saveSettings(next);
  return next;
}
