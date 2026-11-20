// The version-matched PDF.js handler initializes itself only in this Worker.
// @ts-expect-error PDF.js ships this runtime worker without a sibling declaration.
export { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";
