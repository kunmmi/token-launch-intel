import { NextResponse } from "next/server";

/**
 * Pins a Pons launch's image and returns a real, hosted https URL — Pons's
 * TokenParams.logo field takes a plain URL directly (confirmed by decoding
 * a real, successful launchAndBuy transaction's calldata: its `logo` field
 * was `https://axiomtrading-v2.axiom-cdn.io/...webp`, a normal https URL,
 * not a bare IPFS CID like Flap's `meta` field). Unlike Pump/Flap, Pons has
 * no separate metadata JSON to pin — name/symbol/description/socials all
 * live directly in TokenParams — so this route only ever needs to host the
 * image.
 *
 * Reuses Pump.fun's real, public, no-auth /api/ipfs endpoint as a generic
 * pinning service, same disclosed choice as Flap's metadata route: Pons has
 * no public upload endpoint of its own, and IPFS content is
 * platform-agnostic — a CID pinned via one service resolves identically
 * for any consumer.
 */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function POST(req: Request) {
  let incomingForm: FormData;
  try {
    incomingForm = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = incomingForm.get("file");
  if (!(file instanceof Blob) || file.size === 0) {
    return NextResponse.json({ error: "file (image) is required" }, { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: `file must be under ${MAX_IMAGE_BYTES / 1024 / 1024}MB` }, { status: 400 });
  }

  try {
    const form = new FormData();
    form.append("file", file, "logo");
    form.append("name", "pons-upload"); // required by the upstream endpoint but unused for anything beyond its own unused-by-us wrapper metadata
    form.append("symbol", "pons");

    const res = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form });
    if (!res.ok) throw new Error(`upstream pin failed: ${res.status}`);
    const json = (await res.json()) as { metadata?: { image?: string } };
    const logoUrl = json.metadata?.image;
    if (typeof logoUrl !== "string") throw new Error("unexpected response shape from pinning service");

    return NextResponse.json({ logoUrl });
  } catch (err) {
    console.error("[pons/metadata] failed:", err);
    return NextResponse.json({ error: "Failed to upload/pin image" }, { status: 502 });
  }
}
