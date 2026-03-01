import type { HideRule, JobCandidate, RuleMatchResult } from './types';
import { extractJobId } from './selectors';

export function normalizeText(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isNumeric(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function normalizeJobRef(ref: string): { type: 'id' | 'text'; value: string } {
  const trimmed = ref.trim();
  if (!trimmed) {
    return { type: 'text', value: '' };
  }

  if (isNumeric(trimmed)) {
    return { type: 'id', value: trimmed };
  }

  const extractedId = extractJobId(trimmed);
  if (extractedId) {
    return { type: 'id', value: extractedId };
  }

  return { type: 'text', value: normalizeText(trimmed) };
}

function keywordMatch(source: string | null, keywords: string[]): boolean {
  const normalizedSource = normalizeText(source);
  if (!normalizedSource) {
    return false;
  }

  return keywords
    .map((keyword) => normalizeText(keyword))
    .filter(Boolean)
    .some((keyword) => normalizedSource.includes(keyword));
}

function jobRefMatch(candidate: JobCandidate, refs: string[]): boolean {
  const normalizedUrl = normalizeText(candidate.url);
  const candidateJobId = candidate.jobId;

  return refs
    .map(normalizeJobRef)
    .filter((entry) => Boolean(entry.value))
    .some((entry) => {
      if (entry.type === 'id') {
        return candidateJobId === entry.value;
      }

      return normalizedUrl.includes(entry.value);
    });
}

export function matchRule(candidate: JobCandidate, rule: HideRule): boolean {
  if (!rule.enabled) {
    return false;
  }

  const configuredChecks: boolean[] = [];

  const companyKeywords = rule.companyKeywords.map(normalizeText).filter(Boolean);
  if (companyKeywords.length > 0) {
    configuredChecks.push(keywordMatch(candidate.company, companyKeywords));
  }

  const titleKeywords = rule.titleKeywords.map(normalizeText).filter(Boolean);
  if (titleKeywords.length > 0) {
    configuredChecks.push(keywordMatch(candidate.title, titleKeywords));
  }

  const jobRefs = rule.jobRefs.map((entry) => entry.trim()).filter(Boolean);
  if (jobRefs.length > 0) {
    configuredChecks.push(jobRefMatch(candidate, jobRefs));
  }

  if (configuredChecks.length === 0) {
    return false;
  }

  if (rule.matchMode === 'AND') {
    return configuredChecks.every(Boolean);
  }

  return configuredChecks.some(Boolean);
}

export function matchAnyRule(candidate: JobCandidate, rules: HideRule[]): RuleMatchResult {
  for (const rule of rules) {
    if (matchRule(candidate, rule)) {
      return {
        matched: true,
        action: rule.action,
        ruleId: rule.id
      };
    }
  }

  return {
    matched: false,
    action: null
  };
}
