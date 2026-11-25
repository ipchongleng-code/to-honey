# Eating Manager

把网上的饮食方案落到每日三餐的健身饮食 App。

## 文件说明

| 文件 | 作用 | 能否公开 |
|---|---|---|
| `public/index.html` | 网页本体 | 公开 |
| `public/config.js` | 网页配置（识别接口地址） | 公开，**不能写密钥** |
| `server.js` | 后端：提供网页 + 拍照识别接口，替网页保管密钥 | 可以上传 GitHub |
| `api.env.example` | 密钥文件模板 | 可以上传 GitHub |
| `api.env` | **真正的密钥文件** | ❌ 绝对不能上传、不能发给别人 |
| `usage.csv` | 每次识别的耗时和 token 用量（运行后自动生成） | 不上传 |

## 在自己电脑上运行

1. 安装 Node.js（长期支持版 LTS）：https://nodejs.org
2. 把 `index.html` 放进 `public` 文件夹
3. 复制 `api.env.example`，改名为 `api.env`，用记事本打开，把 DeepSeek 的密钥粘贴到 `DEEPSEEK_API_KEY=` 后面（密钥在 https://platform.deepseek.com 创建，账户需要有余额）
4. 启动：
   - **Windows**：双击 `启动（Windows双击）.bat`，浏览器会自动打开
   - **Mac**：在这个文件夹打开终端，运行 `node --env-file=api.env server.js`，再用浏览器打开 http://localhost:8787

   `server.js` 是程序文件，不能直接双击打开；想看内容可以右键 →「打开方式」→「记事本」。

## 模型

默认使用 DeepSeek 的 `deepseek-flash`（DeepSeek 里能识别图片的模型），接口地址 `https://api.deepseek.com`。

以后要换成其他兼容 OpenAI 格式的平台，在 `api.env` 里加上下面三行即可，不用改代码（模型名以各平台控制台为准）：

```
LLM_API_KEY=该平台的密钥
LLM_BASE_URL=平台的 OpenAI 兼容接口地址
LLM_MODEL=模型名称
```
