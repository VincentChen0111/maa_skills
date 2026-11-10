# 公共 JSON 读取

13 与 21 共享 `skills/maa-core/scripts/public-data.ts` 的 `readPublicJson(source, fetcher = fetch)`。source 为 repository（owner/name）、完整 commit 和规范相对 JSON file；返回 value 及 source 中的公开 URL、完整提交、文件、SHA-256、bytes、readAt。readAt 是本次读完的 UTC 时间，不是数据发布或扫描时间。

接口固定访问 raw.githubusercontent.com 的 HTTPS 完整提交地址，不执行内容、不跟重定向、不写本地文件。响应体在流式读取时限制为 64 MiB；原生 fetch 信号覆盖 20 秒的请求和响应读取。输入错误、网络/HTTP 失败、无效 JSON 和超限使用固定错误文本，不带原响应或异常消息。仅下载成功不说明业务字段正确；调用方还须验证游戏表结构和未知值。

公开导出函数测试使用本地 HTTP 服务或明确的网络边界替身，其余代码与数据处理均真实执行。覆盖固定路径与内容指纹、非法 ref/路径不发请求、重定向不跟随、错误不泄漏、声明及流式超限。沙箱限制 loopback fetch 时，同一组测试在沙箱外运行；不把网络权限错误算作产品失败。
