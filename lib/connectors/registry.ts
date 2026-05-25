/**
 * Connector registry — static, code-defined catalogue of integration connectors.
 *
 * Each ConnectorDef declares:
 *   id        — stable key (used in connector_accounts.connector_id and step configs)
 *   version   — contract version; runs pin the version they were built against
 *   name      — display name
 *   auth      — 'oauth2' | 'api_key' | 'none'
 *   actions   — things a workflow step can invoke
 *   triggers  — events that can start a workflow (for future trigger support)
 *   scopes    — OAuth scopes to request (empty for non-oauth)
 *
 * Adding a connector = add a new ConnectorDef here + a handler file.
 * HTTP ships first as the universal no-auth escape hatch.
 */

import { z } from "zod";

export type AuthType = "oauth2" | "api_key" | "none";

export interface ActionDef {
  id: string;
  description: string;
  inputSchema: z.ZodTypeAny;
}

export interface TriggerDef {
  id: string;
  description: string;
}

export interface ConnectorDef {
  id: string;
  version: number;
  name: string;
  auth: AuthType;
  scopes: string[];
  actions: ActionDef[];
  triggers: TriggerDef[];
  /** OAuth2 authorization URL template (undefined for non-oauth2) */
  authUrl?: string;
  /** OAuth2 token exchange URL (undefined for non-oauth2) */
  tokenUrl?: string;
}

// ---------------------------------------------------------------------------
// Action input schemas
// ---------------------------------------------------------------------------

const HttpActionSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeout_ms: z.number().int().min(100).max(30_000).optional(),
});

const GmailSendSchema = z.object({
  to: z.array(z.string().email()).min(1),
  subject: z.string().min(1),
  body: z.string(),
  html: z.boolean().optional().default(false),
});

const GmailListMessagesSchema = z.object({
  query: z.string().optional(),
  max_results: z.number().int().min(1).max(50).optional().default(10),
});

const GmailGetMessageSchema = z.object({
  message_id: z.string().min(1),
});

const SlackPostMessageSchema = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
  blocks: z.array(z.unknown()).optional(),
});

const SlackListChannelsSchema = z.object({
  limit: z.number().int().min(1).max(200).optional().default(50),
});

const SheetsAppendRowSchema = z.object({
  spreadsheet_id: z.string().min(1),
  range: z.string().min(1),
  values: z.array(z.array(z.unknown())).min(1),
});

const SheetsGetValuesSchema = z.object({
  spreadsheet_id: z.string().min(1),
  range: z.string().min(1),
});

const SheetsClearValuesSchema = z.object({
  spreadsheet_id: z.string().min(1),
  range: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Connector definitions
// ---------------------------------------------------------------------------

export const CONNECTORS: ConnectorDef[] = [
  // ── HTTP (no auth — universal escape hatch, ship first) ──────────────────
  {
    id: "http",
    version: 1,
    name: "HTTP / Webhook",
    auth: "none",
    scopes: [],
    actions: [
      {
        id: "send_request",
        description: "Send an HTTP request to any URL",
        inputSchema: HttpActionSchema,
      },
    ],
    triggers: [],
  },

  // ── Gmail ─────────────────────────────────────────────────────────────────
  {
    id: "gmail",
    version: 1,
    name: "Gmail",
    auth: "oauth2",
    scopes: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    actions: [
      {
        id: "send_email",
        description: "Send an email from the connected Gmail account",
        inputSchema: GmailSendSchema,
      },
      {
        id: "list_messages",
        description: "List recent messages matching a query",
        inputSchema: GmailListMessagesSchema,
      },
      {
        id: "get_message",
        description: "Fetch a single message by ID",
        inputSchema: GmailGetMessageSchema,
      },
    ],
    triggers: [
      { id: "new_email", description: "Triggered when a new email arrives" },
    ],
  },

  // ── Slack ─────────────────────────────────────────────────────────────────
  {
    id: "slack",
    version: 1,
    name: "Slack",
    auth: "oauth2",
    scopes: ["chat:write", "channels:read", "channels:history"],
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    actions: [
      {
        id: "post_message",
        description: "Post a message to a Slack channel",
        inputSchema: SlackPostMessageSchema,
      },
      {
        id: "list_channels",
        description: "List public channels in the workspace",
        inputSchema: SlackListChannelsSchema,
      },
    ],
    triggers: [
      { id: "new_message", description: "Triggered when a new message is posted" },
    ],
  },

  // ── Google Sheets ─────────────────────────────────────────────────────────
  {
    id: "sheets",
    version: 1,
    name: "Google Sheets",
    auth: "oauth2",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    actions: [
      {
        id: "append_row",
        description: "Append one or more rows to a spreadsheet range",
        inputSchema: SheetsAppendRowSchema,
      },
      {
        id: "get_values",
        description: "Read values from a spreadsheet range",
        inputSchema: SheetsGetValuesSchema,
      },
      {
        id: "clear_values",
        description: "Clear values in a spreadsheet range",
        inputSchema: SheetsClearValuesSchema,
      },
    ],
    triggers: [],
  },
];

/** Look up a connector by id. Returns undefined if not found. */
export function getConnector(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

/** Validate action input against its declared Zod schema. Throws on invalid. */
export function validateActionInput(
  connectorId: string,
  actionId: string,
  input: unknown
): Record<string, unknown> {
  const connector = getConnector(connectorId);
  if (!connector) throw new Error(`connector: unknown connector '${connectorId}'`);
  const action = connector.actions.find((a) => a.id === actionId);
  if (!action) throw new Error(`connector: unknown action '${connectorId}.${actionId}'`);
  return action.inputSchema.parse(input) as Record<string, unknown>;
}
