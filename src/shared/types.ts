export type RuleMatchMode = 'AND' | 'OR';

export type HideMode = 'remove' | 'hide';

export type PageMode = 'wdlist' | 'detail' | 'other';

export interface HideRule {
  id: string;
  enabled: boolean;
  name?: string;
  companyKeywords: string[];
  titleKeywords: string[];
  jobRefs: string[];
  matchMode: RuleMatchMode;
  action: HideMode;
}

export interface Settings {
  rules: HideRule[];
  detailPageEnabled: boolean;
  debug: boolean;
}

export interface JobCandidate {
  anchor: HTMLAnchorElement;
  cardEl: HTMLElement;
  url: string;
  jobId: string | null;
  title: string | null;
  company: string | null;
}

export interface GetLastHiddenCountRequest {
  type: 'GET_LAST_HIDDEN_COUNT';
}

export interface GetPageHiddenItemsRequest {
  type: 'GET_PAGE_HIDDEN_ITEMS';
}

export interface UnhideJobRequest {
  type: 'UNHIDE_JOB';
  jobId: string;
}

export interface ApplyRulesNowRequest {
  type: 'APPLY_RULES_NOW';
}

export interface GetLastHiddenCountResponse {
  lastHiddenCount: number;
  route: string;
}

export interface HiddenJobItem {
  title: string | null;
  company: string | null;
  jobId: string | null;
  jobRole: string | null;
  url: string;
}

export interface GetPageHiddenItemsResponse {
  route: string;
  items: HiddenJobItem[];
}

export type RuntimeRequest =
  | GetLastHiddenCountRequest
  | GetPageHiddenItemsRequest
  | UnhideJobRequest
  | ApplyRulesNowRequest;

export interface RuleMatchResult {
  matched: boolean;
  action: HideMode | null;
  ruleId?: string;
}
