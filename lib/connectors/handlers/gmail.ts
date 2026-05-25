/**
 * Gmail connector handler — oauth2.
 * Actions: send_email, list_messages, get_message.
 */

export interface GmailCredentials {
  access_token: string;
}

// ---------------------------------------------------------------------------
// send_email
// ---------------------------------------------------------------------------

export interface GmailSendInput {
  to: string[];
  subject: string;
  body: string;
  html?: boolean;
}

export interface GmailSendOutput {
  message_id: string;
  thread_id: string;
}

// ---------------------------------------------------------------------------
// list_messages
// ---------------------------------------------------------------------------

export interface GmailListInput {
  query?: string;
  max_results?: number;
}

export interface GmailListOutput {
  messages: Array<{ id: string; thread_id: string }>;
  result_size_estimate: number;
}

// ---------------------------------------------------------------------------
// get_message
// ---------------------------------------------------------------------------

export interface GmailGetInput {
  message_id: string;
}

export interface GmailGetOutput {
  id: string;
  thread_id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeRfc2822(to: string[], subject: string, body: string, html: boolean): string {
  const boundary = "====boundary====";
  const contentType = html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
  const raw = [
    `To: ${to.join(", ")}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${contentType}`,
    ``,
    body,
  ].join("\r\n");
  // Suppress unused variable warning for boundary
  void boundary;
  return Buffer.from(raw).toString("base64url");
}

async function gmailRequest(
  accessToken: string,
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`gmail: ${res.status} ${err}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function executeGmailAction(
  actionId: string,
  input: Record<string, unknown>,
  credentials: GmailCredentials
): Promise<unknown> {
  switch (actionId) {
    case "send_email": {
      const { to, subject, body, html } = input as unknown as GmailSendInput;
      const raw = makeRfc2822(to, subject, body, html ?? false);
      const data = (await gmailRequest(credentials.access_token, "/messages/send", {
        method: "POST",
        body: JSON.stringify({ raw }),
      })) as { id: string; threadId: string };
      return { message_id: data.id, thread_id: data.threadId } satisfies GmailSendOutput;
    }

    case "list_messages": {
      const { query, max_results } = input as GmailListInput;
      const params = new URLSearchParams({ maxResults: String(max_results ?? 10) });
      if (query) params.set("q", query);
      const data = (await gmailRequest(
        credentials.access_token,
        `/messages?${params}`
      )) as { messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number };
      return {
        messages: (data.messages ?? []).map((m) => ({ id: m.id, thread_id: m.threadId })),
        result_size_estimate: data.resultSizeEstimate ?? 0,
      } satisfies GmailListOutput;
    }

    case "get_message": {
      const { message_id } = input as unknown as GmailGetInput;
      const data = (await gmailRequest(
        credentials.access_token,
        `/messages/${message_id}?format=full`
      )) as {
        id: string;
        threadId: string;
        snippet: string;
        payload?: {
          headers?: Array<{ name: string; value: string }>;
          body?: { data?: string };
          parts?: Array<{ mimeType: string; body?: { data?: string } }>;
        };
      };

      const headers = data.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

      const bodyData =
        data.payload?.body?.data ??
        data.payload?.parts?.find((p) => p.mimeType === "text/plain")?.body?.data ??
        "";

      return {
        id: data.id,
        thread_id: data.threadId,
        subject: getHeader("Subject"),
        from: getHeader("From"),
        date: getHeader("Date"),
        snippet: data.snippet,
        body: bodyData ? Buffer.from(bodyData, "base64url").toString("utf-8") : "",
      } satisfies GmailGetOutput;
    }

    default:
      throw new Error(`gmail connector: unknown action '${actionId}'`);
  }
}
