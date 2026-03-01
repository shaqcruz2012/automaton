/**
 * Experiment Types
 *
 * Type definitions for the experiment planning and tracking system.
 */

export type ExperimentStatus = "planned" | "running" | "completed" | "killed";
export type MvpType = "api" | "small_app" | "agent_service";

export interface MvpSpec {
  /** What the MVP accepts as input */
  input: string;
  /** What the MVP produces as output */
  output: string;
  /** Minimal UX description */
  ux: string;
  /** What constitutes success for this experiment */
  successCriteria: string;
  /** Estimated time to build (hours) */
  estimatedBuildHours?: number;
}

export interface Experiment {
  experimentId: string;
  nicheId: string;
  status: ExperimentStatus;
  mvpType: MvpType;
  mvpSpec: MvpSpec;
  budgetCredits: number;
  startTs?: string;
  endTs?: string;
  metricsJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PlanResult {
  planned: number;
  skipped: number;
  experiments: Experiment[];
}
