# 为 Human 与 Agent 提供独立的 acplus CLI 入口

## 问题

人擅长结构化分组、可读文本和实时终端交互；Agent 更适合一次发现能力、显式调用及轮次式 JSON 交互。单一入口混合两种契约，使帮助信息冗杂，也容易误入交互等待或误解执行结果。

## 结果

一个包提供 `acplus`（Human Interface）和 `acplus-ai`（Artificial Intelligence /
Agent Interface），共享业务能力但分别组织命令、帮助和交互。具体设计见
[CLI 交互设计](./CLI-INTERFACES.md)。

## 边界

- 共用配置、历史、权限和执行语义，不创建两套服务或业务实现。
- 本轮不新增完整 TUI，不改写 HTTP `/v2`、存储或 ACP 协议。
- 保留现有脚本兼容路径；破坏性移除须单独安排。

## 验收标准

- Human 入口提供分组帮助与可读交互，Agent 入口提供浅层命令与一次发现的完整紧凑帮助。
- Agent 入口始终非交互，输出可解析，失败、授权和执行恢复语义明确。
- 两个入口可交替操作同一 Session，保留既有业务不变量和兼容行为。
