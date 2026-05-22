import { NextResponse } from "next/server";
import { buildJwks } from "@/lib/auth/jwt";

export async function GET() {
  const jwks = await buildJwks();
  return NextResponse.json(jwks, {
    headers: {
      "Cache-Control": "public, max-age=3600",
    },
  });
}
