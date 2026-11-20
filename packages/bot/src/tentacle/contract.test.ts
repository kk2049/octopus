import { describe, expect, it } from "vitest";
import {
  TENTACLE_INVOKE_OPERATION,
  TENTACLE_READ_EVENT_OPERATION,
  TENTACLE_SUBJECT_ID,
} from "./contract.js";
import {
  TENTACLE_INVOKE_OPERATION as COMPAT_INVOKE_OPERATION,
  TENTACLE_READ_EVENT_OPERATION as COMPAT_READ_EVENT_OPERATION,
  TENTACLE_SUBJECT_ID as COMPAT_SUBJECT_ID,
} from "./catalog.js";

describe("Tentacle contract compatibility", () => {
  it("keeps the catalog exports on the neutral vocabulary", () => {
    expect({
      subject: COMPAT_SUBJECT_ID,
      invoke: COMPAT_INVOKE_OPERATION,
      readEvent: COMPAT_READ_EVENT_OPERATION,
    }).toEqual({
      subject: TENTACLE_SUBJECT_ID,
      invoke: TENTACLE_INVOKE_OPERATION,
      readEvent: TENTACLE_READ_EVENT_OPERATION,
    });
  });
});
