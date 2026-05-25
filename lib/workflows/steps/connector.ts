/**
 * Connector step — invokes a registered connector action on behalf of the workflow.
 *
 * Config:
 *   {
 *     "connector_id":  "gmail",              // registry connector id
 *     "action":        "send_email",          // action declared in registry
 *     "account_id":    "uuid",               // connector_accounts.id
 *     "input_mapping": { "to": ["{{trigger.email}}"], "subject": "{{prior.subject}}" },
 *     "meter_id":      "uuid"               // optional per-step metering
 *   }
 *
 * Input templates are expanded via the transform engine before dispatch.
 * Failures surface as step errors — the run can be retried (resumable).
 */

import { expandTemplate, applyMapping } from "./transform";
import { runConnectorAction } from "@/lib/services/connectors";
import { recordUsage } from "@/lib/services/usage";

export interface ConnectorConfig {
  connector_id: string;
  action: string;
  account_id: string;
  /** Mapping of action input fields, supporting {{path}} templates */
  input_mapping?: Record<string, unknown>;
  meter_id?: string | null;
}

export interface ConnectorInput {
  context: Record<string, unknown>;
  ownerOrgId: string;
  buyerId: string;
  runId: string;
  stepKey: string;
}

export interface ConnectorOutput {
  connector_id: string;
  action: string;
  result: unknown;
}

export async function runConnectorStep(
  config: ConnectorConfig,
  input: ConnectorInput
): Promise<ConnectorOutput> {
  if (!config.connector_id) throw new Error("connector step: connector_id is required");
  if (!config.action) throw new Error("connector step: action is required");
  if (!config.account_id) throw new Error("connector step: account_id is required");

  // Expand input_mapping templates against the run context
  const rawInput = config.input_mapping
    ? applyMapping(config.input_mapping, input.context)
    : {};

  const result = await runConnectorAction(config.account_id, config.action, rawInput);

  // Optional per-step usage metering
  if (config.meter_id) {
    await recordUsage({
      meterId: config.meter_id,
      buyerId: input.buyerId,
      quantity: 1,
      idempotencyKey: `workflow_connector_step:${input.runId}:${input.stepKey}`,
      actorOrgId: input.ownerOrgId,
    }).catch((err) => {
      console.error(
        JSON.stringify({
          event: "workflow.connector_step.usage_record_failed",
          error: String(err),
        })
      );
    });
  }

  return { connector_id: config.connector_id, action: config.action, result };
}

// Re-export expandTemplate so callers can use it for ad-hoc template expansion
export { expandTemplate };
