/**
 * What `trail check` reports: one finding per changed file a learning, a
 * skill or a takeaway bears on, saying whether the change goes against it or
 * follows it.
 */
export interface CheckFinding {
  file: string;
  line?: number;
  verdict: "conflict" | "follows";
  summary: string;
  source: { kind: string; title?: string; author?: string; date?: string; path?: string; quote?: string; name?: string; version?: number };
}

export interface CheckResult {
  /** Changed files checked. */
  files: number;
  /** Learnings checked against. */
  notes: number;
  /** Skills checked against. */
  skills: number;
  findings: CheckFinding[];
}
