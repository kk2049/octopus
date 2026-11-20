// Node test project setup: every fixture written under os.tmpdir() must be
// executable, or the run fails here instead of letting a fake CLI fall through
// to a real one on PATH. See fake-executables.mjs.
import { ensureExecTmpdir } from "./fake-executables.mjs";

ensureExecTmpdir();
