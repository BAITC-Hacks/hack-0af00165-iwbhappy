import { randomUUID } from "node:crypto";
import { createProposal, matchSpecRows } from "@/lib/db";
import { describeExtract, extractFromImage } from "@/lib/llm/vision";
import { parseSpecFile } from "@/lib/spec-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SIZE = 5 * 1024 * 1024;
const EXTENSIONS = new Set(["xlsx", "xlsm", "csv", "tsv", "txt", "png", "jpg", "jpeg", "webp"]);
const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
};

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("Не удалось прочитать загруженный файл.", 400);
  }

  const file = form.get("file");
  const sessionId = form.get("sessionId");
  if (!(file instanceof File) || typeof sessionId !== "string" || !sessionId.trim()) {
    return jsonError("Нужны файл и идентификатор сессии.", 400);
  }
  if (file.size > MAX_SIZE) return jsonError("Файл слишком большой: максимум 5 МБ.", 413);

  const extension = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!EXTENSIONS.has(extension)) {
    return jsonError("Поддерживаются XLSX, XLSM, CSV, TSV, TXT, PNG, JPG, JPEG и WEBP.", 415);
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    if (extension in IMAGE_MIME) {
      const mime = IMAGE_MIME[extension];
      const extract = await extractFromImage(randomUUID(), `data:${mime};base64,${bytes.toString("base64")}`);
      return Response.json({ kind: "photo", extract, message: describeExtract(extract) });
    }

    const parsed = parseSpecFile(file.name, bytes);
    if (!parsed.ok) return jsonError(parsed.error ?? "Не удалось разобрать спецификацию.", 422);
    const { matched, unmatched } = await matchSpecRows(parsed.rows);
    if (matched.length === 0) {
      return Response.json({ kind: "spec", matched, unmatched, skipped: parsed.skipped });
    }

    const proposal = await createProposal(
      sessionId.trim(),
      matched.map(({ sku, qty }) => ({ sku, qty })),
    );
    return Response.json({
      kind: "spec", proposalId: proposal.id, matched, unmatched, skipped: parsed.skipped,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось обработать файл.", 500);
  }
}
