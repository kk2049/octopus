import { createHash } from "node:crypto";
import {
  mkdirSync,
  readSync,
  readFileSync,
  existsSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { decode } from "./store.js";
import { ensureFreeSpace } from "../research-canvas/disk.js";
import type { AttachmentInfo } from "@claude-bot/research-docs-contract";
export class DocsAttachments {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  private dir(space: string, doc: string) {
    const p = join(
      this.root,
      createHash("sha256")
        .update(space + "\0" + doc)
        .digest("hex"),
    );
    mkdirSync(p, { recursive: true, mode: 0o700 });
    return p;
  }
  private metadata(path: string, value: unknown) {
    const tmp = path + ".next";
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    const dir = openSync(join(path, ".."), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  upload(space: string, owner: string, p: Record<string, string>) {
    const size = Number(p.size),
      offset = Number(p.offset),
      data = decode(p.data, 48000);
    // Any size: each call carries one bounded block and appends it to disk.
    if (
      !Number.isSafeInteger(size) ||
      size < 1 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + data.length > size ||
      data.length === 0
    )
      throw new Error("文件或分块大小无效");
    const id =
        "file_" +
        createHash("sha256")
          .update(owner + "\0" + p.request)
          .digest("hex")
          .slice(0, 32),
      dir = this.dir(space, p.doc),
      base = join(dir, id),
      metaPath = base + ".json";
    const meta: AttachmentInfo = {
      id,
      name: p.name.slice(0, 240),
      media: p.media,
      size,
    };
    if (existsSync(metaPath)) {
      const old = JSON.parse(readFileSync(metaPath, "utf8")) as AttachmentInfo;
      if (JSON.stringify(old) !== JSON.stringify(meta))
        throw new Error("上传 ID 已用于不同文件");
    } else {
      if (offset !== 0) throw new Error("请从首块上传");
      this.metadata(metaPath, meta);
    }
    const complete = existsSync(base),
      path = complete ? base : base + ".part",
      length = existsSync(path) ? statSync(path).size : 0;
    if (offset < length) {
      const before = Buffer.alloc(data.length),
        fd = openSync(path, "r");
      try {
        readSync(fd, before, 0, before.length, offset);
      } finally {
        closeSync(fd);
      }
      if (!before.equals(data)) throw new Error("重复分块内容不一致");
      return { file: meta, next: length, complete };
    }
    if (complete || offset !== length)
      throw new Error("上传偏移不匹配，请使用服务端回执继续");
    ensureFreeSpace(dir, data.length);
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const next = offset + data.length;
    if (next === size) {
      renameSync(path, base);
      const fd = openSync(dir, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return { file: meta, next, complete: next === size };
  }
  read(space: string, p: Record<string, string>) {
    if (!/^file_[a-f0-9]{32}$/.test(p.file)) throw new Error("附件 ID 无效");
    const dir = this.dir(space, p.doc),
      base = join(dir, p.file),
      offset = Number(p.offset);
    if (!existsSync(base)) throw new Error("附件尚未上传完成或不存在");
    const file = JSON.parse(
      readFileSync(base + ".json", "utf8"),
    ) as AttachmentInfo;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= file.size)
      throw new Error("附件偏移无效");
    // Bounded positional read; loading an audio block does not scan the entire file.
    const fd = openSync(base, "r");
    const bytes = Buffer.alloc(Math.min(32768, file.size - offset));
    try {
      readSync(fd, bytes, 0, bytes.length, offset);
    } finally {
      closeSync(fd);
    }
    return {
      file,
      data: bytes.toString("base64"),
      next: offset + bytes.length < file.size ? offset + bytes.length : null,
    };
  }
}
