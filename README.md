# 漫威宇宙时间线 · Rex 本地版

按漫威故事时间线查看最早待看的电影或电视剧分集。Mac Rex 直接读取本人授权的 Trakt 观看记录。

## 导入和刷新

- [Rex 导入地址](https://raw.githubusercontent.com/tzb360/rex-mcu-watch-order/main/mcu-watch-order-local.js)
- [公开时间线 JSON](https://raw.githubusercontent.com/tzb360/rex-mcu-watch-order/main/timeline.seed.json)

已有用户可在 Rex 的「设置 → 模块」更新同一模块，然后进入完整列表。列表中的「操作筛选 → 刷新时间线」会检查 JSON 更新，「立即同步观看记录」会按 Trakt 最近活动时间同步有变化的观看记录。新设备可通过同一菜单连接 Trakt。

## 0.2.6

- 随公开 JSON 发布 81 个区段的媒体标识、已播时间与分集数据。旧格式数据仍可分批核对并恢复进度。单个未核实条目等待复核。
- Rex 自动定期检查 HTTPS 数据，支持 ETag、手动刷新及上一次有效数据回退。手动刷新使用独立的请求地址以绕过旧的客户端响应缓存。更新公开 JSON 后无需重新安装。
- 卡片沿用 Rex 的 TMDB 原剧名、原简介与海报。Rex 负责向 Trakt 上报观看记录，模块只读最新记录。
- 已看电影和已看完的剧集区段自动隐藏，待看队列按故事顺序排列。观看记录通过 Trakt 最近活动时间增量检查。剧集同步显式请求 Trakt 的分季进度响应。
- Trakt 授权保留在 Rex 本机模块存储。公开 JSON 只包含媒体和时间线元数据。

## 发布

完整工程见 [源码包](https://github.com/tzb360/rex-mcu-watch-order/blob/main/mcu-watch-order-source.zip)。公开时间线源文件为 `data/timeline.public.json`。更新条目时保留稳定 ID，并更新版本与时间戳。运行 `npm run build:local`、`npm run check` 和 `npm test` 后，通过 `node scripts/publish-gh.mjs` 发布。

[漫威官方时间线](https://www.marvel.com/articles/movies/mcu-timeline-order-disney-plus) · [Trakt](https://trakt.tv/)
