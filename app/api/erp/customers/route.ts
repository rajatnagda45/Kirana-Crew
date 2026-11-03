import { NextResponse } from "next/server";

export async function GET() {
  const url = process.env.ERPNEXT_URL;
  const key = process.env.ERPNEXT_API_KEY;
  const secret = process.env.ERPNEXT_API_SECRET;

  if (!url || !key || !secret) {
    return NextResponse.json(
      { error: "ERPNext credentials not configured", customers: [] },
      { status: 503 },
    );
  }

  const base = url.startsWith("http") ? url : `https://${url}`;

  try {
    const res = await fetch(
      `${base}/api/resource/Customer?limit=100&fields=["name","customer_name","customer_group","customer_type","mobile_no","email_id","territory"]`,
      {
        headers: { Authorization: `token ${key}:${secret}` },
        next: { revalidate: 60 },
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `ERPNext ${res.status}: ${text.slice(0, 200)}`, customers: [] },
        { status: res.status },
      );
    }

    const data = (await res.json()) as { data?: unknown[] };
    return NextResponse.json({ customers: data.data ?? [], source: "erpnext_live" });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Network error", customers: [] },
      { status: 502 },
    );
  }
}
