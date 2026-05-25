/**
 * Slack connector handler — oauth2.
 * Actions: post_message, list_channels.
 */

export interface SlackCredentials {
  access_token: string;
}

async function slackRequest(
  accessToken: string,
  method: string,
  body: Record<string, unknown> = {}
): Promise<unknown> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`slack: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`slack: ${data.error ?? "unknown error"}`);
  }
  return data;
}

export async function executeSlackAction(
  actionId: string,
  input: Record<string, unknown>,
  credentials: SlackCredentials
): Promise<unknown> {
  switch (actionId) {
    case "post_message": {
      const { channel, text, blocks } = input as {
        channel: string;
        text: string;
        blocks?: unknown[];
      };
      const payload: Record<string, unknown> = { channel, text };
      if (blocks?.length) payload.blocks = blocks;
      const data = (await slackRequest(credentials.access_token, "chat.postMessage", payload)) as {
        channel: string;
        ts: string;
        message?: { text: string };
      };
      return { channel: data.channel, ts: data.ts };
    }

    case "list_channels": {
      const { limit } = input as { limit?: number };
      const data = (await slackRequest(credentials.access_token, "conversations.list", {
        limit: limit ?? 50,
        exclude_archived: true,
      })) as {
        channels: Array<{ id: string; name: string; is_private: boolean; num_members: number }>;
      };
      return { channels: data.channels.map((c) => ({ id: c.id, name: c.name })) };
    }

    default:
      throw new Error(`slack connector: unknown action '${actionId}'`);
  }
}
