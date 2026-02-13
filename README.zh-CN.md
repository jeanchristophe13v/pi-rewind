# Pi Rewind

[English](./README.md)

一个给 [Pi](https://github.com/badlogic/pi-mono) coding agent 用的、**不依赖 Git** 的回溯扩展。

## 命令

- `/rewind`：回溯到任意 tree 节点，可选范围：
  - 对话 + 文件更改
  - 仅对话
  - 仅文件更改
- `/rewind-undo`：撤销上一次 rewind
- `/rewind-clean`：清理当前会话的快照文件

## 为什么做它

Pi 的 tree 可以在节点间导航，但对"回溯进度 / 撤销文件更改 / 撤销撤销"在非 Git 工作区不够直接。这个扩展就是为这个空缺设计的。

## 安装

```bash
pi install https://github.com/jeanchristophe13v/pi-rewind
```

仅安装到当前项目：
```bash
pi install https://github.com/jeanchristophe13v/pi-rewind -l
```

然后重启 Pi 或执行 `/reload`。

## 使用

- 执行 `/rewind`，在 tree 里选择目标节点，选择回溯范围
- 执行 `/rewind-undo`，撤销最近一次 rewind
- 执行 `/rewind-clean`，删除当前会话的快照文件

## 说明

- 不依赖 Git，可在无 `.git` 目录工作区使用
- 基于 Pi 的 `write` / `edit` 工具调用记录
- 快照目录为 `.pi/rewind/snapshots/<session-id>/`
- `/rewind` 与 `/rewind-undo` 需要交互模式

## License

MIT
