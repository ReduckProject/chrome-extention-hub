# 任务占用协议（服务端 0.2.0）

一个 profile 只执行一项自动任务，该任务复用一个 tab。整批多图算一项任务；同 profile 的并行请求进入队列，实际串行执行。不同 profile 的队列独立，但桥接器不能确定它们是否登录同一账号。connections.scheduling 返回 activeTask、queue 和本地冷却时间，不包含 leaseId。

## 调用顺序

1. 查看连接和 accessPause，生成并保存本任务唯一 taskId（UUID），调用 `chatgpt_task({action:"acquire",profileId,taskId})`。没有 accessPause 才申请新任务；恢复自己的已占用任务可以按原 taskId 取回原 leaseId，这不会解除暂停。
2. state:queued 时按 retryAfterMs 等待并重复同一 acquire。服务端默认最早每 20 秒接受一次检查，初次申请后第 5 次仍不可用则返回 timed_out，移除队列项。过早查询不会推进次数或抢先获取。超过 120 秒未继续检查的队列项会在后续分配时过期。提前中断用 `task({action:"cancel",profileId,taskId})`，不重新申请规避超时。
3. state:active 后保存 leaseId。按主 Skill 的 4-tab 规则选择空闲页或新建一页。每次页面动作都传 leaseId，例如 `new_chat({tabKey,leaseId})`、`models({tabKey,leaseId})`、`send({tabKey,leaseId,prompt,requestId,expectedModel})`。首次动作绑定 tab；再操作其他 tab 返回 TASK_TAB_MISMATCH。不要使用另一个任务的 ID 或凭据。
4. `tabs({action:"new",count:1,profileId,leaseId})` 仅在当前清单明确且少于 4 个时可执行，返回 task.tabKey 和 openedByThisTask，随后等待首次观察就绪。创建超时／结果不确定时不能再开一页；读取现有清单，只有新增候选唯一时用 `task({action:"bind",profileId,leaseId,tabKey})` 确认归属，否则保留占用并报告。
5. 使用默认 status/result/wait 被动观察；完成后读取文字与图片，再检查实际结果。需要加载或保存时传 leaseId，例如 `result({runId,loadImages:true,leaseId})`、`download({runId,leaseId})`。拒绝回复也按原 run 处理，不把 completed 当作已保存。
6. 下一张／下一步继续复用同一 tab 和 leaseId。新聊天、模型操作、发送受 profile 冷却限制；PROFILE_COOLDOWN 的 retryAfterMs 是本地等待时长，返回时尚未下发页面命令。分段等待后再用原参数操作；已有 requestId 重查仍幂等，不因冷却换 ID。
7. 必要结果保存和要求的归档完成后，按 openedByThisTask 清理 tab：本任务新建的关闭，复用的保留。再 `task({action:"release",profileId,leaseId,resultsSaved:true})`。未确认的生成、草稿、创建结果或过期的页面观察会阻止正常释放，先检查原任务；不替用户停止生成。关闭工具失败时记录遗留 tab，在确认结果已保存、页面无新草稿或活动后仍可正常释放，并如实汇报。

MCP 未加载新工具或旧 schema 没有 leaseId 时，把同样的 JSON 写入 UTF-8 文件，在实际子项目目录运行 `node src/cli.mjs task --input <参数文件>`；其他动作替换方法名即可。使用与 MCP 相同的 CHATGPT_BRIDGE_RUNTIME。CLI 的报错 JSON 和 MCP 的 structuredContent 都包含 code、retryAfterMs 等信息。更新 MCP 服务不需要重载 Chrome 扩展。

## 中断与恢复

- 无可用 tab 等本地条件导致任务提前结束时，也要清理自己的占用：未产生需要保存的结果，或已有结果已处理，且没有未确认生成／草稿等阻塞时，正常 release；无法安全释放时保留 taskId、leaseId、runId 并明确汇报，不静默遗留占用。
- 服务重启保留 active 占用、队列、run、requestId 和发送时间；按原 taskId 恢复自己的任务。超过 5 分钟未活动的 activeTask 显示 overdue，仍不自动被其他任务接管。原任务负责核对状态并收尾。
- 升级前的未纳管 run，仅由其原任务通过 `task({action:"acquire",profileId,taskId,adoptRunId:原runId})` 建立占用。恢复旧 run 可以优先于等它结束的新任务；只绑定原 tab 和 run，不重新发送。
- 只有用户明确取消本任务时，才能 `task({action:"abandon",profileId,leaseId,confirmAbandon:true})` 放弃占用。它不关 tab、不清草稿、不停止生成、不把 unknown 改为失败或完成；当前仍在生成的页面继续阻止新任务。不能因排队慢就放弃或接管别的任务。
- accessPause 优先于队列与冷却。只有用户明确要求恢复才按主 Skill 的 access 流程检查并操作；解除本地暂停不是网站恢复证明，队列也不会自动发送任何提示词。

本机配置项为 connection.json 的 scheduling.minSubmissionIntervalMs（默认 120000）和 scheduling.postCompletionCooldownMs（默认 30000），修改后重启本机服务。不要打印包含认证密钥的完整配置，也不为通过一次失败提交临时降低保护间隔。
