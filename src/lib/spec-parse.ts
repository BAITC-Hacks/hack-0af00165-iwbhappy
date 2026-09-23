import { inflateRawSync } from "node:zlib";

/**
 * Разбор спецификации из файла: CSV, TSV и XLSX.
 *
 * Без внешних библиотек намеренно. Готовый пакет для xlsx на npm тянет
 * известные уязвимости, а здесь мы парсим файл, который прислал кто угодно.
 * Формат .xlsx — это zip с XML внутри, и нужная его часть читается
 * средствами Node: zlib умеет inflateRaw, остальное — разбор заголовков.
 *
 * Мы не исполняем ничего из файла: ни формул, ни макросов, ни ссылок.
 * Берём только значения ячеек.
 */

export type SpecRow = { article: string; qty: number };

export type ParseResult = {
  ok: boolean;
  rows: SpecRow[];
  /** Сколько строк в файле оказалось непригодными. */
  skipped: number;
  error?: string;
};

const MAX_ROWS = 200;

// --------------------------------------------------------------------------
// ZIP: ровно столько, сколько нужно для .xlsx
// --------------------------------------------------------------------------

/** Читает одну запись из zip по имени. Возвращает null, если её нет. */
function readZipEntry(buf: Buffer, wanted: string): Buffer | null {
  // Идём от конца к началу: ищем End of Central Directory.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    if (name === wanted) {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return null; // другие методы сжатия в xlsx не встречаются
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// --------------------------------------------------------------------------
// XML: только значения ячеек
// --------------------------------------------------------------------------

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

function readSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.match(/<si\b[\s\S]*?<\/si>/g) ?? []) {
    // Текст может быть разбит на куски <t> внутри <r> — склеиваем.
    const parts = si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? [];
    out.push(unescapeXml(parts.map((t) => t.replace(/<[^>]+>/g, "")).join("")));
  }
  return out;
}

/** Разбирает лист в матрицу строк. */
function readSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];

  for (const rowXml of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
    const cells: string[] = [];
    for (const cellXml of rowXml.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const ref = /r="([A-Z]+)\d+"/.exec(cellXml)?.[1];
      const type = /t="([^"]+)"/.exec(cellXml)?.[1];

      let value = "";
      if (type === "inlineStr") {
        value = unescapeXml((cellXml.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? [])
          .map((t) => t.replace(/<[^>]+>/g, "")).join(""));
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] ?? "";
        value = type === "s" ? (shared[Number(v)] ?? "") : unescapeXml(v);
      }

      // Пустые ячейки в xlsx пропускаются, поэтому позицию берём из ссылки.
      const idx = ref ? ref.split("").reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1 : cells.length;
      while (cells.length < idx) cells.push("");
      cells[idx] = value.trim();
    }
    rows.push(cells);
  }
  return rows;
}

// --------------------------------------------------------------------------
// CSV / TSV
// --------------------------------------------------------------------------

