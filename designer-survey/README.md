# 装修设计师工作情况调研 · 在线问卷

移动端优先的问卷（适配微信内置浏览器）+ 带密码的管理后台。

- 技术栈：Node.js 22 + Express + Node 内置 SQLite（`node:sqlite`，无需编译原生模块）+ ExcelJS
- 前端为纯 HTML/CSS/JS，不加载任何外部 CDN 或字体，大陆网络下没有资源会被墙
- 数据存在一个 SQLite 文件里：`data/survey.sqlite`

```
designer-survey/
├── config/questions.json   ← 题目配置（改题只改这里）
├── server.js               ← 服务端入口
├── lib/                    ← 存储、校验、导出
├── public/                 ← 填写页 index.html、后台 admin.html
└── .env.example            ← 环境变量模板
```

## 本地运行

需要 Node.js **22.13 或更高**（`node -v` 查看；macOS 可 `brew install node@22`，或去 nodejs.org 下载）。

```bash
cd designer-survey
npm install              # 国内慢可加 --registry=https://registry.npmmirror.com
cp .env.example .env     # 然后编辑 .env，至少把 ADMIN_PASSWORD 改掉
npm start
```

- 填写页：http://localhost:3000
- 后台：http://localhost:3000/admin（用 `.env` 里的 ADMIN_PASSWORD 登录）

手机想在同一 Wi-Fi 下试：把 `localhost` 换成电脑的局域网 IP，如 `http://192.168.1.23:3000`。

### 自测时重新填写

提交后本机会记住「已提交」并一直显示感谢页（防重复提交）。自己测试想再填一遍，在链接后加 `?reset=1` 打开即可。测试数据可以在后台「提交列表 → 点开 → 删除这份提交」清掉。

## 修改题目

只改 `config/questions.json`，不用碰页面代码；**服务端会自动读取最新配置，无需重启**。改完可运行 `npm run check` 检查格式并列出所有题目。

```jsonc
{
  "id": "q7",                       // 唯一 id，数据按它存储；已有数据后不要改
  "title": "客户主要从哪里来",
  "type": "multi",                  // single 单选 / multi 多选 / text 单行文本 / textarea 多行文本
  "required": true,                 // false = 选填
  "maxSelect": 3,                   // 多选上限（可省略）
  "options": [
    "公司派单",
    { "label": "其他", "input": true },       // 选中后出现文本框
    { "label": "没用过", "exclusive": true }   // 互斥项：选中后取消并禁用其他项
  ]
}
```

- 题号按顺序自动生成，增删题目后编号自动更新
- 分组（A–E）在 `sections` 里，标题、说明、感谢页文案在文件顶部
- 已有数据后再改选项文字：旧提交仍保留原文字，统计里旧选项会单独列出
- 如果是大改版，建议把顶部 `id` 改成新值（如 `designer-survey-v2`），这样之前在本机暂存过的人不会被旧草稿干扰

## 修改后台密码

后台密码来自环境变量 `ADMIN_PASSWORD`：

- 本地：改 `.env` 里的 `ADMIN_PASSWORD`，然后重启 `npm start`
- 服务器（pm2）：改服务器上的 `.env` 后执行 `pm2 restart survey`

改密码后，已登录的后台会话会自动失效。建议同时设置 `SESSION_SECRET` 为一串随机字符。

## 数据说明

每份提交保存：提交 ID、提交时间、称呼、每题答案（单选为字符串、多选为数组）、「其他」填写的内容（单独字段）、填写用时（只计页面可见时间，秒）、设备 UA。

- 后台「选项统计」：每道选择题各选项的人数与占比（占比 = 选该项人数 ÷ 该题作答人数）
- 导出 CSV：UTF-8 带 BOM，Excel 直接双击打开不乱码；多选用「；」分隔，「其他」显示为 `其他（填写内容）`
- 导出 Excel：两个工作表——「提交明细」和「选项统计」
- 微信内置浏览器不支持下载文件，导出请在电脑浏览器里操作
- 备份：直接复制 `data/survey.sqlite` 即可

## 部署

代码不依赖任何特定云厂商，任何能跑 Node 22 的 Linux 服务器都可以。以下是轻量应用服务器（腾讯云 / 阿里云）的步骤，镜像选 Ubuntu 22.04/24.04：

```bash
# 1. 安装 Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm i -g pm2 --registry=https://registry.npmmirror.com

# 2. 上传代码（git clone 或 scp 整个 designer-survey 目录，不含 node_modules / data）
cd designer-survey
npm install --omit=dev --registry=https://registry.npmmirror.com
cp .env.example .env && nano .env      # 设置 ADMIN_PASSWORD、SESSION_SECRET

# 3. 启动并设为开机自启
pm2 start npm --name survey -- start
pm2 save && pm2 startup
```

然后在云控制台的防火墙里放行端口（默认 3000），即可用 `http://服务器IP:3000` 访问。

有域名时，建议用 nginx 反向代理到 3000 端口并配置 HTTPS，同时在 `.env` 里设 `TRUST_PROXY=1`：

```nginx
server {
    listen 443 ssl;
    server_name survey.example.com;
    # ssl_certificate / ssl_certificate_key ...
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> 大陆地域的服务器用域名访问 80/443 端口，需要先完成 ICP 备案；香港地域不需要。
> 发给受访者前，请先用自己的微信打开一次链接确认能正常显示。
