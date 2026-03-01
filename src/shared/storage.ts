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
    chrome.storage.sync.get([STORAGE_KEY], (result) => {
      const syncError = hasRuntimeError();
      if (!syncError) {
        const maybeSettings = result[STORAGE_KEY] as Partial<Settings> | undefined;
        resolve(mergeWithDefaults(maybeSettings));
        return;
      }

      chrome.storage.local.get([STORAGE_KEY], (localResult) => {
        const maybeLocalSettings = localResult[STORAGE_KEY] as Partial<Settings> | undefined;
        resolve(mergeWithDefaults(maybeLocalSettings));
      });
    });
  });
}

export function saveSettings(next: Settings): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [STORAGE_KEY]: next }, () => {
      const syncError = hasRuntimeError();
      if (!syncError) {
        chrome.storage.local.set({ [STORAGE_KEY]: next }, () => {
          resolve();
        });
        return;
      }

      chrome.storage.local.set({ [STORAGE_KEY]: next }, () => {
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
