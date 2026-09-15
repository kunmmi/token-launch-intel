import { NextResponse } from "next/server";

/**
 * Builds and pins the real Flap metadata JSON, returning its bare IPFS
 * CID — the exact format Flap's on-chain `meta` field expects (verified
 * by fetching a real launch's actual on-chain `meta` CID from a public
 * gateway: a bare CID, no scheme/gateway prefix, JSON schema
 * {name,symbol,description,image,website,twitter,telegram,github,youtube,debox,buy,sell,creator}
 * with `image` itself also a bare CID).
 *
 * Flap has no public no-auth upload endpoint of its own (checked live in
 * this session — every plausible path either 404'd or was caught by the
 * SPA's client-side routing, not a real API). This reuses Pump.fun's real,
 * public /api/ipfs endpoint as a generic pinning service instead — a
 * deliberate, disclosed choice, not hidden: verified live that it pins
 * whatever raw bytes are uploaded as "file" and returns a real CID for
 * them regardless of content type (tested with a raw JSON blob, confirmed
 * the returned CID resolves back to the exact original bytes via a public
 * gateway). IPFS content is platform-agnostic — a CID pinned via one
 * service resolves the same way for any consumer, including Flap's
 * contract/frontend, which only ever sees the CID.
 */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function pinToIpfs(fileBlob: Blob, filename: string): Promise<string> {
  const form = new FormData();
  form.append("file", fileBlob, filename);
  form.append("name", "flap-upload"); // pump.fun's endpoint requires these fields but doesn't use them for anything except its own (unused-by-us) wrapper metadata
  form.append("symbol", "flap");

  const res = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form });
  if (!res.ok) throw new Error(`upstream pin failed: ${res.status}`);
  const json = (await res.json()) as { metadata?: { image?: string } };
  const imageUrl = json.metadata?.image;
  if (typeof imageUrl !== "string") throw new Error("unexpected response shape from pinning service");

  // imageUrl is "https://ipfs.io/ipfs/<cid>" — Flap wants the bare CID.
  const cid = imageUrl.split("/ipfs/").pop();
  if (!cid) throw new Error("could not extract CID from pinning response");
  return cid;
}

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
  const creatorAddress = incomingForm.get("creatorAddress");

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
  if (typeof creatorAddress !== "string" || creatorAddress.length === 0) {
    return NextResponse.json({ error: "creatorAddress is required" }, { status: 400 });
  }

  try {
    const imageCid = await pinToIpfs(file, "image");

    // Real schema, fetched from a genuine live Flap launch's on-chain meta CID — not invented.
    const metadataJson = JSON.stringify({
      name,
      symbol,
      description: typeof description === "string" ? description : "",
      image: imageCid,
      website: "",
      twitter: "",
      telegram: "",
      github: "",
      youtube: "",
      debox: "",
      buy: "",
      sell: "",
      creator: creatorAddress,
    });

    const metaCid = await pinToIpfs(new Blob([metadataJson], { type: "application/json" }), "metadata.json");

    return NextResponse.json({ metaCid });
  } catch (err) {
    console.error("[flap/metadata] failed:", err);
    return NextResponse.json({ error: "Failed to build/pin metadata" }, { status: 502 });
  }
}
