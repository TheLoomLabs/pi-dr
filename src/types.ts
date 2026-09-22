/** Durable state for one research run. Mirrors the run/phase split that makes a research
 *  loop resumable: the run is persisted, the loop is disposable. */

export type RunStatus =
	| "planning"
	| "awaiting_approval"
	| "running"
	| "cancelling"
	| "cancelled"
	| "completed"
	| "failed";

export type Phase =
	| "planning"
	| "decision"
	| "search"
	| "fetch"
	| "audit"
	| "synthesis"
	| "recovery";

export type ActionKind = "search" | "fetch" | "finish";

export interface PlanStep {
	title: string;
	query: string;
}

export interface Plan {
	title: string;
	steps: PlanStep[];
}

/** Compact working memory the decision model rewrites every turn. Persisted, so a resumed
 *  run does not restart cold. Treated as untrusted on the way back in. */
export interface ResearchState {
	summary: string;
	gaps: string[];
	unsupportedClaims: string[];
	nextBridge: string;
}

export interface Source {
	title: string;
	url: string;
	snippet: string;
	stepPosition: number;
	fetchedAt: number;
}

export interface StepResult {
	action: Exclude<ActionKind, "finish">;
	input: string;
	sourceCount: number;
	sourceUrls: string[];
	/** Page text, kept only for fetches and scraped searches. */
	excerpt?: string;
	researchState?: ResearchState;
	error?: string;
}

export interface StepSnapshot {
	position: number;
	title: string;
	query: string;
	status: "running" | "completed" | "failed";
	result?: StepResult;
	startedAt: number;
	completedAt?: number;
}

export interface Budgets {
	maxSteps: number;
	maxSources: number;
	/** Sources one search may contribute. A broad query returns dozens of hits,
	 *  and without this the first step spends the whole run's budget on itself. */
	maxSourcesPerStep: number;
	/** Pages auto-fetched per search step. 0 = snippets only. */
	maxScrapePerStep: number;
	toolTimeoutMs: number;
}

export interface WebsitePolicy {
	allowedDomains: string[];
	blockedDomains: string[];
}

export interface AuditClaim {
	claim: string;
	sourceUrls: string[];
}

export interface Audit {
	thesis: string;
	outline: string[];
	supportedClaims: AuditClaim[];
	designInferences: string[];
	unsupportedPrecision: string[];
	contradictions: string[];
	missingDimensions: string[];
}

export interface Run {
	id: string;
	question: string;
	status: RunStatus;
	plan: Plan | null;
	/** Bumped on every plan write. Approval names the revision it saw. */
	planRevision: number;
	/** sha256 of the canonical plan. Approval names this too, so you cannot approve a plan
	 *  that changed under you between render and keypress. */
	planHash: string | null;
	steps: StepSnapshot[];
	sources: Source[];
	researchState: ResearchState | null;
	audit: Audit | null;
	report: string | null;
	error: string | null;
	budgets: Budgets;
	websitePolicy: WebsitePolicy;
	model: string;
	currentDate: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	/** Tokens the run's own model calls spent. Absent on runs recorded before
	 *  this was tracked. */
	usage?: {
		input: number;
		output: number;
		totalTokens: number;
		costTotal: number;
	};
}

export interface SearchHit {
	title: string;
	url: string;
	content: string;
	engine?: string;
	publishedDate?: string;
}
