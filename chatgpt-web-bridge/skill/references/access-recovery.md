# 限流等待与继续执行（服务 0.2.2 / adapter 49）

访问频繁是执行中的等待状态。不要因此结束任务、要求用户再次说“继续”、释放 task lease 或丢弃后续提示词。用户取消、任务完成，或出现需要人工处理的登录/验证码等问题时，才按相应原因收尾或报告。

## 必须保留并继续的流程

1. 每个步骤开始前，保留批次全部提示词、当前位置、原始参数及 taskId、leaseId、tabKey、runId、requestId。任何动作返回 state:waiting_for_access、taskContinues:true 或 accessPause 时，保留当前步骤，不递增批次序号；这不是一次执行失败。result 同时返回缓存正文或图片信息时，已有结果仍保留。
2. 使用 `chatgpt_access({action:"wait",profileId,timeoutMs:25000})` 持续有界等待。一次超时只表示仍在等待；继续等待，不发送“无法执行，请恢复后告诉我”之类结束回复。工具返回 accessPause:null 才回到原步骤。工具未支持 wait 时，把参数写入 UTF-8 JSON，用同一服务 `node src/cli.mjs access --input <参数文件>`；也可按剩余时间分段等待（每段不超过 60 秒），然后查询 access 状态。不要用已完成 run 的 wait 即时返回循环等待限流。
3. 服务端从首次发现限制起等 300000 ms，到时自动读取当前页面，若旧限流弹窗仍显示，只确认它的“明白了/OK”等按钮，再读取页面。确认框消失只解除本地暂停，websiteRecoveryVerified:false 不表示网站已经证明解限。仍显示限制、断连或无法取得新鲜观察时继续等待；新的失败检查会安排下一个 5 分钟截止时间，不密集重试。
4. accessPause:null 后必须继续本任务。尚未执行的步骤使用原参数再次调用；尚未提交的提示词仍用原 requestId。若 bridge 已把某条纯文本记录为“点击前失败”，服务会在恢复检查后自动清理自有草稿并用原 runId/requestId 重试，调用方不要再发第二条；已提交或结果不确定的请求先查原 runId/requestId，已经完成则读取并保存结果，然后按原计划处理剩余提示词；不能为了恢复而新建重复请求。new tab、原图下载等结果不确定时按各自收据/创建确认规则核验，不重复点击。
5. 恢复后再次遇到访问频繁，就回到第 2 步再等 5 分钟。限流等待不算生图失败，不消耗空闲页的轮询次数；服务会保持排队任务的有效时间，active lease 也不会因等待自动转交。整个批次完成并保存/归档后，再 release。

## 返回值与边界

- 被本地限流挡住的动作通过 HTTP 200 返回 waiting_for_access，MCP 不标 isError，CLI 正常退出。nextAction 给出 access.wait，continuation 标明原步骤与原 ID；实际页面动作尚未执行，不能把这个返回值当作模型选择、提交或下载成功。纯文本发送若已被记录为点击前失败，后台恢复器会接管这条原 run。
- 服务定时器负责解除暂停，并在每次恢复检查中对明确的纯文本点击前失败执行原 run 恢复；执行任务的 AI 负责保持批次并继续调用后续步骤。服务不会在后台盲目重放已提交或结果不确定的提示词，也不重启已被用户取消的任务。
- accessPause.autoResume:true、resumeRequired:false、retryAt、retryAfterMs、attempts/lastError 表示自动恢复进度；run 的 rate_limited 是等待恢复，普通 wait 对它保持有界等待。普通状态和正文查询仍可用，暂停期间不新聊天、不切模型、不加载或下载图片。
- 自动恢复只检查已有 DOM 和确认限流提示，不刷新会话、不请求私有会话接口。不要改成更短的限流间隔或换 tab 绕过等待。10 秒发送间隔、单 tab 占用、4 个 tab 复用阈值仍按任务协议执行。