function readDelimited(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  const sample = body.slice(0, 2000);
  const delim = sample.includes("\t") ? "\t" : (sample.match(/;/g)?.length ?? 0) > (sample.match(/,/g)?.length ?? 0) ? ";" : ",";

  const rows: string[][] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { cells.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

// --------------------------------------------------------------------------
// Матрица -> строки спецификации
// --------------------------------------------------------------------------

const ARTICLE_HEADERS = ["артикул", "код", "sku", "номенклатура", "позиция", "товар", "наименование"];
const QTY_HEADERS = ["кол", "количество", "шт", "qty", "amount", "объем", "объём"];

function toNumber(v: string): number | null {
  const n = Number(String(v).replace(/\s| /g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Находит колонки артикула и количества.
 * Сначала по заголовку, а если его нет — по содержимому: артикул это
 * колонка с буквенно-цифровыми кодами, количество — колонка с числами.
 */
function pickColumns(rows: string[][]): { article: number; qty: number; skipHeader: boolean } {
  const head = rows[0] ?? [];
  const lower = head.map((h) => h.toLowerCase());

  const byHeader = (list: string[]) => lower.findIndex((h) => h && list.some((k) => h.includes(k)));
  const aHead = byHeader(ARTICLE_HEADERS);
  const qHead = byHeader(QTY_HEADERS);
  if (aHead >= 0 && qHead >= 0) return { article: aHead, qty: qHead, skipHeader: true };

  const body = rows.slice(aHead >= 0 || qHead >= 0 ? 1 : 0, 30);
  const width = Math.max(...rows.map((r) => r.length), 0);

  let article = aHead;
  let qty = qHead;

  if (article < 0) {
    let best = -1, bestScore = 0;
    for (let c = 0; c < width; c++) {
      const score = body.filter((r) => /\d/.test(r[c] ?? "") && /[a-zа-яё\-_/]/i.test(r[c] ?? "")).length;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    article = best >= 0 ? best : 0;
  }
  if (qty < 0) {
    let best = -1, bestScore = 0;
    for (let c = 0; c < width; c++) {
      if (c === article) continue;
      const score = body.filter((r) => { const n = toNumber(r[c] ?? ""); return n !== null && n > 0 && n < 100_000; }).length;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    qty = best;
  }

  return { article, qty, skipHeader: aHead >= 0 || qHead >= 0 };
}

function toSpecRows(matrix: string[][]): ParseResult {
  const rows = matrix.filter((r) => r.some((c) => c && c.trim()));
  if (rows.length === 0) return { ok: false, rows: [], skipped: 0, error: "Файл пуст." };

  const { article, qty, skipHeader } = pickColumns(rows);
  const body = skipHeader ? rows.slice(1) : rows;

  const out: SpecRow[] = [];
  let skipped = 0;

  for (const r of body) {
    if (out.length >= MAX_ROWS) { skipped++; continue; }
    const a = (r[article] ?? "").trim();
    if (!a || a.length > 60) { skipped++; continue; }
    // Артикул должен содержать цифру — иначе это строка-заголовок или итог.
    if (!/\d/.test(a)) { skipped++; continue; }

    const n = qty >= 0 ? toNumber(r[qty] ?? "") : null;
    out.push({ article: a, qty: n !== null && n > 0 ? Math.min(Math.trunc(n), 999) : 1 });
  }

  if (out.length === 0) {
    return { ok: false, rows: [], skipped, error: "Не нашёл в файле ни одной строки с артикулом." };
  }
  return { ok: true, rows: out, skipped };
}

// --------------------------------------------------------------------------
// DOCX: таблицы, а если их нет — строки абзацев
// --------------------------------------------------------------------------

// Имя тега строго целиком: `<w:t` без проверки поймает и <w:tab/>, <w:tc>,
// <w:tr>, <w:tbl>; `<w:tr` — и <w:trPr>. Поэтому после имени — пробел или «>».
const W_TEXT = /<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:tab\/>/g;
const W_ROW = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
const W_CELL = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
const W_PARA = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

function wordText(xml: string): string {
  // <w:tab/> внутри абзаца — разделитель колонок, если таблицы нет.
  const parts = xml.match(W_TEXT) ?? [];
  return unescapeXml(parts.map((t) => (t === "<w:tab/>" ? "\t" : t.replace(/<[^>]+>/g, ""))).join("")).trim();
}

function readDocx(xml: string): string[][] {
  const rows: string[][] = [];
  for (const tr of xml.match(W_ROW) ?? []) {
    rows.push((tr.match(W_CELL) ?? []).map(wordText));
  }
  if (rows.length) return rows;

  // Таблиц нет: спецификация набрана строками «артикул<TAB>количество».
  const body = (xml.match(W_PARA) ?? []).map(wordText).filter(Boolean);
  return body.map((line) => line.split(/\t|\s{2,}|;/).map((c) => c.trim()));
}

// --------------------------------------------------------------------------

/** Строки спецификации, полученные не из таблицы, а от модели (PDF, фото). */
export function specRowsFromExtract(rows: Array<{ article?: unknown; qty?: unknown }>): ParseResult {
  const matrix = rows.map((r) => [String(r.article ?? ""), String(r.qty ?? "")]);
  if (!matrix.length) return { ok: false, rows: [], skipped: 0, error: "В документе не нашлось строк с артикулами." };
  return toSpecRows([["артикул", "количество"], ...matrix]);
}

export function parseSpecFile(name: string, buf: Buffer): ParseResult {
  const ext = (name.split(".").pop() ?? "").toLowerCase();

  try {
    if (ext === "xlsx" || ext === "xlsm") {
      const sharedXml = readZipEntry(buf, "xl/sharedStrings.xml");
      const sheetXml = readZipEntry(buf, "xl/worksheets/sheet1.xml");
      if (!sheetXml) {
        return { ok: false, rows: [], skipped: 0, error: "Не удалось прочитать первый лист книги." };
      }
      const shared = sharedXml ? readSharedStrings(sharedXml.toString("utf8")) : [];
      return toSpecRows(readSheet(sheetXml.toString("utf8"), shared));
    }

    if (ext === "docx") {
      const docXml = readZipEntry(buf, "word/document.xml");
      if (!docXml) return { ok: false, rows: [], skipped: 0, error: "Не удалось прочитать документ Word." };
      return toSpecRows(readDocx(docXml.toString("utf8")));
    }

    if (ext === "doc") {
      return {
        ok: false, rows: [], skipped: 0,
        error: "Старый формат .doc не поддерживается. Сохраните файл как .docx или .pdf.",
      };
    }

    if (ext === "csv" || ext === "tsv" || ext === "txt") {
      return toSpecRows(readDelimited(buf.toString("utf8")));
    }

    if (ext === "xls") {
      return {
        ok: false, rows: [], skipped: 0,
        error: "Старый формат .xls не поддерживается. Сохраните файл как .xlsx или .csv.",
      };
    }

    return { ok: false, rows: [], skipped: 0, error: `Формат .${ext} не поддерживается.` };
  } catch (e) {
    return { ok: false, rows: [], skipped: 0, error: `Файл не читается: ${(e as Error).message}` };
  }
}
