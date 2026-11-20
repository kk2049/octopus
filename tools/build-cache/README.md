# build-cache — 让「已经构建过的东西」不再重建

部署时用户等的那几分钟，绝大部分是 supervisor 在部署 checkout 里跑
`pnpm install` + `pnpm -r build`。但那次构建的输入，在这台机器上通常**早就被构建过**
——工单 worktree 里、落地暂存 worktree 里、上一次部署里。这个包让那次构建可以被复用。

## 用法

每个包的 `build` 脚本通过 wrapper 调用真实构建命令，命令本身一个字都不改：

```json
"build": "node ../../tools/build-cache/bin/octo-build.mjs -- 'tsup src/index.ts --format esm --dts --clean'"
```

- `--out <dir>`：声明产物目录，可重复；默认 `dist`。
- `--check-only`：这次构建不产出文件（例如 `tsc --noEmit`），缓存记录的是「这份内容已经通过校验」。
- `--` 之后的全部内容按原样交给 shell 执行，所以 `&&` 串联照旧工作。

## 缓存键

键是**包级**的，不是提交级的：

- 包目录内容（源码、配置、包内脚本；`dist/`、`node_modules/`、`*.tsbuildinfo` 等产物不算输入）
- 每个 workspace 依赖的指纹，**递归**——`tsup --dts` 读依赖的 `dist/*.d.ts`，Vite View 打包依赖的源码，依赖变了下游必须重建
- `pnpm-lock.yaml`（外部工具链与库版本）
- 根 `package.json` / `tsconfig.json` / `pnpm-workspace.yaml`
- Node 版本、构建命令本身、声明的产物目录、缓存格式版本

键里没有任何绝对路径，所以同一份内容在 ticket worktree、`_warm` 暂存树、部署 run tree
里得到同一个键。一次改动通常只让一两个包失效，其余全部命中。

## 缓存位置与开关

| 环境变量 | 作用 |
|---|---|
| `OCTO_BUILD_CACHE_DIR` | 缓存目录；默认 `${XDG_CACHE_HOME:-~/.cache}/octopus-build-cache` |
| `OCTO_BUILD_CACHE=0` | 完全关闭，等价于没有这层包装 |
| `OCTO_BUILD_CACHE=refresh` | 忽略命中，真实重建并覆盖记录（验证「缓存产物 == 冷构建产物」用） |

每个包按 LRU 保留最近 6 个条目。

## 边界

- **不是信任边界**。缓存目录由 bot OS 账号下的所有构建者共享，与
  `.claude/rules/devpipe-and-ops.md` 里「worktree 是工作目录不是沙箱」的既有事实一致。
  部署内容的来源永远是 Git，缓存只回答「这份字节完全相同的构建要不要再做一遍」。
- **字节精确**。产物按文件存取并逐个校验 SHA-256，可执行位保留；校验不过就丢弃条目、
  正常构建。Agent View release 按 digest 定址，产物漂移会换掉 release 身份，所以这里
  不接受「差不多」。
- **只会更慢一点，不会更脆**。缓存目录不可写、HOME 不存在、条目损坏、磁盘满——所有
  失败路径都退化成「照常构建」，没有一条会让构建失败。
