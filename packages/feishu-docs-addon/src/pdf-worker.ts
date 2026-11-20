// PDF.js parses documents in this module worker; the card's frame never parses PDF bytes itself.
// @ts-expect-error PDF.js ships this runtime worker without a sibling declaration.
export { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
