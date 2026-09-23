import { randomUUID } from "node:crypto";
import { createProposal, matchSpecRows } from "@/lib/db";
import { describeExtract, extractFromImage, extractRowsFromPdf } from "@/lib/llm/vision";
import { parseSpecFile, specRowsFromExtract, type ParseResult } from "@/lib/spec-parse";
import { allow, clientIp, LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SIZE = 5 * 1024 * 1024;
const TABLES = new Set(["xlsx", "xlsm", "csv", "tsv", "txt", "docx"]);
// Старые форматы принимаем, чтобы вернуть понятный совет, а не «не поддерживается».
const LEGACY = new Set(["xls", "doc"]);
const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
};
const SUPPORTED = "XLSX, CSV, DOCX, PDF, PNG, JPG и WEBP";

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

/**
 * Единый путь для любой спецификации — таблицы, Word, PDF, фото накладной.
 * Предложение создаётся на сервере, корзина не меняется: подтверждение
 * обязательно и идёт через тот же /api/confirm, что и для одного товара.
 */
async function specResponse(sessionId: string, parsed: ParseResult, source: string) {
  if (!parsed.ok) return jsonError(parsed.error ?? "Не удалось разобрать спецификацию.", 422);
  const { matched, unmatched } = await matchSpecRows(parsed.rows);
  if (matched.length === 0) {
    return Response.json({ kind: "spec", source, matched, unmatched, skipped: parsed.skipped });
  }
  const proposal = await createProposal(sessionId, matched.map(({ sku, qty }) => ({ sku, qty })));
  return Response.json({
    kind: "spec", source, proposalId: proposal.id, matched, unmatched, skipped: parsed.skipped,
  });
}

export async function POST(req: Request) {
  const gate = allow(`upload:${clientIp(req)}`, LIMITS.uploadPerMinute, 60_000);
  if (!gate.ok) return jsonError(`Слишком много файлов подряд. Попробуйте через ${gate.retryAfterSec} с.`, 429);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("Не удалось прочитать загруженный файл.", 400);
  }

  const file = form.get("file");
  const rawSession = form.get("sessionId");
  if (!(file instanceof File) || typeof rawSession !== "string" || !rawSession.trim()) {
    return jsonError("Нужны файл и идентификатор сессии.", 400);
  }
  const sessionId = rawSession.trim();
  if (file.size > MAX_SIZE) return jsonError("Файл слишком большой: максимум 5 МБ.", 413);

  const extension = (file.name.split(".").pop() ?? "").toLowerCase();
  const known = TABLES.has(extension) || LEGACY.has(extension) || extension === "pdf" || extension in IMAGE_MIME;
  if (!known) return jsonError(`Поддерживаются ${SUPPORTED}.`, 415);

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const traceId = randomUUID();

    if (extension in IMAGE_MIME) {
      const mime = IMAGE_MIME[extension];
      const extract = await extractFromImage(traceId, `data:${mime};base64,${bytes.toString("base64")}`);
      // Сфотографированная накладная или спецификация — это не товар, а список.
      if (extract.docType === "document") {
        if (!extract.ok) return jsonError(extract.note ?? "Не удалось разобрать документ на фото.", 422);
        return specResponse(sessionId, specRowsFromExtract(extract.rows), "photo");
      }
      return Response.json({ kind: "photo", extract, message: describeExtract(extract) });
    }

    if (extension === "pdf") {
      const pdf = await extractRowsFromPdf(traceId, file.name, bytes);
      if (!pdf.ok) return jsonError(pdf.note ?? "Не удалось прочитать PDF.", 422);
      return specResponse(sessionId, specRowsFromExtract(pdf.rows), "pdf");
    }

    return specResponse(sessionId, parseSpecFile(file.name, bytes), extension);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось обработать файл.", 500);
  }
}
