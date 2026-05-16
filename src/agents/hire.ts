/**
 * Shared hire-an-agent logic.
 *
 * Used by:
 *   1. The chat `hire` tool — founder-driven hire through chat.
 *   2. Chief of Staff — autonomous hire when a target is persistently
 *      flagged (gated behind the AUTO_HIRE env var).
 *
 * Same DB writes, same shape, same downstream behavior. Only the
 * `hired_by` field differs.
 */

import { db } from "@/db/client";
import { agents, watches } from "@/db/schema";

export type HireTemplate = "watch" | "monitor" | "daily_report";

export interface HireSpec {
  merchant_id: string;
  name: string;
  role: string;
  template: HireTemplate;
  params: Record<string, unknown>;
  schedule?: string;
  /** 'founder' (chat) or 'chief_of_staff' (autonomous) */
  hired_by?: "founder" | "chief_of_staff" | "system";
  system_prompt?: string;
  declared_failure_modes?: string[];
}

export interface HireResult {
  agent_id: string;
  name: string;
  role: string;
  template: HireTemplate;
  status: string;
  was_new: boolean;
}

export async function hireAgent(spec: HireSpec): Promise<HireResult> {
  const hired_by = spec.hired_by ?? "founder";
  const schedule = spec.schedule ?? "0 7 * * *";

  const [a] = await db
    .insert(agents)
    .values({
      merchant_id: spec.merchant_id,
      name: spec.name,
      role: spec.role,
      trigger: spec.template === "watch" ? "event" : "cron",
      schedule,
      decision_template: spec.template,
      decision_params: spec.params as never,
      tools: ["metrics", "rows"] as never,
      system_prompt:
        spec.system_prompt ??
        `You are ${spec.name}, the ${spec.role}. You were hired by ${
          hired_by === "founder" ? "the founder through chat" : "the Chief of Staff because a target has been flagged across multiple runs"
        }.`,
      hired_by,
      declared_failure_modes: (spec.declared_failure_modes ?? [
        "Hired agents inherit the watch/monitor/daily_report template — no custom decision logic in v0",
      ]) as never,
    })
    .onConflictDoUpdate({
      target: [agents.merchant_id, agents.name],
      set: {
        role: spec.role,
        decision_template: spec.template,
        decision_params: spec.params as never,
        schedule,
        status: "active",
      },
    })
    .returning();

  // For watch templates, persist a row in `watches` so the runner picks it up.
  if (spec.template === "watch") {
    const p = spec.params as Record<string, string>;
    await db
      .insert(watches)
      .values({
        merchant_id: spec.merchant_id,
        agent_id: a.id,
        name: spec.name,
        condition_sql: p.sql ?? "SELECT 1",
        frequency: schedule,
        action_template: p.action_template ?? "alert",
      })
      .onConflictDoNothing();
  }

  return {
    agent_id: a.id,
    name: a.name,
    role: a.role,
    template: a.decision_template as HireTemplate,
    status: a.status,
    was_new: a.hired_at.getTime() > Date.now() - 5000,
  };
}
