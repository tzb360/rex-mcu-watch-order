# 漫威宇宙时间线 · Rex 本地版

个人 MCU 故事时间线观影导航。Rex 本机直接读取本人授权的 Trakt 观看进度，无需常驻 AWS 后端。

## 导入

https://raw.githubusercontent.com/tzb360/rex-mcu-watch-order/main/mcu-watch-order-local.js

标准时间线数据：

https://raw.githubusercontent.com/tzb360/rex-mcu-watch-order/main/timeline.seed.json

导入后在 Rex 添加模块，进入完整列表，使用“操作筛选”连接 Trakt，按提示在官方激活页确认，再选择“我已完成授权”。随后查看待看清单。每台设备独立授权。

完整可维护工程见 `mcu-watch-order-source.zip`；发布的 JS 本身也是明文完整源码。工程修改后执行 `npm run build:local`。`node scripts/publish-gh.mjs` 使用本机 `gh` 发布，并验证 Raw 文件内容。

## 当前验证状态

- 42 项自动化测试通过。
- Mac Rex 1.1 已真实验证本地存储读写、Trakt GET、设备码授权与令牌交换。
- 官方初始时间线已核实 81 个区段；外部媒体 ID 和分集数据由 API 初始化。
- 实际待看列表、HTTPS 导入和原生详情验收仍在继续，不代表全部验收通过。

## 数据与安全

故事顺序只依据漫威官方完整时间线。电影与分季剧集混合排列，逐集判断完成状态，最早未完成内容排第一。暂停进度与当前播放使用官方接口区分。只读 Trakt 观看记录，不删除或覆盖历史，不提供影视播放源。

公开文件不包含本人观看记录、Cookie、访问令牌或刷新令牌。Client ID 是公开的应用标识，不是账号凭据。

本地版授权令牌保存于 Rex `Widget.storage`；未确认它采用系统钥匙串，也未核实 Rex 备份是否包含模块存储。勿公开本人 Rex 完整备份。若要求令牌仅存服务端，工程中保留了可选后端方案。

官方来源：https://www.marvel.com/articles/movies/mcu-timeline-order-disney-plus

观看记录来源：https://trakt.tv/
