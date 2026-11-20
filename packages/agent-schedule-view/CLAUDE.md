# Agent Schedule View

`schedule.booking-grid/v1` 是只依赖 `app-data/v1` 的通用资源日历：投影给出日期、资源、小时范围与预约，
模块持有日期/时段/用途草稿并提交组合声明的 action。它不知道会议室、人员或权限；冲突与业务规则只在
App 的 action handler 判定。模块不读取身份、不接网络、不持久化权威状态。

投影形状：`{days:[{date,label}], resources:[{id,label}], start_hour, end_hour,
bookings:[{id,date,resource,start,end,title,by,tone}]}`。区间统一使用半开 `[start,end)`。

验证：`npx vitest run --project agent-schedule-view --maxWorkers=1` 与
`npx tsc --noEmit -p packages/agent-schedule-view/tsconfig.json`。
