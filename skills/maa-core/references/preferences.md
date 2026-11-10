# 偏好接口

入口为 `maa-core` 目录的 `scripts/preferences.ts`，其他 skill 经相邻目录 `../maa-core/scripts/preferences.ts` 调用，需要 Node 24。命令的输入是标准输入中的 JSON 对象；把用户文本作为数据传入，不能拼成 shell 命令。共享代码可直接导入该文件的 `readSettings`、`updateSettings`、`appendPreference`、`startup`，没有第二份实现。

| 命令 | 输入 | 行为 |
| --- | --- | --- |
| `read` | `currentLanguage`，如 `zh-CN` 或 `en` | 只读。返回有效语言、是否问过语言、是否提示可设置、是否记录 MAA 目录与服务器，不输出本机目录 |
| `set` | 本次明确要改的设置字段 | 合并原设置，临时文件写完再原子改名，不影响未提交字段 |
| `append` | `text` 原话、`source` 出处，可选 `date` | 在私有目录的 `preferences.jsonl` 追加一条，旧条目不改写；默认日期为当下 UTC |

设置字段为 `language`（BCP 47 标签或 null）、`languageAsked`（布尔值）、`privateDirectory`（绝对目录）、`maaDirectory`（绝对目录或 null）、`server`（只能是 `CN`）。成功设置语言也会标记已问过；setup 问过但用户未选语言时可单独记录 `languageAsked: true`。

设置文件是用户目录下 `.maa-skills/config.json`；`MAA_SKILLS_HOME` 改变设置目录，同时作为未指定私有目录时的默认值。测试必须先指向临时目录。修改私有目录只改变后续偏好原话的目标，不迁移或删除旧目录中的记录。若用户想迁移数据，应单独明确其范围。

例如用户说「以后用英文」，先把 `{"language":"en"}` 交给 `set`，再把完整原话和本次对话出处交给 `append`。后续调用重新 `read`。追加时指定的日期使用完整 UTC ISO 格式，例如 `2026-11-10T06:00:00.000Z`，不提供则由脚本记录当前时间。

两个写命令在设置目录使用 `.preferences.lock` 互斥，防止同时更新丢失字段或交叉追加。它与 MAA 配置写入锁不同。遇占用不写入，返回 `preferences-busy`。持有进程已经退出，或互斥文件已存在超过 30 秒时，脚本自动接管：设置文件靠改名整体替换，原话是单次追加，中断的写入不会留下写到一半的内容，所以不需要人工核对，也不要手动删除这个文件。返回摘要只说明是否成功、改了哪些设置字段，不回显原话和目录。

失败时的 `error` 有三种：`preferences-busy`（没写，稍后重试）；`invalid-input`（输入不合法，什么都没写，改正后重试）；`preferences-check-required`（不保证未生效，不自动重做：`set` 用 `read` 核对后再决定是否补做；`append` 的结果 `read` 看不到，告诉用户这条原话可能没有记上，由用户决定是否重记）。
