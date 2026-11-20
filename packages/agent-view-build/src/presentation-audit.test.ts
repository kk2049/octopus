import { expect, it } from "vitest";
import { presentationFailures, type PresentationMeasurement } from "./presentation-audit.js";

const text: PresentationMeasurement = {
  text: "Peer", fontSize: "14px", fontFamily: "sans-serif", lineHeight: "22px",
  left: 10, right: 80, centerY: 24, height: 32,
};

it("reports changed peers, geometric drift and missing coverage", () => {
  expect(presentationFailures([
    { name: "body", selector: "p", measurements: [text, { ...text, fontSize: "12px" }] },
    { name: "row", selector: "button", typography: false, sameHeight: true, align: "center-y",
      measurements: [text, { ...text, height: 24, centerY: 20 }] },
    { name: "missing", selector: ".missing", measurements: [] },
  ]).map(line => line.split(":")[0])).toEqual(["body.fontSize", "row.centerY", "row.height", "missing"]);
});

it("compares within roles, preserving heading/caption hierarchy and subpixel tolerance", () => {
  expect(presentationFailures([
    { name: "headings", selector: "h2", measurements: [text, text].map(row => ({ ...row, fontSize: "20px" })) },
    { name: "captions", selector: "small", align: "left", measurements: [text, { ...text, left: 10.5 }] },
  ])).toEqual([]);
});
