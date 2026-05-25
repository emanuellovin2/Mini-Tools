/**
 * Google Sheets connector handler — oauth2.
 * Actions: append_row, get_values, clear_values.
 */

export interface SheetsCredentials {
  access_token: string;
}

async function sheetsRequest(
  accessToken: string,
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets${path}`, {
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
    throw new Error(`sheets: ${res.status} ${err}`);
  }
  return res.json();
}

export async function executeSheetsAction(
  actionId: string,
  input: Record<string, unknown>,
  credentials: SheetsCredentials
): Promise<unknown> {
  switch (actionId) {
    case "append_row": {
      const { spreadsheet_id, range, values } = input as {
        spreadsheet_id: string;
        range: string;
        values: unknown[][];
      };
      const data = (await sheetsRequest(
        credentials.access_token,
        `/${spreadsheet_id}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
        { method: "POST", body: JSON.stringify({ values }) }
      )) as { updates?: { updatedRange: string; updatedRows: number; updatedCells: number } };
      return {
        updated_range: data.updates?.updatedRange ?? "",
        updated_rows: data.updates?.updatedRows ?? 0,
        updated_cells: data.updates?.updatedCells ?? 0,
      };
    }

    case "get_values": {
      const { spreadsheet_id, range } = input as {
        spreadsheet_id: string;
        range: string;
      };
      const data = (await sheetsRequest(
        credentials.access_token,
        `/${spreadsheet_id}/values/${encodeURIComponent(range)}`
      )) as { range: string; values?: unknown[][] };
      return { range: data.range, values: data.values ?? [] };
    }

    case "clear_values": {
      const { spreadsheet_id, range } = input as {
        spreadsheet_id: string;
        range: string;
      };
      const data = (await sheetsRequest(
        credentials.access_token,
        `/${spreadsheet_id}/values/${encodeURIComponent(range)}:clear`,
        { method: "POST", body: JSON.stringify({}) }
      )) as { clearedRange: string };
      return { cleared_range: data.clearedRange };
    }

    default:
      throw new Error(`sheets connector: unknown action '${actionId}'`);
  }
}
