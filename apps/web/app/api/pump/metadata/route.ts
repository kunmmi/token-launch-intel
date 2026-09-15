import { NextResponse } from "next/server";

/**
 * Proxies a creator's image + name/symbol/description to Pump.fun's real,
 * public metadata endpoint (verified live in this session: a real image
 * upload returned {"metadataUri": "https://ipfs.io/ipfs/..."} — a
 * genuinely IPFS-hosted metadata JSON, not a guess at the response
 * shape). This is the same endpoint pump.fun's own frontend uses; this
 * project doesn't run its own metadata pinning infrastructure.
 *
 * Proxied server-side rather than called directly from the browser to
 * keep the multipart handling and any future validation/size limits in
 * one place, and to avoid depending on pump.fun's CORS policy holding.
 */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB — generous for a token icon, small enough to reject someone accidentally attaching a huge file

export async function POST(req: Request) {
  let incomingForm: FormData;
  try {
    incomingForm = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = incomingForm.get("file");
  const name = incomingForm.get("name");
  const symbol = incomingForm.get("symbol");
  const description = incomingForm.get("description");

  if (!(file instanceof Blob) || file.size === 0) {
    return NextResponse.json({ error: "file (image) is required" }, { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: `file must be under ${MAX_IMAGE_BYTES / 1024 / 1024}MB` }, { status: 400 });
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (typeof symbol !== "string" || symbol.trim().length === 0) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }

  const outgoingForm = new FormData();
  outgoingForm.append("file", file, "image");
  outgoingForm.append("name", name);
  outgoingForm.append("symbol", symbol);
  outgoingForm.append("description", typeof description === "string" ? description : "");

  try {
    const res = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: outgoingForm });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[metadata] pump.fun/api/ipfs rejected upload:", res.status, text);
      return NextResponse.json({ error: "Metadata upload was rejected upstream" }, { status: 502 });
    }
    const json = (await res.json()) as { metadataUri?: string };
    if (typeof json.metadataUri !== "string") {
      return NextResponse.json({ error: "Unexpected response shape from metadata upload" }, { status: 502 });
    }
    return NextResponse.json({ metadataUri: json.metadataUri });
  } catch (err) {
    console.error("[metadata] failed to reach pump.fun/api/ipfs:", err);
    return NextResponse.json({ error: "Could not reach metadata upload service" }, { status: 502 });
  }
}
