export const runtime = "edge";

export async function POST(req: Request) {
  const body = await req.text();
  console.warn("[CSP-REPORT]", body.slice(0, 2000));
  return new Response(null, { status: 204 });
}
