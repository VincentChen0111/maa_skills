# 12 森空岛账号接口来源核对

2026-11-13 只读核对公开资料，用于工单 [12](issues/12-skland-account-snapshot.md) 的读取器 `skills/maa-core/scripts/skland-account.ts`。没有真实 token，没有调用真实服务，也没有使用任何真实账号；下面的「已核对」只表示公开资料之间一致，不代表真实服务现在仍是这样。真实服务的行为一律记为未验证，缺什么见文末。

## 参考资料

三个项目都是 MIT 许可，只对照接口事实和思路，没有复制代码；读取器和测试替身都在本仓库独立编写，因此没有登记到[第三方声明](../THIRD_PARTY_NOTICES.md)。

| 项目 | 固定提交 | 读过的文件 |
| --- | --- | --- |
| [FrostN0v0/nonebot-plugin-skland](https://github.com/FrostN0v0/nonebot-plugin-skland/tree/b88a9a9cf931be0ae63ff839a101ebe5ff9aa7a7)（MIT，2026-11-09 提交） | `b88a9a9cf931be0ae63ff839a101ebe5ff9aa7a7` | `api/login.py`、`api/request.py`、`services/auth.py`、`schemas/binding.py`、`schemas/cred.py`、`schemas/arknights/card.py`、`schemas/arknights/models/` 下的 `chars.py`、`status.py`、`base.py`、`building.py`、`recruit.py` 和 `buildings/*.py`、`tests/test_auth.py` |
| [OriginiumLab/MAA-PRTS](https://github.com/OriginiumLab/MAA-PRTS/tree/305d3b6bdef58f06989586d59ac2fed2ba7e0f8f)（MIT） | `305d3b6bdef58f06989586d59ac2fed2ba7e0f8f` | `backend/core/skland.py`、`backend/core/updater.py` 的 `build_snapshot`、`backend/core/operbox.py` |
| [arkntools/arknights-toolbox](https://github.com/arkntools/arknights-toolbox/tree/721a15599eb132b37bb38edd0fdca615eb57fc4e)（MIT） | `721a15599eb132b37bb38edd0fdca615eb57fc4e` | `src/utils/skland.js`、`src/store/skland.js`、`src/views/Material/index.js` 里导入森空岛仓库的部分 |

官方表态：截至 2026-11-13 没有找到鹰角网络对第三方调用森空岛接口的公开表态；本次另做了一次网络检索，结果相同。

## 鉴权链、签名和刷新

| 事实 | 来源 | 结论 |
| --- | --- | --- |
| 用户 token 换授权码：`POST https://as.hypergryph.com/user/oauth2/v2/grant`，请求体 `appCode`（`4ca99fa6b56cc2ba`）、`token`、`type: 0`；成功时 `status` 为 0，授权码在 `data.code` | 三个项目一致 | 采用 |
| 授权码换 cred：`POST https://zonai.skland.com/api/v1/user/auth/generate_cred_by_code`，请求体 `code`、`kind: 1`；成功时 `code` 为 0，`data.cred` 和签名用的 `data.token` | nonebot、MAA-PRTS（arknights-toolbox 用 `/web/v1/` 同名路径） | 采用 `/api/v1/` |
| 签名：`sign = md5(hex(hmac_sha256(签名 token, 路径 + 查询串 + 时间戳 + {"platform","timestamp","dId","vName"} 的紧凑 JSON)))`，四个键按这个顺序；请求头带 `cred`、`sign`、`platform`、`timestamp`、`dId`、`vName` | 三个项目一致 | 采用 |
| 签名头的取值：nonebot 读取请求时 `platform`、`dId`、`vName` 都是空字符串，时间戳取当前秒数减 1；MAA-PRTS 和 arknights-toolbox 用 `platform` 3、`vName` 1.0.0，`dId` 分别是每次安装随机生成的值和数美设备指纹 | 三个项目 | 采用 nonebot 的空值：不生成、不伪造设备标识。真实服务是否接受未验证 |
| User-Agent：nonebot 和 MAA-PRTS 冒充森空岛安卓客户端；arknights-toolbox 在浏览器里请求数据接口，带的是浏览器自己的 UA | 三个项目 | 不冒充客户端，不设置 UA（用 Node 默认值）。真实服务是否接受未验证 |
| 刷新签名 token：`GET https://zonai.skland.com/api/v1/auth/refresh`，请求头带 `cred`，新签名 token 在 `data.token` | nonebot、arknights-toolbox | 采用 |
| 数据接口回复 `code` 10000 表示未授权（签名 token 失效，先刷新），10002 表示登录失效（用用户 token 重新换取） | nonebot `api/request.py`、`services/auth.py` 及其测试；arknights-toolbox `isCredTokenExpiredError`、`isNotLoginError` | 采用 |
| 两级刷新的次序：10000 先刷新签名 token 再重试；10002 用用户 token 重新换取再重试；重新换取后仍被拒即失败 | nonebot `tests/test_auth.py` 的轨迹 | 采用；本仓库测试 `tests/skland-account.test.ts` 用同样的轨迹核对 |
| 刷新签名 token 后仍是 10000 | nonebot 直接失败 | 不同：本实现再走一次第二级（用用户 token 重新换取） |
| 两级之后仍是 10000 或 10002 | 参考项目都当作登录或授权失败 | 不同：这时本次读取里换取接口刚接受过 token，问题在签名、时间或请求头，报告 `signature-rejected`，不记过期（第 1 轮审查修复：读取器时钟慢 10 分钟时，有效 token 曾被记成过期） |
| 换取失败时 `status` 的具体取值及含义 | 三个项目都只判断非 0，没有列出取值 | 未验证。读取器把格式正常、`status` 非 0 的换取回复当作对方明确拒绝 token；这是唯一会记过期的信号 |

## 读取接口和字段

| 账号事实 | 接口与字段 | 来源 | 结论 |
| --- | --- | --- | --- |
| 绑定的角色 | `GET /api/v1/game/player/binding`，`data.list[]` 里 `appCode` 为 `arknights` 的 `bindingList[]`（`uid`、`isDefault`、`isDelete` 等）和 `defaultUid` | nonebot `schemas/binding.py`、arknights-toolbox | 采用。角色号只在内存里用于下两个请求的 `uid` 参数，不写入快照 |
| 干员清单（精英化、等级、潜能） | `GET /api/v1/game/player/info?uid=…` 的 `chars[]`：`charId`、`evolvePhase`、`level`、`potentialRank`；名字在 `charInfoMap[charId].name` | nonebot `Character`、`CharInfo`；MAA-PRTS `build_snapshot` | 采用 |
| 潜能从几开始 | `potentialRank` 从 0 计数 | nonebot `potential_level = potentialRank + 1`；arknights-toolbox 显示 `潜${potentialRank + 1}` | 从 0 计数，转换时加 1 |
| 稀有度从几开始 | `charInfoMap[charId].rarity`，整数，从 0 计数 | 只有 MAA-PRTS（`int(rarity) + 1`）；nonebot 的 `CharInfo` 模型只取 `id`、`name` | 单一来源；按 0 计数加 1。不是 0–5 的整数时记未知（`invalid-rarity`），不猜 |
| 技能等级与专精 | `chars[].mainSkillLvl`；`chars[].skills[]` 的 `specializeLevel`（0–3） | nonebot、MAA-PRTS | 采用。按列表顺序记为第 1–3 技能：arknights-toolbox 和 MAA-PRTS 都按列表顺序显示，未用真实数据核对 |
| 模组 | `chars[].equip[]` 的 `id`、`level`、`locked` | nonebot `Equip`；MAA-PRTS 跳过 `locked` 的模组 | 采用。`locked` 为真记 0（未解锁），否则记 `level`；缺 `locked` 记未知 |
| 仓库物品 | `GET /api/v1/game/cultivate/player?uid=…` 的 `items[]`：`id`、`count`；`count` 可能是字符串 | 只有 arknights-toolbox（`Number(count)`）；`player/info` 的模型里没有物品 | 单一来源；采用。接口返回的物品范围未核对，未列出的物品仍是未知 |
| 龙门币 | 没有找到单独字段。游戏物品 ID `4001` 是龙门币（11 已核对，见[account 来源核对](account-sources.md)） | — | 只在养成接口的 `items` 里出现 `4001` 时采用，否则未知。是否会出现未验证 |
| 基建房间、驻员、心情 | `player/info` 的 `building`：`control`、`powers`、`manufactures`、`tradings`、`dormitories`、`meeting`、`hire`、`training`，各房间 `slotId`、`level`、`chars[]`（`charId`、`ap`、`lastApAddTime`）；训练室为 `trainee`、`trainer` | nonebot `buildings/*.py` | 采用。心情 `ap` 的满值 8,640,000（nonebot 以此判断已休满） |
| 当前理智、公招槽位计时 | `status.ap`、`recruit[]` | nonebot `Status`、`Recruit` | 字段存在，但不写进快照：验收第 3 条只要求干员、仓库、龙门币和基建，理智是随时变化的状态 |
| 理智药等药剂；凭证和各类券；逐关通关状态 | 三个项目里都没有找到 | — | 快照里写成无来源（`coverage` 的 `medicine`、`vouchers`、`stageClears` 为 `unavailable`、`no-source`）。`status.mainStageProgress` 只是主线进度，不推断逐关通关 |

和工单表的差别：技能专精字段在 `chars[].skills[]` 下；名字和稀有度在 `charInfoMap`，不在 `chars[]`；其余与工单表一致。

## 对时间的说明

参考项目都没有说明森空岛数据比游戏内滞后多久，本仓库也没有测过。快照的 `readAt` 是本次读取完成的时间，`sourceTimes` 两项都是 null（没有可核对的游戏内数据时间）；`status.storeTs` 含义未核实，不采用。基建心情另带 `lastApAddTime` 换算的时间，心情原始值是那个时间点的值。

## 未验证，缺什么

- 真实服务：需要维护者在本机用自己的 token 运行一次 `skland-account.ts inspect`，对照森空岛 App 的显示，核对换取、签名（空的 `platform`/`dId`/`vName`、不冒充客户端 UA）、两级刷新、各字段和计数起点。
- 拒绝信号：需要一个已失效的 token 的真实回复，确认换取失败时的 `status` 取值，以及 10000、10002 现在的含义。
- 养成接口的物品范围、是否返回 `4001`；技能列表顺序是否等于第 1–3 技能；锁定模组的 `level` 含义。
- 森空岛数据相对游戏内的滞后。
