# 任务占用协议（服务端 0.2.2）

每项任务独占并复用一个 tab，整批多图算一项任务。同 profile 的不同任务可以在不同 tab 并行，不能抢占同一 tab 或同一聊天。connections.scheduling 返回 lockScope:tab、activeTasks、queue、currentTabCount、reservedTabCount 和本地发送间隔，不包含 leaseId；当前页面和预留新页名额共同计入 4 个的复用阈值。

## 调用顺序

1. 查看连接和 accessPause，生成并保存唯一 taskId（UUID），调用 `chatgpt_task({action:"acquire",profileId,taskId})`。恢复自己的已占用任务可以按原 taskId 取回原 leaseId，不解除暂停。服务端会原子分配页面或名额：少于 4 个时默认预留一个新页名额；达到 4 个时认领可复用空闲页。也可在 acquire 中明确传 tabKey 认领该空闲页；冲突返回 TAB_UNAVAILABLE，不会抢占它。
2. 只有名额已满且无可复用空闲页才返回 state:queued，按 retryAfterMs 等待，默认 20 秒后用 status({refresh:true}) 读取新观测，再重复同一 acquire。初次申请后第 5 次检查仍不可用则 timed_out 并移除等待项，过早检查不推进次数。超过 120 秒未继续检查的等待项会在后续分配时过期。提前中断用 cancel，不更换 taskId 规避上限。queue 是等待记录，不要求整个 profile 顺序执行；有空闲页或新页名额即可分配。
3. state:active 后保存 leaseId；有 tabKey 就使用该页，openedByThisTask:false 表示复用。allocation:new_tab_slot 表示已预留名额，可 `tabs({action:"new",count:1,profileId,leaseId})` 创建一页，或 `task({action:"bind",profileId,leaseId,tabKey})` 绑定确认空闲的既有页。每次页面动作都传 leaseId，首次动作也会绑定目标页；操作其它 tab 返回 TASK_TAB_MISMATCH，抢占别人的 tab 返回 TAB_OCCUPIED。不要使用另一个任务的 ID 或凭据。
4. 创建前服务再次核对完整清单与其它预留名额，返回 task.tabKey 和 openedByThisTask 后等待首次观测就绪。若其它页面变化使数量达到 4，TAB_REUSE_REQUIRED 时保留本任务 leaseId，每 20 秒读一次当前清单，发现空闲页就 bind，名额恢复则重试原创建操作；包含已经等待的次数，初次之后总共最多 5 次，仍不可用则在无未确认操作的情况下 release 并中断汇报，不更换 taskId 重置次数。创建超时／结果不确定时不能再开一页；读取现有清单，只有新增候选唯一时用 bind 确认归属，否则保留占用并报告。待确认的新页不会被其它任务自动认领。
5. 用默认 status/result/wait 被动观察；完成后读取文字与图片，再检查结果。需要加载或保存时传 leaseId，例如 `result({runId,loadImages:true,leaseId})`、`download({runId,leaseId})`。拒绝回复也按原 run 处理，不把 completed 当作已保存。
6. 下一张／下一步继续复用同一 tab 和 leaseId。同 profile 的 send 共用 10 秒最短间隔；某 tab 回答结束后，该 tab 的新聊天、模型操作和下一次发送再等 10 秒。取两个截止时间较晚者，不叠加；不会等待其它 tab 完成回答。PROFILE_COOLDOWN 的 retryAfterMs 是本地等待时长，返回时未下发页面命令。等待后原参数重试；已有 requestId 重查仍幂等，不因冷却换 ID。
7. 必要结果保存和要求的归档完成后，调用 `task({action:"release",profileId,leaseId,resultsSaved:true})` 释放占用。未确认的生成、草稿、创建结果或过期页面观察会阻止正常释放，不替用户停止生成。

MCP 未加载新工具或旧 schema 没有 leaseId 时，把相同 JSON 写入 UTF-8 文件，在实际子项目目录运行 `node src/cli.mjs task --input <参数文件>`；其它动作替换方法名即可。使用与 MCP 相同的 CHATGPT_BRIDGE_RUNTIME。CLI 和 MCP 均返回 code、retryAfterMs 等错误信息。更新服务不需要重载 Chrome 扩展。

## 中断与恢复

- 提前结束任务时，未产生必要结果或结果已处理且没有未确认生成／草稿等阻塞，可正常 release；无法收尾时保留 taskId、leaseId、runId 并汇报，不静默遗留占用。
- 服务重启和从 0.2.0 升级保留任务、leaseId、队列、run、requestId 和发送时间。activeTasks 中超过 5 分钟未活动的任务显示 overdue，仍不自动交给别人；由原任务恢复并收尾。
- 升级前未纳管 run 仅由其原任务通过 acquire 的 adoptRunId 建立占用，只绑定原 tab 和 run，不重新发送。
- 只有用户明确取消本任务时，才可 `task({action:"abandon",profileId,leaseId,confirmAbandon:true})` 放弃占用。它不关 tab、不清草稿、不停止生成、不改变 unknown；仍在生成的页面只阻止该页复用，其它 tab 可继续。
- accessPause 作用于整个 profile，按 [限流恢复协议](access-recovery.md) 等待 5 分钟自动检查并继续原步骤；明确记录的纯文本点击前失败由 bridge 自动恢复原 run，其它已提交或不确定请求仍先查原 run，不盲目重发。不得因限流结束批次或丢弃后续提示词，等待不消耗排队轮询次数或导致排队过期。解除本地暂停不是网站恢复证明。

配置项 scheduling.minSubmissionIntervalMs（默认 10000）控制 profile 发送间隔，scheduling.postCompletionCooldownMs（默认 10000）控制对应 tab 完成后的等待。修改后重启服务，不打印含认证密钥的完整配置。
