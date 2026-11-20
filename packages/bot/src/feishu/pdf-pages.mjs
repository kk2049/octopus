/**
 * Renders chosen pages of one PDF to JPEG files. Runs as a child process of
 * the lark-cli executor, so a pathological PDF or a crash in the native
 * canvas costs this process and never the Bot. Plain ESM so `node` runs it
 * without a loader, from source or a release tree.
 *
 * Usage: node pdf-pages.mjs <pdf> <out-dir> <width> <page>[,<page>…]
 * Prints one JSON line: { "pages": <count>, "rendered": [{ "page", "file", "width", "height" }] }.
 * Pages past the end are skipped, not an error.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const pdfjs = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const [pdf, outDir, widthArg, pageList] = process.argv.slice(2);
const width = Number(widthArg);
const wanted = String(pageList ?? "").split(",").map(Number);
if (!pdf || !outDir || !(width > 0) || !wanted.length || wanted.some((page) => !Number.isInteger(page) || page < 1)) {
  process.stderr.write("usage: pdf-pages.mjs <pdf> <out-dir> <width> <page>[,<page>...]\n");
  process.exit(2);
}

const task = getDocument({
  data: new Uint8Array(await readFile(pdf)),
  standardFontDataUrl: `${pdfjs}/standard_fonts/`,
  cMapUrl: `${pdfjs}/cmaps/`,
  cMapPacked: true,
  wasmUrl: `${pdfjs}/wasm/`,
  isEvalSupported: false,
  disableFontFace: true,
});
try {
  const doc = await task.promise;
  const rendered = [];
  for (const number of wanted) {
    if (number > doc.numPages) continue;
    const page = await doc.getPage(number);
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const file = `page-${String(number).padStart(3, "0")}.jpg`;
    await writeFile(path.join(outDir, file), await canvas.encode("jpeg", 85));
    rendered.push({ page: number, file, width: canvas.width, height: canvas.height });
    page.cleanup();
  }
  process.stdout.write(`${JSON.stringify({ pages: doc.numPages, rendered })}\n`);
} finally {
  await task.destroy();
}
