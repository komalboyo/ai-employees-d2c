/**
 * The Agent contract.
 *
 * Every specialist (Aanya, Rishi, Meera, Karan, Chief of Staff) and
 * every founder-hired agent implements this interface. The contract
 * defines what's *shared* — trigger shape, run log structure, proposal
 * format, citation requirement, failure-mode declaration. Specialists
 * own their `decide()` function.
 *
 * Decisions are deterministic SQL. The LLM is only invoked for the
 * narrative copy on each proposal — so a 10k-merchant fleet costs us
 * one templated string per proposal, not one analytical chain-of-thought.
 */

export type AgentTriggerKind = "cron" | "event" | "threshold";

export interface AgentSpec {
  /** Stable agent name — also serves as the row identity in `agents`. */
  name: string;
  /** Human-facing role — read by Chief of Staff when assembling the brief. */
  role: string;
  trigger: AgentTriggerKind;
  /** cron expr, event name, or threshold spec — interpreted by the scheduler. */
  schedule: string;
  /** Which read tools this agent uses internally — mirrors the chat tool surface. */
  tools: readonly string[];
  /** System prompt used when LLM writes the narrative copy on a proposal. */
  systemPrompt: string;
  /** Authority cap. Proposals above this ₹-impact get flagged for human review. */
  authorityCapInr: number | null;
  /** Failure modes the agent itself declares — surface in every proposal. */
  declaredFailureModes: readonly string[];
  /** The deterministic core. Returns proposals + a structured reasoning log. */
  decide(ctx: AgentRunContext): Promise<AgentDecision>;
}

export interface AgentRunContext {
  merchant_id: string;
  /** Logical "now" — overridable for replay/grading. */
  now: Date;
  /** Earlier proposals visible in the run window — for cross-agent references. */
  recent_proposals?: PriorProposal[];
}

export interface PriorProposal {
  id: string;
  agent_name: string;
  action_type: string;
  target_entity: string;
  target_entity_id: string;
  expected_savings_inr: number;
  created_at: Date;
}

export interface AgentDecision {
  proposals: ProposalInput[];
  reasoning: Record<string, unknown>;
}

export interface ProposalInput {
  action_type: string;
  target_entity: string;
  target_entity_id: string;
  payload: Record<string, unknown>;
  expected_savings_inr: number;
  /** What outcome the agent expects if this proposal is approved. Graded later. */
  prediction: {
    metric: string;
    expected_change: number;
    window_days: number;
    direction: "decrease" | "increase";
  };
  confidence: number; // 0..1
  caveats: string[];
  /** UUIDs of source rows this proposal was computed from — citation backbone. */
  citation_row_ids: { table: string; id: string }[];
  /** Other proposal ids this one builds on or contradicts. Used by Chief of Staff. */
  references?: { proposal_id: string; relationship: "supports" | "contradicts" | "depends_on" }[];
  /** Narrative copy. May be filled by LLM later; falls back to templated text. */
  narrative?: string;
}
